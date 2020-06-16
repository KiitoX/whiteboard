'use strict';

window.addEventListener('load', init);

function throttle(timeout, func) {
	let previous = 0;
	let run = function() {
		let now = Date.now();
		if (now - previous >= timeout) {
			func();
			previous = now;
		}
	};
	return run;
}

function debounce(delay, func) {
	let timeout;
	let later = function() {
		timeout = null;
		func();
	};
	let run = function() {
		if (timeout) {
			window.clearTimeout(timeout);
		}
		timeout = window.setTimeout(later, delay);
	};
	return run;
}

// ""proper"" modulo function, sign of divisor is used
function fmod(a, n) {
	return a - n * Math.floor(a / n);
}

let state = {
	websocket: null,
	whoami: null,
	clients: null,
	activeTool: 'pencil',
	toolInUse: null, // "pan" OR "active"
	ongoing: {
		// client_id: {
		//   body: [ongoing drawing data]
		//   size: <number>
		//   colour: '#rrggbb'
		// }
	},
	local: function() {
		return state.ongoing[state.whoami];
	},
	elements: {
		// element_id: [element properties]
	},
	selected: new Set(), // element_ids
	undostack: [
		// i: {operation, data}
		//  > "add": element_id
		//  > "del": [element data]
	],
	redostack: [],
};

function init() {
	let whiteboard = document.querySelector('.whiteboard');
	let canvas = whiteboard.querySelector('canvas');
	context.canvas = canvas;

	// init drawing context
	context.ref = canvas.getContext(context.type);
	context.ref.imageSmoothingEnabled = false;

	// prevent context menu
	canvas.addEventListener('contextmenu', function(evt) {evt.preventDefault()});
	
	//document.addEventListener('blur', console.log);
	//document.addEventListener('focus', console.log);

	// register canvas input handler
	if (window.PointerEvent) {
		// TODO ff mobile compat, break up handlePointer into more logical subassemblies :>
		// https://www.w3.org/TR/pointerevents2/
	}
	canvas.addEventListener('pointerdown', handlePointer, false);
	canvas.addEventListener('pointerup', handlePointer, false);
	canvas.addEventListener('pointerout', handlePointer, false);
	canvas.addEventListener('pointercancel', handlePointer, false);
	canvas.addEventListener('pointermove', handlePointer, false);
	canvas.addEventListener('wheel', handleWheel);

	// add keypress listener
	document.addEventListener('keydown', handleKeyDown);

	// handle resizing
	window.addEventListener('resize', handleResize);
	handleResize(null);

	// register button handlers
	document.querySelector('#undo').addEventListener('click', undo);
	document.querySelector('#redo').addEventListener('click', redo);
	
	document.querySelector('#select').addEventListener('click', changeTool);
	document.querySelector('#pan').addEventListener('click', changeTool);
	document.querySelector('#pencil').addEventListener('click', changeTool);
	document.querySelector('#eraser').addEventListener('click', changeTool);

	document.querySelector('#deselect').addEventListener('click', clearSelection);
	document.querySelector('#move').addEventListener('click', changeTool);
	document.querySelector('#delete').addEventListener('click', deleteSelection);
	
	document.querySelector('#size').addEventListener('click', toggleSizeSelector);
	
	for (let button of document.querySelectorAll('#dialog-size button')) {
		button.addEventListener('click', selectSize);
	}
	
	document.querySelector('#colour').addEventListener('click', toggleColourSelector);
	document.querySelector('#range-red').addEventListener('input', updateColour);
	document.querySelector('#range-green').addEventListener('input', updateColour);
	document.querySelector('#range-blue').addEventListener('input', updateColour);
	document.querySelector('#range-red').addEventListener('wheel', selectSlider);
	document.querySelector('#range-green').addEventListener('wheel', selectSlider);
	document.querySelector('#range-blue').addEventListener('wheel', selectSlider);
	document.querySelector('#manual-colour').addEventListener('change', manualColour);

	setDrawingColour('#148');

	for (let button of document.querySelectorAll('#colour-palette button')) {
		button.addEventListener('click', selectColour);
	}

	document.querySelector('#clear').addEventListener('click', openClearConfirmation);
	document.querySelector('#dialog-clear #confirm-clear').addEventListener('click', clearWhiteboard);
	document.querySelector('#dialog-clear #cancel-clear').addEventListener('click', closeDialog);

	updateState();

	// connect to websocket server
	connectToWebSocket();

	// start recursive draw request
	window.requestAnimationFrame(draw);
}

