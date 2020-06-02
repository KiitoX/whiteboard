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
	toolInUse: null, // "move" OR "active"
	ongoing: {
		// client_id: {
		//   body: [ongoing drawing data]
		//   colour: '#rrggbb'
		// }
	},
	local: function() {
		return state.ongoing[state.whoami];
	},
	elements: {
		// element_id: [element properties]
	},
	undostack: [
		// i: {operation, data}
		//  > "add": element_id
		//  > "del": [element data]
	],
	redostack: [],
};


let tools = {
	drawingColour: '#148',
	pencil: {
		previousLength: 0,
		shareOngoing: throttle(20/* ms */, function() {
			let data = {
				body: state.local().body.slice(tools.pencil.previousLength),
				colour: state.local().colour,
			};
			sendMessage('drawing', data);
			tools.pencil.previousLength = state.local().body.length;
		}),
		onDown: function(evt) {
			// TODO differentiate type
			//state.local().type = 'smooth';
			state.local().colour = tools.drawingColour;
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
		},
		onMove: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			tools.pencil.shareOngoing();
		},
		onUp: function(evt) {
			state.local().body.push(...context.abs(evt.offsetX, evt.offsetY));
			//TODO again, type
			add(state.local().body);
			state.local().body.length = 0;
			tools.pencil.previousLength = 0;
		},
	},
	eraser: {
		findMatches: throttle(20/* ms */, function() {
			sendMessage('query', state.local().body);
			// only keep last point
			state.local().body = state.local().body.slice(-2);
		}),
		findIntersections: function(eraser, matchingIds) {
			let intersects = [];
			for (let id of matchingIds) {
				let element = state.elements[id];
				for (let i = 0; i < eraser.length - 2; i += 2) {
					let segment = eraser.slice(i, i + 4);
					if (getIntersection.any(segment, element)) {
						intersects.push(id);
						break;
					}
				}
			}
			for (let id of intersects) {
				// TODO here or elsewhere:
				// one undo/redo element for multiple elements
				del(id);
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
			sendMessage('query', state.local().body);
			state.local().body.length = 0;
		},
	},
	move: {
		curX: 0, curY: 0,
		prevX: 0, prevY: 0,
		onDown: function(evt) {
			tools.move.curX = evt.offsetX;
			tools.move.curY = evt.offsetY;
		},
		onMove: function(evt) {
			tools.move.prevX = tools.move.curX;
			tools.move.prevY = tools.move.curY;
			tools.move.curX = evt.offsetX;
			tools.move.curY = evt.offsetY;
			context.offsetX += tools.move.curX - tools.move.prevX;
			context.offsetY += tools.move.curY - tools.move.prevY;
		},
		onUp: function(evt) {
			tools.move.prevX = tools.move.curX;
			tools.move.prevY = tools.move.curY;
			tools.move.curX = evt.offsetX;
			tools.move.curY = evt.offsetY;
			context.offsetX += evt.offsetX - tools.move.prevX;
			context.offsetY += evt.offsetY - tools.move.prevY;
		},
	},
};


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
				colour: '#148',
			};
		}
		// TODO clear/prune ongoing??
	} else if (message.type === 'client_joined') {
		state.clients.add(message.data);
		state.ongoing[message.data] = {
			body: [],
			colour: '#148',
		};
	} else if (message.type === 'client_left') {
		state.clients.delete(message.data);
		delete state.ongoing[message.data];
	} else if (message.type === 'all_elements') {
		// TODO for now only expected to get this ONCE on load
		// this expectation has to change once we handle graceful disconnects
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
			// TODO someone may have deleted something that is in our undo queue
			// try to find it, and remove it, we should consider just storing the origin
			// of an element, to make this less guesswork
		}
		delete state.elements[message.data.id];
		context.needRedraw = true;
	} else if (message.type === 'cleared') {
		// TODO clear ongoing ???
		state.elements = {};
		state.undostack = [];
		state.redostack = [];
		updateState();
		context.needRedraw = true;
	} else if (message.type === 'ongoing') {
		if (message.origin !== state.whoami) {
			state.ongoing[message.origin].colour = message.data.colour;
			Array.prototype.push.apply(
				state.ongoing[message.origin].body, message.data.body);
		}
		context.needRedraw = true;
	} else if (message.type === 'matches') {
		tools.eraser.findIntersections(message.data.line, message.data.ids);
		context.needRedraw = true;
	} else {
		console.log("unsupported message", message);
	}
}

function sendMessage(type, data) {
	document.querySelector('.status').setAttribute('state', 'loading');
	let body = JSON.stringify({type: type, data: data});
	state.websocket.send(body);
}

