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
		// client_id: [ongoing drawing data]
	},
	local: function() {
		return state.ongoing[state.whoami];
	},
	eraseBox: {
		lower_x: 0,
		upper_x: 0,
		lower_y: 0,
		upper_y: 0,
	},
	eraseLine: [],
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
	pencil: {
		previousLength: 0,
		shareOngoing: throttle(20/* ms */, function() {
			sendMessage("drawing", state.local().slice(tools.pencil.previousLength));
			tools.pencil.previousLength = state.local().length;
		}),
		onDown: function(evt) {
			// TODO differentiate type
			//state.local().push('smooth');
			state.local().push(
				evt.offsetX - context.offsetX, evt.offsetY - context.offsetY);
		},
		onMove: function(evt) {
			state.local().push(
				evt.offsetX - context.offsetX, evt.offsetY - context.offsetY);
			tools.pencil.shareOngoing();
		},
		onUp: function(evt) {
			state.local().push(
				evt.offsetX - context.offsetX, evt.offsetY - context.offsetY);
			add(state.local());
			state.local().length = 0;
			tools.pencil.previousLength = 0;
		},
	},
	eraser: {
		findMatches: throttle(20/* ms */, function() {
			let lastPt = state.local().slice(-2);
			sendMessage("query", state.local());
			state.local().length = 0;
			state.local().push(...lastPt);
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
			let ptX = evt.offsetX - context.offsetX;
			let ptY = evt.offsetY - context.offsetY;
			state.local().push(ptX, ptY);
		},
		onMove: function(evt) {
			let ptX = evt.offsetX - context.offsetX;
			let ptY = evt.offsetY - context.offsetY;
			state.local().push(ptX, ptY);
			tools.eraser.findMatches();
		},
		onUp: function(evt) {
			const ERASE_THRESHOLD = 2;
			let ptX = evt.offsetX - context.offsetX;
			let ptY = evt.offsetY - context.offsetY;
			state.local().push(ptX, ptY);
			sendMessage("query", state.local());
			state.local().length = 0;
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

function receiveMessage(evt) {
	document.querySelector('.status').setAttribute('state', 'connected');
	let message = JSON.parse(evt.data);
	if (message.type === 'identify') {
		state.whoami = message.data;
	} else if (message.type === 'all_clients') {
		state.clients = new Set(message.data);
		state.clients.forEach(function(client) {
			state.ongoing[client] = [];
		});
		// TODO clear/prune ongoing??
	} else if (message.type === 'client_joined') {
		state.clients.add(message.data);
		state.ongoing[message.data] = [];
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
			// [id, type, "content"]
			state.elements[element[0]] = {type: element[1], body: JSON.parse(element[2])};
		});
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
			state.ongoing[message.origin].length = 0;
		}
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
	} else if (message.type === 'cleared') {
		// TODO clear ongoing ???
		state.elements = {};
		state.undostack = [];
		state.redostack = [];
		updateState();
	} else if (message.type === 'ongoing') {
		if (message.origin !== state.whoami) {
			Array.prototype.push.apply(
				state.ongoing[message.origin], message.data);
		}
	} else if (message.type === 'matches') {
		tools.eraser.findIntersections(message.data.line, message.data.ids);
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
	mouseX: 0,
	mouseY: 0,
};

function init() {
	let whiteboard = document.querySelector('.whiteboard');
	let canvas = whiteboard.querySelector('canvas');

	// init drawing context
	context.ref = canvas.getContext(context.type);
	context.canvas = canvas;

	// prevent context menu
	canvas.addEventListener('contextmenu', function(evt) {evt.preventDefault()});
	
	// register mouse input handler
	canvas.addEventListener('pointerdown', handlePointer);
	canvas.addEventListener('pointerup', handlePointer);
	canvas.addEventListener('pointerout', handlePointer);
	canvas.addEventListener('pointermove', handlePointer);

	// register button handlers
	document.querySelector('#undo').addEventListener('click', undo);
	document.querySelector('#redo').addEventListener('click', redo);
	
	document.querySelector('#pencil').addEventListener('click', changeTool);
	document.querySelector('#eraser').addEventListener('click', changeTool);
	document.querySelector('#move').addEventListener('click', changeTool);

	document.querySelector('#clear').addEventListener('click', openClearConfirmation);
	document.querySelector('#dialog-clear .confirm').addEventListener('click', clearWhiteboard);
	document.querySelector('#dialog-clear .cancel').addEventListener('click', closeDialog);

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
	sendMessage('add', {type: 'smooth', undo: false, body: element});
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

function changeTool(evt) {
	let activeTool = document.querySelector('[active]');
	activeTool.removeAttribute('active');
	evt.currentTarget.setAttribute('active', '');
	state.activeTool = evt.currentTarget.id;
}

function handlePointer(evt) {
	evt.preventDefault();
	
	if (evt.type === 'pointermove') {
		context.mouseX = evt.offsetX;
		context.mouseY = evt.offsetY;
		if (state.toolInUse === 'active') {
			tools[state.activeTool].onMove(evt);
		} else if (state.toolInUse === 'move') {
			tools.move.onMove(evt);
		}
	} else if (evt.type === 'pointerdown') {
		if (evt.button === 0) {
			state.toolInUse = 'active';
			tools[state.activeTool].onDown(evt);
		} else if (evt.button === 2) {
			state.toolInUse = 'move';
			tools.move.onDown(evt);
		}
	} else if (evt.type === 'pointerup' || evt.type === 'pointerout') {
		if (state.toolInUse === 'active') {
			state.toolInUse = null;
			tools[state.activeTool].onUp(evt);
		} else if (state.toolInUse === 'move') {
			state.toolInUse = null;
			tools.move.onUp(evt);
		}
	}
}

function handleResize(evt) {
	let canvas = context.canvas;
	let whiteboard = canvas.parentElement;

	canvas.width = whiteboard.clientWidth;
	canvas.height = whiteboard.clientHeight;
}


// intersection of object with (eraser) line
let getIntersection = {
	any: function(eraser, element) {
		let points = element.body;

		// element forms a point
		if (points.length === 4 && points[0] === points[2] && points[1] === points[3]) {
			return getIntersection.point(line, points);
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
					console.log(lu, su);
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

let flag = true;

function draw() {
	let ctx = context.ref;
	let w = context.canvas.width;
	let h = context.canvas.height;

	ctx.resetTransform();

	// clear canvas
	if (true /* clear */) {
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, w, h);
	}

	ctx.fillStyle = '#000';
	ctx.font = '20px serif';
	ctx.fillText(`${context.mouseX - context.offsetX}, ${context.mouseY - context.offsetY}`, 0, 30);

	// translate position
	ctx.translate(context.offsetX, context.offsetY);

	// draw update indicator
	if (flag) {
		ctx.fillStyle = '#f00';
	} else {
		ctx.fillStyle = '#00f';
	}
	flag = !flag;
	ctx.fillRect(0, 0, 10, 10);

	// draw grid
	ctx.strokeStyle = '#ccc';

	let gridSize = 30;
	let gridDivisionSize = 2;

	ctx.lineWidth = 1;
	for (let i = 0, x = fmod(context.offsetX, gridSize); x < w; i++, x += gridSize) {
		ctx.beginPath();
		ctx.moveTo(x - context.offsetX, 0 - context.offsetY);
		ctx.lineTo(x - context.offsetX, h - context.offsetY);
		ctx.stroke();
	}

	let gridDivision = fmod(Math.floor(context.offsetY / gridSize), gridDivisionSize);
	for (let j = 0, y = fmod(context.offsetY, gridSize); y < h; j++, y += gridSize) {
		if (j % gridDivisionSize === gridDivision) {
			ctx.lineWidth = 2;
		} else {
			ctx.lineWidth = 1;
		}
		ctx.beginPath();
		ctx.moveTo(0 - context.offsetX, y - context.offsetY);
		ctx.lineTo(w - context.offsetX, y - context.offsetY);
		ctx.stroke();
	}

	// draw content
	ctx.lineWidth = 3;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.strokeStyle = '#148';
	ctx.fillStyle = '#2e4';
	
	for (const [id, element] of Object.entries(state.elements)) {
		drawObject[element.type](ctx, element.body);
	}

	for (const [client, element] of Object.entries(state.ongoing)) {
		if (Number(client) === state.whoami && state.activeTool === "eraser") {
			continue; // skip drawing own line if we're using ongoing for erasing purposes
		}
		if (element.length >= 2) {
			drawObject.smooth(ctx, element);
		}
	}

	// redraw on next frame
	// TODO really only redraw when it's necessary, this should not be /too/ too hard
	window.requestAnimationFrame(draw);
}