function handlePointer(evt) {
	evt.preventDefault();
	
	if (evt.type === 'pointermove') {
		if (state.toolInUse === 'active') {
			tools[state.activeTool].onMove(evt);
			context.needRedraw = true;
		} else if (state.toolInUse === 'pan') {
			tools.pan.onMove(evt);
			context.needRedraw = true;
		}
	} else if (evt.type === 'pointerdown') {
		if (evt.button === 0 && document.hasFocus()) {
			// TODO detect somehow if a user has raised this window 
			// by clicking on the canvas, we don't really want that to
			// get translated to a drawn line

			// TODO this in not really doing what I want, it's interesting though
			// I should really consider moving from this kinda obsolete(??) pointer
			// api to the separate mouse/touch/pen events, even if it sucks
			//context.canvas.setPointerCapture(evt.pointerId);
			state.toolInUse = 'active';
			tools[state.activeTool].onDown(evt);
			context.needRedraw = true;
		} else if (evt.button === 2 || evt.button === 1) {
			state.toolInUse = 'pan';
			tools.pan.onDown(evt);
			context.needRedraw = true;
		}
	} else if (evt.type === 'pointerup' || evt.type === 'pointerout' || evt.type === 'pointercancel') {
		if (state.toolInUse === 'active') {
			/*if (evt.type !== 'pointerout') {
				context.canvas.releasePointerCapture(evt.pointerId);
			}*/
			state.toolInUse = null;
			tools[state.activeTool].onUp(evt);
			context.needRedraw = true;
		} else if (state.toolInUse === 'pan') {
			state.toolInUse = null;
			tools.pan.onUp(evt);
			context.needRedraw = true;
		}
	}
}

function handleWheel(evt) {
	// we don't really want to care about the amount of lines scrolled
	// that is fairly setup specific, so we only use the wheel direction
	let direction = Math.sign(evt.deltaY);
	let newScale = context.scale / Math.pow(2, direction);
	newScale = Math.max(0.25, Math.min(newScale, 4.0));

	let oX = evt.currentTarget.width / 2, oY = evt.currentTarget.height / 2;
	let tX = context.offsetX, tY = context.offsetY;
	
	if (state.toolInUse === 'active' || evt.shiftKey) {
		let mX = evt.offsetX, mY = evt.offsetY; // mouse coordinates on canvas
		oX = mX;
		oY = mY;
	}

	// my legendary "scroll-at-mouse-position" code I wrote a few years back
	// which I have been copying around ever since, adapted here to zoom at center
	// Zoom position adjustment: (new pos - prev pos) * scale
	context.offsetX += (((oX - tX) / newScale) - ((oX - tX) / context.scale)) * newScale;
	context.offsetY += (((oY - tY) / newScale) - ((oY - tY) / context.scale)) * newScale;

	context.scale = newScale;
	
	context.needRedraw = true;
}

function handleKeyDown(evt) {
	if (evt.target !== document.querySelector('#manual-colour')) {
		if (evt.ctrlKey) {
			if (evt.key === 'z') {
				undo({currentTarget: document.querySelector('#undo')});
			} else if (evt.key === 'Z') {
				redo({currentTarget: document.querySelector('#redo')});
			}
		}
		if (evt.key === 'd') {
			setTool('pencil');
		} else if (evt.key === 'e') {
			if (state.activeTool === 'eraser') {
				setTool('pencil');
			} else {
				setTool('eraser');
			}
			updateState();
		}
	}
}

function handleResize(evt) {
	let canvas = context.canvas;
	let whiteboard = canvas.parentElement;

	canvas.style.width = whiteboard.clientWidth + 'px';
	canvas.style.height = whiteboard.clientHeight + 'px';

	canvas.width = whiteboard.clientWidth * window.devicePixelRatio;
	canvas.height = whiteboard.clientHeight * window.devicePixelRatio;
	
	context.needRedraw = true;
}