let context = {
	canvas: null,
	ref: null,
	type: '2d',
	offsetX: 0,
	offsetY: 0,
	scale: 1,
	abs: function(x, y) {
		return [(x - context.offsetX) / context.scale, (y - context.offsetY) / context.scale];
	},
	needRedraw: true,
};

function init() {
	let whiteboard = document.querySelector('.whiteboard');
	let canvas = whiteboard.querySelector('canvas');

	// init drawing context
	context.ref = canvas.getContext(context.type);
	context.canvas = canvas;

	// prevent context menu
	canvas.addEventListener('contextmenu', function(evt) {evt.preventDefault()});
	
	// register canvas input handler
	canvas.addEventListener('pointerdown', handlePointer);
	canvas.addEventListener('pointerup', handlePointer);
	canvas.addEventListener('pointerout', handlePointer);
	canvas.addEventListener('pointermove', handlePointer);
	canvas.addEventListener('wheel', handleWheel);

	// add keypress listener
	document.addEventListener('keydown', handleKeyDown);

	// register button handlers
	document.querySelector('#undo').addEventListener('click', undo);
	document.querySelector('#redo').addEventListener('click', redo);
	
	document.querySelector('#pencil').addEventListener('click', changeTool);
	document.querySelector('#eraser').addEventListener('click', changeTool);
	document.querySelector('#move').addEventListener('click', changeTool);
	
	document.querySelector('#colour').addEventListener('click', toggleColourSelector);
	document.querySelector('#range-red').addEventListener('input', updateColour);
	document.querySelector('#range-green').addEventListener('input', updateColour);
	document.querySelector('#range-blue').addEventListener('input', updateColour);
	document.querySelector('#manual-colour').addEventListener('change', manualColour);

	setDrawingColour('#148');

	for (let button of document.querySelectorAll('#colour-palette .button')) {
		button.addEventListener('click', selectColour);
	}

	document.querySelector('#clear').addEventListener('click', openClearConfirmation);
	document.querySelector('#dialog-clear #confirm-clear').addEventListener('click', clearWhiteboard);
	document.querySelector('#dialog-clear #cancel-clear').addEventListener('click', closeDialog);

	updateState();

	// handle resizing
	window.addEventListener('resize', handleResize);
	handleResize(null);

	// connect to websocket server
	connectToWebSocket();

	// start recursive draw request
	window.requestAnimationFrame(draw);
}

function updateState() {
	document.querySelector('#undo').toggleAttribute('disabled', state.undostack.length === 0);
	document.querySelector('#redo').toggleAttribute('disabled', state.redostack.length === 0);
}


