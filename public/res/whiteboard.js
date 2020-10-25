'use strict';

window.addEventListener('load', init);

function throttle(timeout, func) {
	let previous = 0;
	let run = function(a, b) {
		let now = Date.now();
		if (now - previous >= timeout) {
			func(a, b);
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

// https://stackoverflow.com/a/52171480/4704639
function cyrb53(str, seed = 0) {
	let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
	for (let i = 0, ch; i < str.length; i++) {
		ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1>>>16), 2246822507) ^ Math.imul(h2 ^ (h2>>>13), 3266489909);
	h2 = Math.imul(h2 ^ (h2>>>16), 2246822507) ^ Math.imul(h1 ^ (h1>>>13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1>>>0);
};

let state = {
	websocket: null,
	whoami: null,
	clients: null,
	activeTool: 'pan',
	toolInUse: null, // "pan" OR "active"
	// TODO temporary mobile zoom
	pointers: new Array(),
	lastPointerDist: -1,
	didPinch: false,
	ongoing: {
		// client_id: {
		//   TODO:
		//   type: 'none'
		//
		//   type: 'eraser'
		//   data: [<points>]
		//
		//   type: 'select'
		//   data: [ax, ay, bx, by}
		//
		//   type: 'freehand'/'line'
		//   data: {
		//     body: [<points>]
		//     size: <num>
		//     colour: '#rrggbb'
		//   }
		//   
		//   type: 'move'/'copy'
		//   data: {
		//     points: [ax, ay, bx by]
		//     offset: [x, y]
		//     ids: [<ids>]
		//   }
		//
		//   --------------
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
	images: {
		// url_md5: 
	},
};
window.state = state;

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
	canvas.addEventListener('pointerdown', handlePointerDown, false);
	canvas.addEventListener('pointerup', handlePointerUp, false);
	canvas.addEventListener('pointerout', handlePointerUp, false);
	canvas.addEventListener('pointercancel', handlePointerUp, false);
	canvas.addEventListener('pointermove', handlePointerMove, false);
	canvas.addEventListener('wheel', handleWheel);

	canvas.addEventListener('dragenter', dragEnterCanvas);
	canvas.addEventListener('dragover', dragOverCanvas);
	canvas.addEventListener('drop', dropImage);

	// add keypress listener
	document.addEventListener('keydown', handleKeyDown);

	// handle resizing
	window.addEventListener('resize', handleResize);
	handleResize(null);

	// toolbar desktop
	document.querySelector('.container .toolbar').addEventListener('wheel', function(evt) {
		if (evt.currentTarget.scrollWidth > evt.currentTarget.scrollHeight && evt.deltaY != 0) {
			evt.currentTarget.scrollBy({top: 0, left: evt.deltaY * 10 * window.devicePixelRatio, behavior: 'auto'});
		}
	});

	// register button handlers
	document.querySelector('#undo').addEventListener('click', undo);
	document.querySelector('#redo').addEventListener('click', redo);
	
	document.querySelector('#select').addEventListener('click', changeTool);
	document.querySelector('#pan').addEventListener('click', changeTool);
	document.querySelector('#pencil').addEventListener('click', changeTool);
	document.querySelector('#eraser').addEventListener('click', changeTool);

	document.querySelector('#freehand').addEventListener('click', changePencilType);
	document.querySelector('#line').addEventListener('click', changePencilType);
	document.querySelector('#rectangle').addEventListener('click', changePencilType);
	document.querySelector('#ellipse').addEventListener('click', changePencilType);

	document.querySelector('#deselect').addEventListener('click', clearSelection);
	document.querySelector('#move').addEventListener('click', changeTool);
	document.querySelector('#copy').addEventListener('click', changeTool);
	document.querySelector('#delete').addEventListener('click', deleteSelection);
	
	document.querySelector('#size').addEventListener('click', toggleSizeSelector);
	
	for (let button of document.querySelectorAll('#dialog-size button')) {
		button.addEventListener('click', selectSize);
	}
	
	document.querySelector('#colour').addEventListener('click', toggleColourSelector);
	document.querySelector('#colour-preview').addEventListener('click', toggleColourSelector);
	document.querySelector('#range-red').addEventListener('input', updateColour);
	document.querySelector('#range-green').addEventListener('input', updateColour);
	document.querySelector('#range-blue').addEventListener('input', updateColour);
	document.querySelector('#range-red').addEventListener('wheel', selectSlider);
	document.querySelector('#range-green').addEventListener('wheel', selectSlider);
	document.querySelector('#range-blue').addEventListener('wheel', selectSlider);
	document.querySelector('#manual-colour').addEventListener('change', manualColour);

	for (let button of document.querySelectorAll('#colour-palette button.palette')) {
		button.addEventListener('click', selectColour);
	}

	initCustomColours();

	setDrawingColour('#148');

	document.querySelector('#addcolour').addEventListener('click', addCustomColour);
	document.querySelector('#delcolour').addEventListener('click', removeCustomColour);
	document.querySelector('#pipette').addEventListener('click', changeTool);

	document.querySelector('#settings').addEventListener('click', openSettingsDialog);
	document.querySelector('#close-settings').addEventListener('click', closeDialog);

	document.querySelector('#image').addEventListener('click', openImage);
	document.getElementById('file-select').addEventListener('change', insertImage);

	document.querySelector('#clear').addEventListener('click', openClearConfirmation);
	document.querySelector('#dialog-clear #confirm-clear').addEventListener('click', clearWhiteboard);
	document.querySelector('#dialog-clear #cancel-clear').addEventListener('click', closeDialog);

	document.querySelector('#theme').addEventListener('click', toggleTheme);
	document.querySelector('#palette').addEventListener('click', toggleDefaultPalette);

	updateState();

	loadTheme();

	// connect to websocket server
	connectToWebSocket();

	// start recursive draw request
	window.requestAnimationFrame(draw);
}

const SCROLL_PINCH_DISTANCE = 12;

function handlePointerMove(evt) {
	evt.preventDefault();
	
	if (state.toolInUse === 'active') {
		// TODO temporary mobile zoom
		if (state.activeTool === 'pan') {
			let evtIndex = state.pointers.findIndex((elem) => elem.pointerId == evt.pointerId);
			state.pointers.splice(evtIndex, 1, evt);

			if (state.pointers.length > 1) {
				let p0 = state.pointers[0];
				let p1 = state.pointers[1];
				let pointerDist = Math.hypot(p0.clientX - p1.clientX, p0.clientY - p1.clientY);

				if (state.lastPointerDist > 0) {
					if (Math.abs(state.lastPointerDist - pointerDist) > SCROLL_PINCH_DISTANCE * window.devicePixelRatio) {
						if (pointerDist > state.lastPointerDist) {
							// pinch out -> zoom in
							handleWheel({deltaY: -1, currentTarget: context.canvas, shiftKey: true,
								offsetX: window.devicePixelRatio * (p0.offsetX + p1.offsetX) / 2,
								offsetY: window.devicePixelRatio * (p0.offsetY + p1.offsetY) / 2});
						} else if (pointerDist < state.lastPointerDist) {
							// pinch in -> zoom out
							handleWheel({deltaY: +1, currentTarget: context.canvas, shiftKey: true,
								offsetX: window.devicePixelRatio * (p0.offsetX + p1.offsetX) / 2,
								offsetY: window.devicePixelRatio * (p0.offsetY + p1.offsetY) / 2});
						}
						state.lastPointerDist = pointerDist;
						state.didPinch = true;
					}
				} else {
					state.lastPointerDist = pointerDist;
				}
				return;
			} else {
				tools[state.activeTool].onMove(evt);
				context.needRedraw = true;
			}
		} else if (state.pointers[0].pointerId === evt.pointerId) {
			tools[state.activeTool].onMove(evt);
			context.needRedraw = true;
		}
	} else if (state.toolInUse === 'pan') {
		tools.pan.onMove(evt);
		context.needRedraw = true;
	}
}

function handlePointerDown(evt) {
	evt.preventDefault();
	
	if (evt.button === 0 && document.hasFocus()) {
		state.pointers.push(evt);

		if (state.pointers.length > 1) {
			return;
		}

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
}

function handlePointerUp(evt) {
	evt.preventDefault();
	
	if (state.toolInUse === 'active') {
		let evtIndex = state.pointers.findIndex((elem) => elem.pointerId == evt.pointerId);
		if (evtIndex < 0) {
			// ignore double fire event
			return;
		}
		state.pointers.splice(evtIndex, 1);

		if (state.activeTool === 'pan') {
			if (state.pointers.length < 2) {
				state.lastPointerDist = -1;
			}
			if (state.didPinch) {
				if (state.pointers.length === 1) {
					tools.pan.onDown(state.pointers[0]);
					state.didPinch = false;
				}
				return;
			}
		} else if (state.pointers.length > 0) {
			return;
		}

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

// only allow specific scale values at variable intervals for maximal usefulness
// and to keep some semblance of pixel accuracy at closer values
let scaleLevels = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0, 4.0];

function handleWheel(evt) {
	// we don't really want to care about the amount of lines scrolled
	// that is fairly setup specific, so we only use the wheel direction
	let direction = Math.sign(evt.deltaY);

	let scaleIndex = scaleLevels.indexOf(context.scale);
	let nextIndex = scaleIndex - direction;
	if (nextIndex < 0 || nextIndex >= scaleLevels.length) {
		return; // do not update anything
	}
	let newScale = scaleLevels[nextIndex];

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
		if (state.activeTool === 'select') {
			if (evt.key === 'Escape') {
				clearSelection();
			} else if (evt.key === 'Delete') {
				deleteSelection();
			}
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
		if (lastAction.type === 'added') {
			sendMessage('del', {ids: lastAction.data, undo: true});
		} else if (lastAction.type === 'deleted') {
			sendMessage('add', {elements: lastAction.data, undo: true, select: false});
		} else if (lastAction.type === 'moved') {
			let ids = lastAction.data.idmap.map(([_, id]) => id);
			let [offX, offY] = lastAction.data.offset;
			let movedElements = tools.move.moveElements(ids, [-offX, -offY], true);
			sendMessage('move', {elements: movedElements, offset: [-offX, -offY], undo: true});
		} else {
			console.error('undo action not handled for type', lastAction.type);
		}
		updateState();
	}
}

function redo(evt) {
	if (!evt.currentTarget.hasAttribute('disabled')) {
		let lastUndo = state.redostack.pop();
		if (lastUndo.type === 'added') {
			sendMessage('del', {ids: lastUndo.data, undo: false});
		} else if (lastUndo.type === 'deleted') {
			sendMessage('add', {elements: lastUndo.data, undo: false, select: false});
		} else if (lastUndo.type === 'moved') {
			let ids = lastUndo.data.idmap.map(([_, id]) => id);
			let [offX, offY] = lastUndo.data.offset;
			let movedElements = tools.move.moveElements(ids, [-offX, -offY], true);
			sendMessage('move', {elements: movedElements, offset: [-offX, -offY], undo: false});
		} else {
			console.error('redo action not handled for type', lastUndo.type);
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
	if (activeTool.id === 'eraser' && evt.currentTarget.id === 'eraser') {
		// special eraser toggle function
		setTool('pencil');
		return;
	}

	activeTool.removeAttribute('active');
	evt.currentTarget.setAttribute('active', '');
	state.activeTool = evt.currentTarget.id;

	document.querySelector('#dialog-clear').removeAttribute('open');
	document.querySelector('#dialog-size').removeAttribute('open');
	if (evt.currentTarget.id !== 'pipette') {
		document.querySelector('#dialog-colour').removeAttribute('open');
	}
	toggleSelectionToolbar();
	togglePencilToolbar(activeTool.id !== 'pencil');
}

function changePencilType(evt) {
	let pencilBtn = document.querySelector('#pencil');
	pencilBtn.setAttribute('tool', evt.currentTarget.id);

	tools.pencil.type = evt.currentTarget.id;
	
	togglePencilToolbar();
}

function toggleSelectionToolbar() {
	let toolbar = document.querySelector('.toolbar[visible]');
	let visible = toolbar.getAttribute('visible');
	if (state.activeTool === 'select' || state.activeTool === 'move' || state.activeTool === 'copy') {
		if (state.selected.size > 0) {
			// TODO set max size
			toolbar.setAttribute('visible', 'selection');
		} else {
			toolbar.setAttribute('visible', '');
		}
	} else if (visible === 'selection') {
		toolbar.setAttribute('visible', '');
		state.selected.clear();
		context.needRedraw = true;
	}
}

function togglePencilToolbar(close) {
	let toolbar = document.querySelector('.toolbar[visible]');
	let visible = toolbar.getAttribute('visible');
	if (state.activeTool === 'pencil') {
		if (close || visible === 'pencil') {
			toolbar.setAttribute('visible', '');
		} else {
			// TODO set max size
			toolbar.setAttribute('visible', 'pencil');
		}
	} else if (visible === 'pencil') {
		toolbar.setAttribute('visible', '');
	}
}

function clearSelection() {
	setTool('select');
	state.selected.clear();
	toggleSelectionToolbar();
	context.needRedraw = true;
}

function deleteSelection() {
	setTool('select');
	sendMessage('del', {ids: Array.from(state.selected), undo: false});
	state.selected.clear();
	state.redostack.length = 0;
	updateState();
	context.needRedraw = true;
}

function toggleSizeSelector(evt) {
	setTool('pencil');
	togglePencilToolbar(true);
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
	togglePencilToolbar(true);
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

	// custom palette edit status
	let paletteIndex = customColours.findIndex((entry) => entry[0] === hex);
	document.querySelector('#delcolour').toggleAttribute('disabled', paletteIndex < 0);
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

let customColours = [];

function addCustomColourElement(colour) {
	let container = document.querySelector('.custom-colours');

	let patch = document.createElement('button');
	patch.classList.add('palette');
	patch.style.setProperty('--colour', colour);
	patch.addEventListener('click', selectColour);
	container.appendChild(patch);

	customColours.push([colour, patch]);
	
	// custom palette edit status
	document.querySelector('#delcolour').removeAttribute('disabled');
}

function initCustomColours() {
	let matchDefault = document.cookie.match(/defaultPalette=(.+?)(;|$)/);
	if (matchDefault) {
		toggleDefaultPalette(matchDefault[1]);
	} else {
		toggleDefaultPalette('show');
	}

	let match = document.cookie.match(/palette=(.*?)(;|$)/);
	
	if (match && match[1]) {
		let colours = match[1].split(',');
		for (let i = 0; i < colours.length; i++) {
			addCustomColourElement(colours[i]);
		}
	}
}

function saveCustomColours() {
	let palette = '';
	for (let i = 0; i < customColours.length; i++) {
		if (i > 0) {
			palette += ',';
		}
		let colour = customColours[i][0];
		palette += colour;
	}

	document.cookie = `palette=${palette};max-age=8640000;sameSite=strict`;
}

function addCustomColour(evt) {
	addCustomColourElement(tools.drawingColour);
	saveCustomColours();
}

function removeCustomColour(evt) {
	for (let i = customColours.length - 1; i >= 0; i--) {
		if (customColours[i][0] === tools.drawingColour) {
			let [[colour, patch]] = customColours.splice(i, 1);
			patch.parentNode.removeChild(patch);
			saveCustomColours();
			return;
		}
	}
}

function toggleDefaultPalette(setting) {
	if (setting.currentTarget) {
		let current = document.body.getAttribute('palette');
		setting = current === 'show' ? 'hide' : 'show';
	}
	document.body.setAttribute('palette', setting);
	document.cookie = `defaultPalette=${setting};max-age=8640000;sameSite=strict`;
}

function dragEnterCanvas(evt) {
	evt.preventDefault();
}

function dragOverCanvas(evt) {
	evt.preventDefault();
}

function dropImage(evt) {
	evt.preventDefault();
	
	console.log(evt, evt.dataTransfer);
	if (evt.dataTransfer.files[0].type.startsWith('image/')) {
		insertImage(evt);
	}
}

function openImage() {
	let fileSelect = document.getElementById('file-select');
	fileSelect.click();
}

function insertImage(evt) {
	let file, centreImage = false, mouseX, mouseY;
	if (evt.dataTransfer) {
		file = evt.dataTransfer.files[0];
		mouseX = evt.layerX;
		mouseY = evt.layerY;
	} else {
		file = evt.currentTarget.files[0];
		centreImage = true;
	}

	if (file.type.startsWith('image/')) {
		let reader = new FileReader();
		reader.onload = async function(evt) {
			let dataUrl = reader.result;

			let image = await window.createImageBitmap(file);
			let x, y;
			if (centreImage) {
				x = Math.floor((context.canvas.width / context.scale - image.width) / 2) - context.offsetX / context.scale;
				y = Math.floor((context.canvas.height / context.scale - image.height) / 2) - context.offsetY / context.scale;
			} else {
				x = (mouseX - context.offsetX) / context.scale;
				y = (mouseY - context.offsetY) / context.scale;
			}

			/*
			let [x, y] = context.abs(Math.floor(image.width / 2), Math.floor(image.height / 2));
			x -= context.offsetX;
			y -= context.offsetY;
			let x = Math.floor(image.width / 2) - context.offsetX;
			let y = Math.floor(image.height / 2) - context.offsetY;*/
			let bounds = {
				lower_x: x,
				lower_y: y,
				upper_x: x + image.width,
				upper_y: y + image.height,
			};

			let imageElement = {type: 'image', body: dataUrl, bounds: bounds};
			sendMessage('add', {elements: [imageElement], undo: false, select: true});

			document.querySelector('#dialog-settings').removeAttribute('open');
		};
		reader.readAsDataURL(file);

		setTool('move');
	}
}

function openClearConfirmation() {
	document.querySelector('#dialog-clear').setAttribute('open', '');
	document.querySelector('#dialog-size').removeAttribute('open');
	document.querySelector('#dialog-colour').removeAttribute('open');
}
function clearWhiteboard(evt) {
	sendMessage('clear', '');
	closeDialog(evt);
}

function openSettingsDialog() {
	document.querySelector('#dialog-settings').setAttribute('open', '');
}

function loadTheme() {
	let match = document.cookie.match(/theme=(.+?)(;|$)/);

	if (match) {
		setTheme(match[1]);
	} else {
		setTheme('light');
	}
}

function toggleTheme(evt) {
	let body = document.querySelector('body');
	let theme = body.getAttribute('theme');
	if (theme === 'light') {
		setTheme('dark');
	} else {
		setTheme('light');
	}
}

function setTheme(theme) {
	let body = document.querySelector('body');
	body.setAttribute('theme', theme);
	document.cookie = `theme=${theme};max-age=8640000;sameSite=strict`;
	context.theme = theme;
	context.needRedraw = true;
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
	console.log(evt);
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
				type: 'none',
			};
		}
	} else if (message.type === 'client_joined') {
		state.clients.add(message.data);
		state.ongoing[message.data] = {
			type: 'none',
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
		for (let i = 0; i < message.data.length; i++) {
			let element = message.data[i];
			// [id, type, "content", bounds...]
			if (element[1] === 'image') {
				let elem = JSON.parse(element[2]);
				let hash = cyrb53(elem.body.slice(-128));

				state.images[hash] = new Image();
				state.images[hash].onload = function() {
					context.needRedraw = true;
				};
				state.images[hash].src = elem.body;
				
				elem.body = [elem.bounds.lower_x, elem.bounds.lower_y, hash];
				state.elements[element[0]] = elem;
			} else {
				state.elements[element[0]] = JSON.parse(element[2]);
			}
		}
		context.needRedraw = true;
	} else if (message.type === 'added') {
		let ids = [];
		for (let i = 0; i < message.data.elements.length; i++) {
			let element = message.data.elements[i];
			if (element.element.type === 'image') {
				let elem = element.element;
				let hash = cyrb53(elem.body.slice(-128));

				state.images[hash] = new Image();
				state.images[hash].src = elem.body;
				
				elem.body = [elem.bounds.lower_x, elem.bounds.lower_y, hash];
				state.elements[element.id] = elem;
			} else {
				state.elements[element.id] = element.element;
			}
			ids.push(element.id);
			if (message.origin === state.whoami && message.data.select) {
				state.selected.add(element.id);
			}
		}
		toggleSelectionToolbar();
		if (message.origin === state.whoami) {
			let action = {type: 'added', data: ids};
			if (message.data.undo) {
				state.redostack.push(action);
			} else {
				state.undostack.push(action);
			}
			updateState();
		} else {
			// TODO is this wise? I guess ongoing from message.origin will always be relevant
			state.ongoing[message.origin].type = 'none';
			delete state.ongoing[message.origin].data;
		}
		context.needRedraw = true;
	} else if (message.type === 'deleted') {
		if (message.origin === state.whoami) {
			let elements = [];
			for (let i = 0; i < message.data.ids.length; i++) {
				let element_id = message.data.ids[i];
				if (state.elements[element_id] && state.elements[element_id].type === 'image') {
					// no undo for image deletion
				} else {
					elements.push(state.elements[element_id]);
				}
			}
			if (elements.length > 0) {
				let action = {type: 'deleted', data: elements};
				if (message.data.undo) {
					state.redostack.push(action);
				} else {
					state.undostack.push(action);
				}
				updateState();
			}
		} else {
			for (let i = 0; i < message.data.ids.length; i++) {
				let element_id = message.data.ids[i];
				let operationIndex = state.undostack.findIndex(function(op) {
					return op.type === 'added' && op.data.includes(element_id);
				});
				if (operationIndex >= 0) {
					// someone has deleted an element we've created,
					// remove it from our undo stack
					let idIndex = state.undostack[operationIndex].data.indexOf(element_id);
					if (idIndex >= 0) {
						state.undostack[operationIndex].data.splice(idIndex, 1);
						if (state.undostack[operationIndex].data.length === 0) {
							state.undostack.splice(operationIndex, 1);
						}
					}
					updateState();
				}
			}
		}
		for (let i = 0; i < message.data.ids.length; i++) {
			let element_id = message.data.ids[i];
			/*if (state.elements[element_id].type === 'image') {
				// TODO consider refcounting, either way it's probably fine this way,
				// just refresh, forehead
				// delete state.images[state.elements[element_id].body[2]];
			}*/
			state.selected.delete(element_id);
			delete state.elements[element_id];
		}
		toggleSelectionToolbar();
		context.needRedraw = true;
	} else if (message.type === 'moved') {
		if (message.origin === state.whoami) {
			state.selected.clear();
			for (let i = 0; i < message.data.idmap.length; i++) {
				let [old_id, new_id] = message.data.idmap[i];
				state.selected.add(new_id);
			}
			let action = {type: 'moved', data: message.data}; // {idmap: [[a,b],..], offset: [x,y]}
			if (message.data.undo) {
				state.redostack.push(action);
			} else {
				state.undostack.push(action);
			}
			updateState();
		} else {
			state.ongoing[message.origin].type = 'none';
			delete state.ongoing[message.origin].data;

			// TODO clean up undo history with idmap or w/e, like with delete
		}
		for (let i = 0; i < message.data.idmap.length; i++) {
			let [old_id, new_id] = message.data.idmap[i];
			state.elements[new_id] = state.elements[old_id];
			state.selected.delete(old_id);
			delete state.elements[old_id];
			let element = state.elements[new_id];
			if (element.type === 'line' || element.type === 'smooth') {
				element.body = element.body.map(function(x, i) {
					return x - message.data.offset[i % 2];
				});
			} else if (element.type === 'ellipse' || element.type === 'image') {
				element.body[0] -= message.data.offset[0];
				element.body[1] -= message.data.offset[1];
			} else {
				console.error('moving is not handled for type', element.type);
			}
			element.bounds.lower_x -= message.data.offset[0];
			element.bounds.lower_y -= message.data.offset[1];
			element.bounds.upper_x -= message.data.offset[0];
			element.bounds.upper_y -= message.data.offset[1];
		}
		context.needRedraw = true;
	} else if (message.type === 'cleared') {
		state.elements = {};
		state.undostack = [];
		state.redostack = [];
		state.images = {};
		updateState();
		context.needRedraw = true;
	} else if (message.type === 'ongoing') {
		if (message.origin !== state.whoami) {
			let update = message.data;
			let ongoing = state.ongoing[message.origin];
			if (ongoing.type !== update.type) {
				// first time receiving this type
				ongoing.type = update.type;
				ongoing.data = update.data;
			} else {
				if (update.type === 'freehand') {
					for (let i = 0; i < update.data.body.length; i++) {
						ongoing.data.body.push(update.data.body[i]);
					}
				} else if (update.type === 'line' || update.type === 'arrow'
					|| update.type === 'rectangle' || update.type === 'ellipse') {
					ongoing.data.body = update.data.body;
				} else if (update.type === 'move' || update.type === 'copy') {
					ongoing.data.offset = update.data.offset;
				} else {
					console.error('ongoing update is not handled for type', element.type);
				}
			}
		}
		context.needRedraw = true;
	} else if (message.type === 'matches') {
		if (message.data.type === 'eraser') {
			let intersects = tools.eraser.findIntersections(message.data.line, message.data.ids);
			if (intersects.length > 0) {
				sendMessage('del', {ids: intersects, undo: false});
				state.redostack.length = 0;
				updateState();
			}
		} else if (message.data.type === 'select' || message.data.type === 'expand') {
			if (message.data.type === 'select') {
				state.selected.clear();
			}
			for (let i = 0; i < message.data.ids.length; i++) {
				state.selected.add(message.data.ids[i]);
			}
			toggleSelectionToolbar();
		} else if (message.data.type === 'deselect') {
			for (let i = 0; i < message.data.ids.length; i++) {
				state.selected.delete(message.data.ids[i]);
			}
			toggleSelectionToolbar();
		} else if (message.data.type === 'pipette') {
			let intersects = tools.eraser.findIntersections(message.data.line, message.data.ids);
			intersects = intersects.filter((e) => e.type !== 'image');
			if (intersects.length > 0) {
				let randIndex = Math.floor(Math.random() * intersects.length);
				let selectedElement = state.elements[intersects[randIndex]];
				setDrawingColour(selectedElement.colour);
			}
		}
		context.needRedraw = true;
	} else {
		console.log('unsupported message', message);
	}
}

let tools = {
	drawingColour: '#148',
	drawingSize: 3,
	shareOngoing: throttle(20/* ms */, function(type, data) {
		sendMessage('update', {
			type: type,
			data: data(),
		});
	}),
	pencil: {
		type: 'freehand',
		onDown: function(evt) {
			togglePencilToolbar(true);
			tools[tools.pencil.type].onDown(evt);
		},
		onMove: function(evt) {
			tools[tools.pencil.type].onMove(evt);
		},
		onUp: function(evt) {
			tools[tools.pencil.type].onUp(evt);
			state.local().type = 'none';
			delete state.local().data;
			state.redostack.length = 0;
			updateState();
		},
	},
	freehand: {
		previousLength: 0,
		onDown: function(evt) {
			state.local().type = 'freehand';
			state.local().data = {
				size: tools.drawingSize,
				colour: tools.drawingColour,
				type: 'smooth',
				body: context.abs(evt.offsetX, evt.offsetY),
			};
			tools.shareOngoing('freehand', function() {
				return state.local().data;
			});
		},
		onMove: function(evt) {
			state.local().data.body.push(...context.abs(evt.offsetX, evt.offsetY));
			tools.shareOngoing('freehand', function () {
				let data = {
					body: state.local().data.body.slice(tools.freehand.previousLength)
				};
				tools.freehand.previousLength = state.local().data.body.length;
				return data;
			});
		},
		onUp: function(evt) {
			state.local().data.body.push(...context.abs(evt.offsetX, evt.offsetY));
			sendMessage('add', {
				elements: [state.local().data],
				undo: false,
				select: false,
			});
			tools.freehand.previousLength = 0;
		},
	},
	line: {
		onDown: function(evt) {
			state.local().type = 'line';
			state.local().data = {
				size: tools.drawingSize,
				colour: tools.drawingColour,
				type: 'line',
				body: [
					...context.abs(evt.offsetX, evt.offsetY),
					...context.abs(evt.offsetX, evt.offsetY)],
			};
			tools.shareOngoing('line', function() {
				return state.local().data;
			});
		},
		onMove: function(evt) {
			state.local().data.body.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			tools.shareOngoing('line', function() {
				return state.local().data;
			});
		},
		onUp: function(evt) {
			state.local().data.body.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			sendMessage('add', {
				elements: [state.local().data],
				undo: false,
				select: false,
			});
		},
	},
	rectangle: {
		onDown: function(evt) {
			state.local().type = 'rectangle';
			state.local().data = {
				size: tools.drawingSize,
				colour: tools.drawingColour,
				type: 'line',
				body: [
					...context.abs(evt.offsetX, evt.offsetY), // permanent
					...context.abs(evt.offsetX, evt.offsetY), // y changes
					...context.abs(evt.offsetX, evt.offsetY), // x,y changes
					...context.abs(evt.offsetX, evt.offsetY), // x changes
					...context.abs(evt.offsetX, evt.offsetY)] // permanent
			};
			tools.shareOngoing('rectangle', function() {
				return state.local().data;
			});
		},
		onMove: function(evt) {
			let [outerX, outerY] = context.abs(evt.offsetX, evt.offsetY);
			state.local().data.body.splice(3, 4, outerY, outerX, outerY, outerX);
			tools.shareOngoing('rectangle', function() {
				return state.local().data;
			});
		},
		onUp: function(evt) {
			let [outerX, outerY] = context.abs(evt.offsetX, evt.offsetY);
			state.local().data.body.splice(3, 4, outerY, outerX, outerY, outerX);
			sendMessage('add', {
				elements: [state.local().data],
				undo: false,
				select: false,
			});
		},
	},
	ellipse: {
		onDown: function(evt) {
			state.local().type = 'ellipse';
			state.local().data = {
				size: tools.drawingSize,
				colour: tools.drawingColour,
				type: 'ellipse',
				body: [
					...context.abs(evt.offsetX, evt.offsetY), // centre
					0, 0], // radius x, y
			};
			tools.shareOngoing('ellipse', function() {
				return state.local().data;
			});
		},
		onMove: function(evt) {
			let [innerX, innerY] = state.local().data.body;
			let [outerX, outerY] = context.abs(evt.offsetX, evt.offsetY);
			state.local().data.body.splice(2, 2, Math.abs(outerX - innerX), Math.abs(outerY - innerY));
			tools.shareOngoing('ellipse', function() {
				return state.local().data;
			});
		},
		onUp: function(evt) {
			let [innerX, innerY] = state.local().data.body;
			let [outerX, outerY] = context.abs(evt.offsetX, evt.offsetY);
			let [radiusX, radiusY] = [Math.abs(outerX - innerX), Math.abs(outerY - innerY)];
			state.local().data.body.splice(2, 2, radiusX, radiusY);
			state.local().data.bounds = {
				lower_x: innerX - radiusX,
				upper_x: innerX + radiusX,
				lower_y: innerY - radiusY,
				upper_y: innerY + radiusY,
			};
			sendMessage('add', {
				elements: [state.local().data],
				undo: false,
				select: false,
			});

		},
	},
	eraser: {
		// for proper eraser performance, this needs to be at least half
		// of the maximum element diameter, otherwise points will not be gotten properly
		padding: 12,
		findMatches: throttle(20/* ms */, function() {
			sendMessage('query', {
				body: state.local().data,
				padding: tools.eraser.padding,
				type: 'eraser',
				contain: false,
			});
			// only keep last point
			state.local().data = state.local().data.slice(-2);
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
			return intersects;
		},
		onDown: function(evt) {
			state.local().type = 'eraser';
			state.local().data = context.abs(evt.offsetX, evt.offsetY);
		},
		onMove: function(evt) {
			state.local().data.push(...context.abs(evt.offsetX, evt.offsetY));
			tools.eraser.findMatches();
		},
		onUp: function(evt) {
			const ERASE_THRESHOLD = 2;
			state.local().data.push(...context.abs(evt.offsetX, evt.offsetY));
			sendMessage('query', {
				body: state.local().data,
				padding: tools.eraser.padding,
				type: 'eraser',
				contain: false,
			});
			state.local().type = 'none';
			delete state.local().data;
		},
	},
	select: {
		onDown: function(evt) {
			state.local().type = 'select';
			state.local().data = [
				...context.abs(evt.offsetX, evt.offsetY),
				...context.abs(evt.offsetX, evt.offsetY)
			];
		},
		onMove: function(evt) {
			state.local().data.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
		},
		onUp: function(evt) {
			state.local().data.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			let data = {
				body: state.local().data,
				padding: 0,
				type: 'select',
				contain: true,
			};
			if (evt.ctrlKey) {
				data.type = 'deselect';
			} else if (evt.shiftKey) {
				data.type = 'expand';
			}
			sendMessage('query', data);
			state.local().type = 'none';
			delete state.local().data;
		},
	},
	move: {
		moveElements: function(ids, offset, keepId) {
			let elements = [];
			for (const id of ids) {
				let element = JSON.parse(JSON.stringify(state.elements[id]));
				if (element.type === 'line' || element.type === 'smooth') {
					element.body = element.body.map((x, i) => x - offset[i % 2]);
				} else if (element.type === 'ellipse') {
					element.body[0] -= offset[0];
					element.body[1] -= offset[1];
				} else if (element.type === 'image') {
					element.body = state.images[element.body[2]].src;
				} else {
					console.error('moving is not handled for elements of type', element.type);
				}
				element.bounds.lower_x -= offset[0];
				element.bounds.lower_y -= offset[1];
				element.bounds.upper_x -= offset[0];
				element.bounds.upper_y -= offset[1];

				if (keepId) {
					elements.push([id, element]);
				} else {
					elements.push(element);
				}
			}
			return elements;
		},
		onDown: function(evt) {
			state.local().type = 'move';
			state.local().data = {
				points: [
					...context.abs(evt.offsetX, evt.offsetY),
					...context.abs(evt.offsetX, evt.offsetY)
				],
				offset: [0, 0],
				ids: Array.from(state.selected),
			};
			tools.shareOngoing('move', function () {
				return state.local().data;
			});
		},
		onMove: function(evt) {
			state.local().data.points.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			state.local().data.offset = [
				state.local().data.points[0] - state.local().data.points[2],
				state.local().data.points[1] - state.local().data.points[3]
			];
			tools.shareOngoing('move', function () {
				return {
					offset: state.local().data.offset
				};
			});
		},
		onUp: function(evt) {
			state.local().data.points.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			state.local().data.offset = [
				state.local().data.points[0] - state.local().data.points[2],
				state.local().data.points[1] - state.local().data.points[3]
			];
			
			let elements = tools.move.moveElements(state.local().data.ids, state.local().data.offset, true);
			
			sendMessage('move', {
				elements: elements,
				offset: state.local().data.offset,
				undo: false,
			});

			/*
			sendMessage('add', {
				elements: elements,
				undo: false,
				select: true,
			});
			sendMessage('del', {
				ids: state.local().data.ids,
				undo: false,
			});*/
			state.local().type = 'none';
			delete state.local().data;
		},
	},
	copy: {
		onDown: function(evt) {
			state.local().type = 'copy';
			state.local().data = {
				points: [
					...context.abs(evt.offsetX, evt.offsetY),
					...context.abs(evt.offsetX, evt.offsetY)
				],
				offset: [0, 0],
				ids: Array.from(state.selected),
			};
			tools.shareOngoing('copy', function () {
				return state.local().data;
			});
		},
		onMove: function(evt) {
			state.local().data.points.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			state.local().data.offset = [
				state.local().data.points[0] - state.local().data.points[2],
				state.local().data.points[1] - state.local().data.points[3]
			];
			tools.shareOngoing('copy', function () {
				return {
					offset: state.local().data.offset
				};
			});
		},
		onUp: function(evt) {
			state.local().data.points.splice(2, 2, ...context.abs(evt.offsetX, evt.offsetY));
			state.local().data.offset = [
				state.local().data.points[0] - state.local().data.points[2],
				state.local().data.points[1] - state.local().data.points[3]
			];
			
			let elements = tools.move.moveElements(state.local().data.ids, state.local().data.offset, false);
			
			sendMessage('add', {
				elements: elements,
				undo: false,
				select: true,
			});
			setTool('move');
			state.local().type = 'none';
			delete state.local().data;
			state.selected.clear();
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
	pipette: {
		padding: 4,
		onDown: function(evt) {
			let [x, y] = context.abs(evt.offsetX, evt.offsetY);
			
			sendMessage('query', {
				body: [x, y, x, y],
				padding: tools.pipette.padding,
				type: 'pipette',
				contain: false,
			});
		},
		onMove: function(evt) {},
		onUp: function(evt) {},
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
	let len = Math.hypot(x, y); // sqrt(x^2 + y^2)
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

		if (dx === 0 && dy === 0) {
			// element forms a point
			return convertToPoly.point(line, radius);
		}

		let [nx, ny] = getNormal(line);
		let [ox, oy] = normalize([nx, ny], radius); // width offset

		let axes = [[nx, ny], [dx, dy]];
		let verts = [
			ax + ox, ay + oy, bx + ox, by + oy,
			ax - ox, ay - oy, bx - ox, by - oy];

		return [axes, verts];
	},
	smooth: function(line, radius) {
		// TODO could be more accurate
		return convertToPoly.line(line, radius);
	},
	ellipse: function(data, radius) {
		let [x, y, rX, rY] = data;

		let quadrantOffset = [];
		// convert ellipse quadrant to path
		// https://stackoverflow.com/a/22707098/4704639
		const N = 12;
		for (let i = 0; i < N; i++) {
			let theta = Math.PI / 2 * i / N;
			let fi = Math.PI / 2 - Math.atan(Math.tan(theta) * rX / rY);
			quadrantOffset.push(rX * Math.cos(fi));
			quadrantOffset.push(rY * Math.sin(fi));
		}
		// last point
		quadrantOffset.push(rX * Math.sin(0), rY * Math.sin(0));
		
		// determine axes
		let axes = [];
		for (let i = 0; i < N; i++) {
			let line = quadrantOffset.slice(i * 2);
			let normal = getNormal(line);
			axes.push(normal);
		}

		// convert to points
		let verts = [];
		for (let i = 0; i <= N; i++) {
			let offX, offY = quadrantOffset.slice(i * 2);
			verts.push(x + offX, y + offY);
		}
		for (let i = N; i >= 0; i--) {
			let offX, offY = quadrantOffset.slice(i * 2);
			verts.push(x + offX, y - offY);
		}
		for (let i = 0; i <= N; i++) {
			let offX, offY = quadrantOffset.slice(i * 2);
			verts.push(x - offX, y - offY);
		}
		for (let i = N; i >= 0; i--) {
			let offX, offY = quadrantOffset.slice(i * 2);
			verts.push(x - offX, y + offY);
		}

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
	let [eraserAxes, eraserVerts] = convertToPoly.line(eraser, ERASER_RADIUS);

	let elementAxes, elementVerts;

	if (element.type === 'line' || element.type === 'smooth') {
		for (let i = 0; i < points.length - 2; i += 2) {
			[elementAxes, elementVerts] = convertToPoly[element.type](points.slice(i), radius);
			if (testSeparatedAxes(eraserVerts, elementVerts, eraserAxes.concat(elementAxes))) {
				// found intersection with one segment, enough for result
				return true;
			}
		}
		// none of the segments intersect
		return false;
	} else if (element.type === 'ellipse') {
		[elementAxes, elementVerts] = convertToPoly[element.type](points, radius);
		return testSeparatedAxes(eraserVerts, elementVerts, eraserAxes.concat(elementAxes));
	} else if (element.type === 'image') {
		console.log('due to how I want images to be used on here, I\'m not allowing eraser interaction');
		return false;
	} else {
		console.error('erasing is not handled for type', element.type);
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
	rect: function(ctx, points, radius) {
		let [ax, ay, bx, by] = points;
		// apply padding outwards
		ax += ((ax > bx) * 2 - 1) * radius;
		ay += ((ay > by) * 2 - 1) * radius;
		bx += ((ax < bx) * 2 - 1) * radius;
		by += ((ay < by) * 2 - 1) * radius;

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
	ellipse: function(ctx, points) {
		let [x, y, rX, rY] = points;

		/*
		let q1off = [];

		// convert ellipse quadrant to path
		// https://stackoverflow.com/a/22707098/4704639
		const N = 12;
		for (let i = 0; i < N; i++) {
			let theta = (Math.PI / 2) * (i / N);
			let fi = (Math.PI / 2) - Math.atan(Math.tan(theta) * (rX / rY));
			q1off.push(rX * Math.cos(fi), rY * Math.sin(fi));
		}
		// last point
		q1off.push(rX * Math.cos(0), rY * Math.sin(0));
		
		ctx.beginPath();
		ctx.moveTo(x + q1off[0], y + q1off[1]);
		for (let i = 0; i <= N; i++) {
			ctx.lineTo(x + q1off[i * 2], y + q1off[i * 2 + 1]);
		}
		for (let i = N; i >= 0; i--) {
			ctx.lineTo(x + q1off[i * 2], y - q1off[i * 2 + 1]);
		}
		for (let i = 0; i <= N; i++) {
			ctx.lineTo(x - q1off[i * 2], y - q1off[i * 2 + 1]);
		}
		for (let i = N; i >= 0; i--) {
			ctx.lineTo(x - q1off[i * 2], y + q1off[i * 2 + 1]);
		}
		ctx.stroke();*/

		ctx.beginPath();
		ctx.ellipse(x, y, rX, rY, 0, 0, 2 * Math.PI);
		ctx.stroke();
	},
	image: function(ctx, body) {
		let [x, y, hash] = body;
		ctx.drawImage(state.images[hash], x, y);
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
	/*if (context.theme === 'light') {
		ctx.fillStyle = '#fff';
	} else {
		ctx.fillStyle = '#000';
	}*/
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, w, h);

	// translate position
	ctx.translate(context.offsetX, context.offsetY);

	// draw grid
	/*if (context.theme === 'light') {
		ctx.strokeStyle = '#ccc';
	} else {
		ctx.strokeStyle = '#222';
	}*/
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

	let ongoingSelect;
	let ongoingDraw = [];
	let ongoingMove = {};
	for (const [client, element] of Object.entries(state.ongoing)) {
		if (element.type === 'select') {
			// we only ever see our selection, no sharing
			ongoingSelect = element.data;
		} else if (element.type === 'freehand' || element.type === 'line' || element.type === 'arrow'
			|| element.type === 'rectangle' || element.type === 'ellipse') {
			ongoingDraw.push(element.data);
		} else if (element.type === 'move') {
			for (let i = 0; i < element.data.ids.length; i++) {
				ongoingMove[element.data.ids[i]] = element.data.offset;
			}
		} else if (element.type === 'copy') {
			for (let i = 0; i < element.data.ids.length; i++) {
				let id = element.data.ids[i];
				ongoingDraw.push(state.elements[id]);
				ongoingMove[id] = element.data.offset;
			}
		} else if (element.type === 'none' || element.type === 'eraser') {
			// all good, nothing to see here
		} else {
			console.error("ongoing element is not handled for type", element.type);
		}
	}
	
	for (const [id, element] of Object.entries(state.elements)) {
		let viewport_padding = 2; // px, scaled
		if (element.size) {
			viewport_padding += element.size;
		}
		let viewport_lower_x = (0 - context.offsetX - viewport_padding) / context.scale;
		let viewport_upper_x = (w - context.offsetX + viewport_padding) / context.scale;
		let viewport_lower_y = (0 - context.offsetY - viewport_padding) / context.scale;
		let viewport_upper_y = (h - context.offsetY + viewport_padding) / context.scale;
		let {lower_x, lower_y, upper_x, upper_y} = element.bounds;
		
		if (ongoingMove[id]) {
			lower_x -= ongoingMove[id][0];
			lower_y -= ongoingMove[id][1];
			upper_x -= ongoingMove[id][0];
			upper_y -= ongoingMove[id][1];
		}
		let inBounds = lower_x <= viewport_upper_x && upper_x >= viewport_lower_x
					&& lower_y <= viewport_upper_y && upper_y >= viewport_lower_y;

		// console.log(`${lower_x} <= ${viewport_upper_x} && ${upper_x} >= ${viewport_lower_x} && ${lower_y} <= ${viewport_upper_y} && ${upper_y} >= ${viewport_lower_y} === ${inBounds}`);

		if (inBounds) {
			// only draw elements potentially contained in viewport
			ctx.lineWidth = element.size;
			ctx.strokeStyle = element.colour;
			ctx.fillStyle = element.colour;
			let body = element.body;
			if (ongoingMove[id]) {
				if (element.type === 'line' || element.type === 'smooth') {
					body = element.body.map(function(x, i) {
						return x - ongoingMove[id][i % 2];
					});
				} else if (element.type === 'ellipse' || element.type === 'image') {
					body = element.body.slice();
					body[0] -= ongoingMove[id][0];
					body[1] -= ongoingMove[id][1];
				} else {
					console.error("move is not handled for type", element.type);
				}
			}
			drawObject[element.type](ctx, body);
		}
	}

	for (const element of ongoingDraw) {
		if (element.body.length >= 2) {
			ctx.lineWidth = element.size;
			ctx.strokeStyle = element.colour;
			ctx.fillStyle = element.colour;
			if (element.type) {
				drawObject[element.type](ctx, element.body);
			} else {
				console.log('received incomplete ongoing element');
			}
		}
	}

	if (ongoingSelect) {
		ctx.lineWidth = 2;
		ctx.strokeStyle = '#000';
		ctx.setLineDash([5, 5]);
		drawObject.rect(ctx, ongoingSelect, 0);
		ctx.setLineDash([]);
	}

	ctx.setLineDash([5, 5]);
	for (const id of state.selected) {
		let element = state.elements[id];
		let offset = 0;
		if (element.type === 'image') {
			ctx.lineWidth = 2.5;
			ctx.strokeStyle = '#f66';
			offset = 1;
		} else {
			ctx.lineWidth = 1.2;
			ctx.strokeStyle = '#666';
			offset = element.size / 2;
		}
		let {lower_x, lower_y, upper_x, upper_y} = element.bounds;
		if (ongoingMove[id]) {
			lower_x -= ongoingMove[id][0];
			lower_y -= ongoingMove[id][1];
			upper_x -= ongoingMove[id][0];
			upper_y -= ongoingMove[id][1];
		}
		drawObject.rect(ctx, [lower_x, lower_y, upper_x, upper_y], offset);
	}
	ctx.setLineDash([]);

	// redraw on next frame
	window.requestAnimationFrame(draw);
}