function undo(evt) {
	if (!(evt.currentTarget).hasAttribute('disabled')) {
		let lastAction = state.undostack.pop();
		lastAction.data.undo = true;
		if (lastAction.type === 'added') {
			sendMessage('del', lastAction.data);
		} else if (lastAction.type === 'deleted') {
			sendMessage('add', lastAction.data);
		}
		updateState();
	}
}

function redo(evt) {
	if (!evt.currentTarget.hasAttribute('disabled')) {
		let lastUndo = state.redostack.pop();
		if (lastUndo.type === 'added') {
			sendMessage('del', lastUndo.data);
		} else if (lastUndo.type === 'deleted') {
			sendMessage('add', lastUndo.data);
		}
		updateState();
	}
}

function updateState() {
	document.querySelector('#undo').toggleAttribute('disabled', state.undostack.length === 0);
	document.querySelector('#redo').toggleAttribute('disabled', state.redostack.length === 0);
}

function setTool(name) {
	state.activeTool = name;
	document.querySelector('[active]').removeAttribute('active');
	document.querySelector('#' + name).setAttribute('active', '');
	toggleSelectionToolbar();
}

function changeTool(evt) {
	let activeTool = document.querySelector('[active]');
	activeTool.removeAttribute('active');
	evt.currentTarget.setAttribute('active', '');
	state.activeTool = evt.currentTarget.id;

	document.querySelector('#dialog-clear').removeAttribute('open');
	document.querySelector('#dialog-size').removeAttribute('open');
	document.querySelector('#dialog-colour').removeAttribute('open');
	toggleSelectionToolbar();
}

function toggleSelectionToolbar() {
	document.querySelector('#dialog-select').toggleAttribute('open',
		(state.activeTool === 'select' || state.activeTool === 'move')
		&& state.selected.size > 0);
}

function clearSelection() {
	state.selected.clear();
	toggleSelectionToolbar();
	context.needRedraw = true;
}

function deleteSelection() {
	// TODO joint undo would be /really/ nice here
	for (let id of state.selected) {
		sendMessage('del', {id: id, undo: false});
		state.selected.delete(id);
	}
	state.redostack.length = 0;
	updateState();
	context.needRedraw = true;
}

function toggleSizeSelector(evt) {
	setTool('pencil');
	let open = document.querySelector('#dialog-size').toggleAttribute('open');
	if (open) {
		document.querySelector('#dialog-colour').removeAttribute('open');
	}
}

function selectSize(evt) {
	let size = evt.currentTarget.style.getPropertyValue('--size');
	document.documentElement.style.setProperty('--drawing-size', size);
	tools.drawingSize = Number(size.slice(0, -2));
}

function selectSlider(evt) {
	if (evt.currentTarget !== document.activeElement) {
		evt.currentTarget.focus();
	}
}

function toggleColourSelector(evt) {
	setTool('pencil');
	let open = document.querySelector('#dialog-colour').toggleAttribute('open');
	if (open) {
		document.querySelector('#dialog-size').removeAttribute('open');
	}
}