function undo(evt) {
	if (!(evt.currentTarget).hasAttribute('disabled')) {
		// TODO there is potential for desync, when another client erases somethin in here
		// we probably want to try to remove these entries from our stack on global delete
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

function add(element) {
	sendMessage('add', {type: 'smooth', undo: false, body: element, colour: state.local().colour});
	state.redostack.length = 0;
	updateState();
}

function del(element_id) {
	// TODO big task: getting that id
	sendMessage('del', {id: element_id, undo: false});
	state.redostack.length = 0;
	updateState();
}

function openClearConfirmation(evt) {
	document.querySelector('#dialog-clear').setAttribute('open', '');
}
function clearWhiteboard(evt) {
	sendMessage('clear', '');
	closeDialog(evt);
}

function closeDialog(evt) {
	let dialog = evt.currentTarget.closest('dialog');
	dialog.removeAttribute('open');
}

function toggleColourSelector(evt) {
	document.querySelector('#dialog-colour').toggleAttribute('open');
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

function changeTool(evt) {
	let activeTool = document.querySelector('[active]');
	activeTool.removeAttribute('active');
	evt.currentTarget.setAttribute('active', '');
	state.activeTool = evt.currentTarget.id;
}

function handlePointer(evt) {
	evt.preventDefault();
	
	if (evt.type === 'pointermove') {
		if (state.toolInUse === 'active') {
			tools[state.activeTool].onMove(evt);
			context.needRedraw = true;
		} else if (state.toolInUse === 'move') {
			tools.move.onMove(evt);
			context.needRedraw = true;
		}
	} else if (evt.type === 'pointerdown') {
		if (evt.button === 0) {
			state.toolInUse = 'active';
			tools[state.activeTool].onDown(evt);
			context.needRedraw = true;
		} else if (evt.button === 2) {
			state.toolInUse = 'move';
			tools.move.onDown(evt);
			context.needRedraw = true;
		}
	} else if (evt.type === 'pointerup' || evt.type === 'pointerout') {
		if (state.toolInUse === 'active') {
			state.toolInUse = null;
			tools[state.activeTool].onUp(evt);
			context.needRedraw = true;
		} else if (state.toolInUse === 'move') {
			state.toolInUse = null;
			tools.move.onUp(evt);
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
	}
}

function handleResize(evt) {
	let canvas = context.canvas;
	let whiteboard = canvas.parentElement;

	canvas.width = whiteboard.clientWidth;
	canvas.height = whiteboard.clientHeight;
	
	context.needRedraw = true;
}


// intersection of object with (eraser) line
let getIntersection = {
	any: function(eraser, element) {
		let points = element.body;

		// element forms a point
		if (points.length === 4 && points[0] === points[2] && points[1] === points[3]) {
			return getIntersection.point(eraser, points);
		}

		// eraser forms a point
		if (eraser[0] === eraser[2] && eraser[1] === eraser[3]) {
			for (let i = 0; i < points.length - 2; i += 2) {
				if (getIntersection.point(points.slice(i, i + 4), eraser)) {
					return true;
				}
			}
			return false;
		}

		// TODO handle different types
		// otherwise it must be some sort of line collision
		return getIntersection.line(eraser, points);
	},
	point: function(line, point) {
		const POINT_THRESHOLD = 2; // threshold on squared distance, in pixels at scale = 1
		const ptDist = function(ax, ay, bx, by) {
			return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
		};
		let p0x = point[0], p0y = point[1];

		let l0x = line[0], l0y = line[1];
		let l1x = line[2], l1y = line[3];
		
		let len = ptDist(l0x, l0y, l1x, l1y); //(l0x - l1x) * (l0x - l1x) + (l0y - l1y) * (l0y - l1y);
	
		if (len < 1e-7) { // ~ equals to zero -> "line" is actually a point
			let dist = ptDist(p0x, p0y, l0x, l0y); //(p0x - l0x) * (p0x - l0x) + (p0y - l0y) * (p0y - l0y);
			return dist <= POINT_THRESHOLD;
		} else {
			let t = ((p0x - l0x) * (l1x - l0x) + (p0y - l0y) * (l1y - l0y)) / len;
			t = Math.max(0, Math.min(1, t));
			let dist = ptDist(p0x, p0y, l0x + t * (l1x - l0x), l0y + t * (l1y - l0y));
			return dist <= POINT_THRESHOLD;
		}
	},
	line: function(line, points) {
		const LINE_THRESHOLD = 4; // threshold on normlised offset on line segment (meaning not quite clear)
		let l0x = line[0], l0y = line[1];
		let l1x = line[2], l1y = line[3];

		for (let i = 0; i < points.length - 2; i += 2) {
			let s0x = points[i], s0y = points[i + 1];
			let s1x = points[i + 2], s1y = points[i + 3];

			let det = (s1y - s0y) * (l1x - l0x) - (s1x - s0x) * (l1y - l0y);
			if (Math.abs(det) > 1e-7) { // ~ not equals to zero
				let lu = ((s1x - s0x) * (l0y - s0y) - (s1y - s0y) * (l0x - s0x)) / det;
				let su = ((l1x - l0x) * (l0y - s0y) - (l1y - l0y) * (l0x - s0x)) / det;
				let min = 0 - LINE_THRESHOLD / det;
				let max = 1 + LINE_THRESHOLD / det;
				if (min <= lu && lu <= max
					&& min <= su && su <= max) {
					return true;
				}
			}
		}
		return false;
	},
}


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

	let gridSize = 30 * context.scale;
	let gridLineWidth = 1 * context.scale;
	let divisionLineWidth = 2 * context.scale;
	let gridDivisionSize = 2;

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
	ctx.lineWidth = 3;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	
	for (const [id, element] of Object.entries(state.elements)) {
		ctx.strokeStyle = element.colour;
		ctx.fillStyle = element.colour;
		drawObject[element.type](ctx, element.body);
	}

	for (const [client, element] of Object.entries(state.ongoing)) {
		if (Number(client) === state.whoami) {
			if (state.activeTool === 'eraser') {
				continue; // skip drawing own line if we're using ongoing for erasing purposes
			}
		}
		if (element.body.length >= 2) {
			ctx.strokeStyle = element.colour;
			ctx.fillStyle = element.colour;
			drawObject.smooth(ctx, element.body);
		}
	}

	// redraw on next frame
	window.requestAnimationFrame(draw);
}
