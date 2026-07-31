/**
 * Selection ergonomics for the text layer.
 *
 * pdf.js splits this work in two. `TextLayer` (in the core build) lays out the transparent text runs,
 * and `TextLayerBuilder` (in the viewer application) makes selecting them behave like selecting text
 * in a document. We ship the first and deliberately not the second — the viewer defaults scripting on
 * and carries a link service that would bypass this app's link funnel — so this half has to be
 * reimplemented here.
 *
 * What it does, and why each piece exists:
 *
 * A page's text runs are absolutely positioned boxes with no natural flow between them, so a drag
 * that leaves the last run has nothing to anchor to and the engine falls back to selecting the whole
 * block. The `.endOfContent` element is the anchor: it normally sits just below the layer
 * (`inset: 100% 0 0`) and is unselectable, and while a selection is in progress the `selecting` class
 * pulls it up to cover the layer so the selection has somewhere to end.
 *
 * The repositioning below is WebKit-specific, and skipping it is exactly why selection behaved on
 * Android and not on iOS: Chromium and Firefox handle this natively and pdf.js returns early for
 * them. On WebKit the anchor has to be physically moved next to the current selection boundary on
 * every `selectionchange`, or a drag selects an entire page — or the entire document.
 *
 * Kept free of pdfjs and native imports so it can be tested against a real DOM.
 */

const textLayers = new Map<HTMLElement, HTMLElement>()

let installed = false
let isPointerDown = false
let previousRange: Range | null = null

/**
 * Whether this engine needs the anchor repositioned by hand. Chromium 148+ and Firefox do it
 * natively; everything else — notably every WebKit build — does not.
 */
function needsManualAnchor(): boolean {
	const chromium = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1]

	return !(chromium && parseInt(chromium, 10) >= 148)
}

function reset(layer: HTMLElement, end: HTMLElement): void {
	layer.append(end)

	end.style.width = ""
	end.style.height = ""
	end.style.userSelect = ""

	layer.classList.remove("selecting")
}

function resetAll(): void {
	for (const [layer, end] of textLayers) {
		reset(layer, end)
	}
}

function onSelectionChange(): void {
	const selection = document.getSelection()

	if (!selection || selection.rangeCount === 0) {
		resetAll()

		return
	}

	// Mark every layer the selection currently touches, and release the ones it does not, so a
	// selection dragged off a page does not leave that page stuck in the selecting state.
	const active = new Set<HTMLElement>()

	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index)

		for (const layer of textLayers.keys()) {
			if (!active.has(layer) && range.intersectsNode(layer)) {
				active.add(layer)
			}
		}
	}

	for (const [layer, end] of textLayers) {
		if (active.has(layer)) {
			layer.classList.add("selecting")
		} else {
			reset(layer, end)
		}
	}

	if (!needsManualAnchor()) {
		return
	}

	const range = selection.getRangeAt(0)
	// Which end of the selection the user is dragging. If the far boundary is unchanged, they are
	// moving the start; otherwise the end.
	const modifyStart =
		previousRange !== null &&
		(range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
			range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0)

	let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer

	if (anchor.nodeType === Node.TEXT_NODE) {
		anchor = anchor.parentNode
	}

	if (anchor instanceof Element && anchor.classList.contains("highlight")) {
		anchor = anchor.parentNode
	}

	// A boundary at offset 0 belongs to the previous run, not this one — walk back to it, or the
	// anchor lands one run too far and the selection jumps.
	if (!modifyStart && range.endOffset === 0) {
		while (anchor !== null) {
			while (anchor !== null && !anchor.previousSibling) {
				anchor = anchor.parentNode
			}

			anchor = anchor?.previousSibling ?? null

			if (anchor === null || anchor.childNodes.length > 0) {
				break
			}
		}
	}

	if (!(anchor instanceof Element) && !(anchor instanceof Node)) {
		return
	}

	const parentElement = anchor instanceof Element ? anchor.parentElement : anchor?.parentElement
	const layer = parentElement?.closest(".textLayer")

	if (!(layer instanceof HTMLElement)) {
		return
	}

	const end = textLayers.get(layer)

	if (!end || !parentElement) {
		return
	}

	end.style.width = layer.style.width
	end.style.height = layer.style.height
	end.style.userSelect = "text"

	parentElement.insertBefore(end, modifyStart ? anchor : (anchor?.nextSibling ?? null))

	previousRange = range.cloneRange()
}

function install(): void {
	if (installed) {
		return
	}

	installed = true

	document.addEventListener("pointerdown", () => {
		isPointerDown = true
	})

	document.addEventListener("pointerup", () => {
		isPointerDown = false

		resetAll()
	})

	window.addEventListener("blur", () => {
		isPointerDown = false

		resetAll()
	})

	document.addEventListener("keyup", () => {
		if (!isPointerDown) {
			resetAll()
		}
	})

	document.addEventListener("selectionchange", onSelectionChange)
}

/**
 * Give a rendered text layer its selection anchor. Returns a detach function; call it when the page
 * is released, or the map retains a layer whose DOM is gone.
 */
export function attachTextLayerSelection(layer: HTMLElement): () => void {
	const end = document.createElement("div")

	end.className = "endOfContent"

	layer.append(end)

	textLayers.set(layer, end)

	const onMouseDown = () => {
		layer.classList.add("selecting")
	}

	layer.addEventListener("mousedown", onMouseDown)

	install()

	return () => {
		layer.removeEventListener("mousedown", onMouseDown)

		textLayers.delete(layer)
	}
}