function setDrawingColour(colour) {
	document.documentElement.style.setProperty('--drawing-colour', colour);

	let style = getComputedStyle(document.querySelector('#colour-preview'));
	let bg = style.getPropertyValue('background-color');
	let rgb = bg.match(/\d+/g).slice(0,3);

	let r = Number(rgb[0]);
	let g = Number(rgb[1]);
	let b = Number(rgb[2]);
	
	let r0 = ('\xa0\xa0' + r).slice(-3);
	let g0 = ('\xa0\xa0' + g).slice(-3);
	let b0 = ('\xa0\xa0' + b).slice(-3);

	let rX = ('0' + r.toString(16)).slice(-2);
	let gX = ('0' + g.toString(16)).slice(-2);
	let bX = ('0' + b.toString(16)).slice(-2);
	let hex = `#${rX}${gX}${bX}`;

	document.querySelector('#range-red').value = r;
	document.querySelector('#value-red').textContent = r0;
	document.querySelector('#range-green').value = g;
	document.querySelector('#value-green').textContent = g0;
	document.querySelector('#range-blue').value = b;
	document.querySelector('#value-blue').textContent = b0;

	tools.drawingColour = hex;
	document.documentElement.style.setProperty('--drawing-colour', hex);
	document.querySelector('#manual-colour').value = hex

	// luminance for w3c recommended contrast based on linear colourspace
	// https://stackoverflow.com/a/3943023/4704639
	let rL = (r / 255.0) <= 0.03928 ? (r / 255) / 12.92 : Math.pow((r / 255 + 0.055) / 1.055, 2.4);
	let gL = (g / 255.0) <= 0.03928 ? (g / 255) / 12.92 : Math.pow((g / 255 + 0.055) / 1.055, 2.4);
	let bL = (b / 255.0) <= 0.03928 ? (b / 255) / 12.92 : Math.pow((b / 255 + 0.055) / 1.055, 2.4);
	let luma = 0.2126 * rL + 0.7152 * gL + 0.0722 * bL;
	document.querySelector('#colour').toggleAttribute('bright', luma > 0.179);
}

function manualColour(evt) {
	let colour = evt.currentTarget.value;
	setDrawingColour(colour);
}

function selectColour(evt) {
	let colour = evt.currentTarget.style.getPropertyValue('--colour');
	setDrawingColour(colour);
}

function updateColour(evt) {
	let rangeR = document.querySelector('#range-red');
	let rangeG = document.querySelector('#range-green');
	let rangeB = document.querySelector('#range-blue');

	let r = Number(rangeR.value);
	let g = Number(rangeG.value);
	let b = Number(rangeB.value);
	let rgb = `rgb(${r} ${g} ${b})`;

	setDrawingColour(rgb);
}

function openClearConfirmation(evt) {
	document.querySelector('#dialog-clear').setAttribute('open', '');
	document.querySelector('#dialog-size').removeAttribute('open');
	document.querySelector('#dialog-colour').removeAttribute('open');
}
function clearWhiteboard(evt) {
	sendMessage('clear', '');
	closeDialog(evt);
}

function closeDialog(evt) {
	let dialog = evt.currentTarget.closest('dialog');
	dialog.removeAttribute('open');
}

function connectToWebSocket() {
	state.websocket = new WebSocket('wss://' + window.location.hostname
		+ window.location.pathname.replace('board/', 'board/wss/'));
	state.websocket.addEventListener('open', handleSocketOpen);
	state.websocket.addEventListener('message', receiveMessage);
	state.websocket.addEventListener('error', handleSocketError);
	state.websocket.addEventListener('close', handleSocketError);
}

function handleSocketOpen(evt) {
	document.querySelector('.status').setAttribute('state', 'connected');
}

function handleSocketError(evt) {
	document.querySelector('.status').setAttribute('state', 'disconnected');
}

function sendMessage(type, data) {
	document.querySelector('.status').setAttribute('state', 'loading');
	let body = JSON.stringify({type: type, data: data});
	state.websocket.send(body);
}

let acknowledgeReturn = debounce(100, function() {
	document.querySelector('.status').setAttribute('state', 'connected');
});

function receiveMessage(evt) {
	acknowledgeReturn();
	let message = JSON.parse(evt.data);
	if (message.type === 'identify') {
		state.whoami = message.data;
	} else if (message.type === 'all_clients') {
		state.clients = new Set(message.data);
		for (let client of state.clients) {
			state.ongoing[client] = {
				body: [],
				size: 3,
				colour: '#148',
			};
		}
	} else if (message.type === 'client_joined') {
		state.clients.add(message.data);
		state.ongoing[message.data] = {
			body: [],
			size: 3,
			colour: '#148',
		};
	} else if (message.type === 'client_left') {
		state.clients.delete(message.data);
		delete state.ongoing[message.data];
	} else if (message.type === 'all_elements') {
		// TODO for now only expected to get this ONCE on load
		// this expectation has to change if we want to handle
		// graceful disconnects... they are probably not worth it
		// you only lose your undo/redo on reload, so yeah...
		// 
		// if we do want to implement this, we need to consider
		// that we've missed following events:
		// 	 element additions (sort of easy,
		// 	 	just get elements of higher ids than our last),
		// 	 peer changes (easy, we might've missed some
		// 	 	active drawing but on insertion we will get it in full),
		// 	 element deletions (difficult,
		// 	 	since we need to validate our undo history)
		// 	 board clears (easy if deletion is handled gracefully)
		/*
		state.elements = message.data;
		for (const [id, element] of Object.entries(message.data)) {
			element.body = JSON.parse(element.body);
			state.elements[id] = element;
		}
		*/
		message.data.forEach(function(element) {
			// [id, type, "content", bounds...]
			state.elements[element[0]] = JSON.parse(element[2]);
		});
		context.needRedraw = true;
	} else if (message.type === 'added') {
		state.elements[message.data.id] = message.data.properties;
		if (message.origin === state.whoami) {
			let action = {type: 'added', data: {id: message.data.id}};
			if (message.data.properties.undo) {
				state.redostack.push(action);
			} else {
				state.undostack.push(action);
			}
			updateState();
		} else {
			state.ongoing[message.origin].body.length = 0;
		}
		context.needRedraw = true;
	} else if (message.type === 'deleted') {
		if (message.origin === state.whoami) {
			let action = {type: 'deleted', data: state.elements[message.data.id]};
			if (message.data.undo) {
				state.redostack.push(action);
			} else {
				state.undostack.push(action);
			}
			updateState();
		} else {
			let operationIndex = -1;
			state.undostack.find(function(op, i) {
				if (op.type === 'added' && Number(op.data.id) === message.data.id) {
					operationIndex = i;
					return true;
				}
			});
			if (operationIndex >= 0) {
				// someone has deleted an element we've created,
				// remove it from our undo stack
				state.undostack.splice(operationIndex, 1);
				updateState();
			}
		}
		state.selected.delete(message.data.id);
		toggleSelectionToolbar();
		delete state.elements[message.data.id];
		context.needRedraw = true;
	} else if (message.type === 'cleared') {
		state.elements = {};
		state.undostack = [];
		state.redostack = [];
		updateState();
		context.needRedraw = true;
	} else if (message.type === 'ongoing') {
		if (message.origin !== state.whoami) {
			state.ongoing[message.origin].size = Number(message.data.size);
			state.ongoing[message.origin].colour = message.data.colour;
			Array.prototype.push.apply(
				state.ongoing[message.origin].body, message.data.body);
		}
		context.needRedraw = true;
	} else if (message.type === 'matches') {
		if (message.data.type === 'eraser') {
			tools.eraser.findIntersections(message.data.line, message.data.ids);
			context.needRedraw = true;
		} else if (message.data.type === 'select') {
			for (let i = 0; i < message.data.ids.length; i++) {
				state.selected.add(message.data.ids[i]);
			}
			toggleSelectionToolbar();
			context.needRedraw = true;
		}
	} else {
		console.log('unsupported message', message);
	}
}

let tools = {
	drawingColour: '#148',
	drawingSize: 3,
	pencil: {
		previousLength: 0,
		shareOngoing: throttle(20/* ms */, function() {
			let data = {
				body: state.local().body.slice(tools.pencil.previousLength),
				size: state.local().size,
				colour: state.local().colour,
			};
			sendMessage('drawing', data);
			tools.pencil.previousLength = state.local().body.length;
		}),
		onDown: function(evt) {
			// TODO differentiate type
			state.local().type = 'smooth';
			state.local().size = tools.drawingSize;
			state.local().colour = tools.drawingColour;
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
		},
		onMove: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			tools.pencil.shareOngoing();
		},
		onUp: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			sendMessage('add', {
				undo: false,
				body: state.local().body,
				type: state.local().type,
				size: state.local().size,
				colour: state.local().colour
			});
			state.local().body.length = 0;
			tools.pencil.previousLength = 0;
			state.redostack.length = 0;
			updateState();
		},
	},
	eraser: {
        // for proper eraser performance, this needs to be at least half
        // of the maximum element diameter, otherwise points will not be gotten properly
		padding: 12,
		findMatches: throttle(20/* ms */, function() {
			sendMessage('query', {
				body: state.local().body,
				padding: tools.eraser.padding,
				type: 'eraser',
				contain: false,
			});
			// only keep last point
			state.local().body = state.local().body.slice(-2);
		}),
		findIntersections: function(eraser, matchingIds) {
			let intersects = [];
			for (let id of matchingIds) {
				let element = state.elements[id];
				for (let i = 0; i < eraser.length - 2; i += 2) {
					let segment = eraser.slice(i, i + 4);
					if (separatingAxesIntersection(segment, element)) {
						intersects.push(id);
						break;
					}
				}
			}
			for (let id of intersects) {
				// TODO low priority, here or elsewhere:
				// one undo/redo element for multiple elements
				// consequently maybe also multple add/del in one message
				sendMessage('del', {id: id, undo: false});
				state.redostack.length = 0;
				updateState();
			}
		},
		onDown: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
		},
		onMove: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			tools.eraser.findMatches();
		},
		onUp: function(evt) {
			const ERASE_THRESHOLD = 2;
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			sendMessage('query', {
				body: state.local().body,
				padding: tools.eraser.padding,
				type: 'eraser',
				contain: false,
			});
			state.local().body.length = 0;
		},
	},
	select: {
		onDown: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
		},
		onMove: function(evt) {
			state.local().body.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
		},
		onUp: function(evt) {
			state.local().body.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			sendMessage('query', {
				body: state.local().body,
				padding: 0,
				type: 'select',
				contain: true,
			});
			state.local().body.length = 0;
		},
	},
	move: {
		onDown: function(evt) {
			
		},
		onMove: function(evt) {
		},
		onUp: function(evt) {
		},
	},
	pan: {
		curX: 0, curY: 0,
		prevX: 0, prevY: 0,
		onDown: function(evt) {
			tools.pan.curX = evt.offsetX;
			tools.pan.curY = evt.offsetY;
		},
		onMove: function(evt) {
			tools.pan.prevX = tools.pan.curX;
			tools.pan.prevY = tools.pan.curY;
			tools.pan.curX = evt.offsetX;
			tools.pan.curY = evt.offsetY;
			context.offsetX += (tools.pan.curX - tools.pan.prevX) * window.devicePixelRatio;
			context.offsetY += (tools.pan.curY - tools.pan.prevY) * window.devicePixelRatio;
		},
		onUp: function(evt) {
			tools.pan.prevX = tools.pan.curX;
			tools.pan.prevY = tools.pan.curY;
			tools.pan.curX = evt.offsetX;
			tools.pan.curY = evt.offsetY;
			context.offsetX += (evt.offsetX - tools.pan.prevX) * window.devicePixelRatio;
			context.offsetY += (evt.offsetY - tools.pan.prevY) * window.devicePixelRatio;
		},
	},
};

// separating axes collision detection
// http://www.dyn4j.org/2010/01/sat/
function getNormal(line) {
	let [ax, ay, bx, by] = line;
	let dx = bx - ax;
	let dy = by - ay;
	return [-dy, dx];
}

function normalize(vector, factor) {
	let [x, y] = vector;
	let len = Math.sqrt(x * x + y * y);
	return [(x * factor) / len, (y * factor) / len];
}

function project(shape, axis) {
	let [ax, ay] = axis;

	let min = Infinity, max = -Infinity;

	for(let i = 0; i < shape.length; i += 2) {	
		let [sx, sy] = shape.slice(i);
		let dotP = sx * ax + sy * ay;
		if (dotP < min) {
			min = dotP;
		}
		if (dotP > max) {
			max = dotP;
		}
	}

	return [min, max];
}

let convertToPoly = {
	point: function(point, radius) {
		let [x, y] = point;

		let axes = [[1, 0], [0, 1]];
		let verts = [
			x - radius, y + radius, x + radius, y + radius,
			x - radius, y - radius, x + radius, y - radius];

		return [axes, verts];
	},
	line: function(line, radius) {
		let [ax, ay, bx, by] = line;
		let dx = bx - ax;
		let dy = by - ay;

		let [nx, ny] = getNormal(line);
		let [ox, oy] = normalize([nx, ny], radius); // width offset

		let axes = [[nx, ny], [dx, dy]];
		let verts = [
			ax + ox, ay + oy, bx + ox, by + oy,
			ax - ox, ay - oy, bx - ox, by - oy];

		return [axes, verts];
	},
};

function testSeparatedAxes(elementA, elementB, axes) {
	// assume overlap until proven wrong
	for (let axis of axes) {
		let [aMin, aMax] = project(elementA, axis);
		let [bMin, bMax] = project(elementB, axis);
		if (aMax < bMin || bMax < aMin) {
			// found axis with no overlap
			// therefore elements do not intersect
			return false;
		}
	}
	// all axes show overlap,
	// therefore the elements intersect
	return true;
}

function separatingAxesIntersection(eraser, element) {
	let points = element.body;
	let radius = element.size / 2;

	const ERASER_RADIUS = 1;
	let eraserAxes, eraserVerts;

	if (eraser[0] === eraser[2] && eraser[1] === eraser[3]) {
		// eraser forms a point
		[eraserAxes, eraserVerts] = convertToPoly.point(eraser, ERASER_RADIUS);
	} else {
		[eraserAxes, eraserVerts] = convertToPoly.line(eraser, ERASER_RADIUS);
	}

	let elementAxes, elementVerts;
	
	if (points.length === 4 && points[0] === points[2] && points[1] === points[3]) {
		// element forms a point
		[elementAxes, elementVerts] = convertToPoly.point(points, radius);
		return testSeparatedAxes(eraserVerts, elementVerts, eraserAxes.concat(elementAxes));
	} else {
		for (let i = 0; i < points.length - 2; i += 2) {
			// TODO handle different types of elements
			[elementAxes, elementVerts] = convertToPoly.line(points.slice(i), radius);
			if (testSeparatedAxes(eraserVerts, elementVerts, eraserAxes.concat(elementAxes))) {
				// found intersection with one segment, enough for result
				return true;
			}
		}
		// none of the segments intersect
		return false;
	}
}

let context = {
	canvas: null,
	ref: null,
	type: '2d',
	offsetX: 0,
	offsetY: 0,
	scale: 1,
	abs: function(x, y) {
		return [
			(window.devicePixelRatio * x - context.offsetX) / context.scale,
			(window.devicePixelRatio * y - context.offsetY) / context.scale
		];
	},
	needRedraw: true,
};

// the way this is written lines are expected to have at least two points (start and end)
let drawObject = {
	line: function(ctx, points) {
		if (points.length < 4) return;
		ctx.beginPath();

		ctx.moveTo(points[0], points[1]);
		for (let i = 0; i < points.length; i += 2) {
			ctx.lineTo(points[i], points[i + 1]);
		}

		ctx.stroke();
	},
	smooth: function(ctx, points) {
		if (points.length < 4) return;

		if (!(ctx instanceof Path2D)) {
			ctx.beginPath();
		}

		ctx.moveTo(points[0], points[1]);

		let i;
		for (i = 0; i < points.length - 2; i += 2) {
			let xc = (points[i] + points[i + 2]) / 2;
			let yc = (points[i + 1] + points[i + 3]) / 2;
			ctx.quadraticCurveTo(points[i], points[i + 1], xc, yc);
		}

		ctx.quadraticCurveTo(points[i], points[i + 1], points[i + 2], points[i + 3]);

		if (!(ctx instanceof Path2D)) {
			ctx.stroke();
		}
	},
	rect: function(ctx, points) {
		let [ax, ay, bx, by] = points;
		ctx.beginPath();
		ctx.moveTo(ax, ay);
		ctx.lineTo(ax, by);
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(ax, by);
		ctx.lineTo(bx, by);
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(bx, ay);
		ctx.lineTo(bx, by);
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(ax, ay);
		ctx.lineTo(bx, ay);
		ctx.stroke();
	},
	dots: function(ctx, points) {
		for (let i = 0; i < points.length; i+= 2) {
			ctx.fillRect(points[i]-1, points[i + 1]-1, 3, 3);
		}
	},
};

function draw() {
	if (!context.needRedraw) {
		// check again next frame
		window.requestAnimationFrame(draw);
		return;
	}
	context.needRedraw = false;

	let ctx = context.ref;
	let w = context.canvas.width;
	let h = context.canvas.height;

	ctx.resetTransform();

	// clear canvas
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, w, h);

	// translate position
	ctx.translate(context.offsetX, context.offsetY);

	// draw grid
	ctx.strokeStyle = '#ccc';

	let gridSize = 20 * context.scale;
	let gridLineWidth = 1 * context.scale;
	let divisionLineWidth = 2 * context.scale;
	let gridDivisionSize = 3;

	// vertical lines
	ctx.lineWidth = gridLineWidth;
	for (let i = 0, x = fmod(context.offsetX, gridSize); x < w; i++, x += gridSize) {
		ctx.beginPath();
		ctx.moveTo(x - context.offsetX, 0 - context.offsetY);
		ctx.lineTo(x - context.offsetX, h - context.offsetY);
		ctx.stroke();
	}

	// horizontal lines
	let gridDivision = fmod(Math.floor(context.offsetY / gridSize), gridDivisionSize);
	for (let j = 0, y = fmod(context.offsetY, gridSize); y < h; j++, y += gridSize) {
		if (j % gridDivisionSize === gridDivision) {
			ctx.lineWidth = divisionLineWidth;
		} else {
			ctx.lineWidth = gridLineWidth;
		}
		ctx.beginPath();
		ctx.moveTo(0 - context.offsetX, y - context.offsetY);
		ctx.lineTo(w - context.offsetX, y - context.offsetY);
		ctx.stroke();
	}

	// scale content
	ctx.scale(context.scale, context.scale);

	// draw content
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	
	for (const [id, element] of Object.entries(state.elements)) {
		let viewport_padding = element.size + 2; // px, scaled
		let viewport_lower_x = (0 - context.offsetX - viewport_padding) / context.scale;
		let viewport_upper_x = (w - context.offsetX + viewport_padding) / context.scale;
		let viewport_lower_y = (0 - context.offsetY - viewport_padding) / context.scale;
		let viewport_upper_y = (h - context.offsetY + viewport_padding) / context.scale;
		let {lower_x, lower_y, upper_x, upper_y} = element.bounds;
		let inBounds = lower_x <= viewport_upper_x && upper_x >= viewport_lower_x
					&& lower_y <= viewport_upper_y && upper_y >= viewport_lower_y;
		if (inBounds) {
			// only draw elements potentially contained in viewport
			ctx.lineWidth = element.size;
			ctx.strokeStyle = element.colour;
			ctx.fillStyle = element.colour;
			drawObject[element.type](ctx, element.body);
		}
	}

	for (const [client, element] of Object.entries(state.ongoing)) {
		if (Number(client) === state.whoami) {
			if (state.activeTool === 'eraser') {
				continue; // skip drawing own line if we're using ongoing for erasing purposes
			}
			if (state.activeTool === 'select' && element.body.length > 2) {
				ctx.lineWidth = 2;
				ctx.strokeStyle = '#000';
				ctx.setLineDash([5, 5]);
				drawObject.rect(ctx, element.body);
				ctx.setLineDash([]);
				continue; // special drawing procedure
			}
		}
		if (element.body.length >= 2) {
			ctx.lineWidth = element.size;
			ctx.strokeStyle = element.colour;
			ctx.fillStyle = element.colour;
			// TODO ongoing type
			drawObject.smooth(ctx, element.body);
		}
	}

	ctx.lineWidth = 1;
	ctx.strokeStyle = '#000';
	ctx.setLineDash([5, 5]);
	for (const id of state.selected) {
		let {lower_x, lower_y, upper_x, upper_y} = state.elements[id].bounds;
		drawObject.rect(ctx, [lower_x, lower_y, upper_x, upper_y]);
	}
	ctx.setLineDash([]);

	// redraw on next frame
	window.requestAnimationFrame(draw);
}
