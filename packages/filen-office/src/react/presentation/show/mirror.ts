import type { ShowController, ShowMirror } from "./controller"

// The presenter view's live copy of the stage: the player's host subtree reflected into a host in any same-origin
// document (the presenter's popup, or the page itself when the popup was blocked), exactly as the audience frame left
// it. Elements are copied shallow with their attributes and kept in step by a MutationObserver: its records are taken
// at the end of each player frame (so the copy changes in the frame the stage does) and otherwise in its own
// microtask. Nothing is sampled again; a frame's cost is the attributes it wrote. Canvases are copied at the copy's
// resolution (never above the stage's): a slide's layer bitmaps once, transition pieces, WebGL and tints on each
// player frame. A video is drawn from the playing element at each of its frames. Click targets, audio and controls
// are not copied, and the copy is inert.

const HTML_NS = "http://www.w3.org/1999/xhtml"
// Elements left out of the copy, with everything in them.
const SKIPPED = new Set(["button", "audio", "input", "select", "textarea", "iframe", "object", "embed", "script", "style", "link"])
const SKIPPED_CLASSES = ["fo-slide-hotspot", "fo-show-links", "fo-show-carried"] as const
// A mirrored canvas's side at most (device px).
const MAX_SIDE = 8192

interface CanvasCopy {
	readonly source: HTMLCanvasElement
	// Copied on every player frame (a transition's pieces, WebGL, tints); else when its size changes.
	readonly dynamic: boolean
}

interface VideoCopy {
	readonly source: HTMLVideoElement
	draw(): void
	stop(): void
}

function px(value: string | undefined): number {
	if (value === undefined || !value.endsWith("px")) return 0

	const number = Number.parseFloat(value)

	return Number.isFinite(number) ? number : 0
}

function isHtml(node: Node, name: string): boolean {
	return node.nodeType === 1 && (node as Element).localName === name && (node as Element).namespaceURI === HTML_NS
}

function skipped(element: Element): boolean {
	if (SKIPPED.has(element.localName)) return true

	const list = element.classList

	return SKIPPED_CLASSES.some(name => list.contains(name))
}

// The canvas copy of a source element (a canvas, a video) takes its look, not what it holds.
function copyLook(from: Element, to: HTMLElement): void {
	const style = from.getAttribute("style")
	const name = from.getAttribute("class")

	if (style === null) to.removeAttribute("style")
	else if (to.getAttribute("style") !== style) to.setAttribute("style", style)

	if (name === null) to.removeAttribute("class")
	else if (to.getAttribute("class") !== name) to.setAttribute("class", name)
}

export class StageMirror implements ShowMirror {
	private readonly source: HTMLElement
	private readonly target: HTMLElement
	private readonly document: Document
	private ratio: number
	// The stage's device px per slide px.
	private readonly sourceRatio: () => number
	private readonly onRelease: (() => void) | undefined
	private readonly observer: MutationObserver
	// Source node to its copy, and back.
	private readonly copies = new Map<Node, Node>()
	private readonly sources = new Map<Node, Node>()
	private readonly canvases = new Map<HTMLCanvasElement, CanvasCopy>()
	private readonly videos = new Map<HTMLCanvasElement, VideoCopy>()
	private released = false

	constructor(source: HTMLElement, target: HTMLElement, ratio: number, sourceRatio: () => number, onRelease?: () => void) {
		this.source = source
		this.target = target
		this.document = target.ownerDocument
		this.ratio = ratio
		this.sourceRatio = sourceRatio
		this.onRelease = onRelease

		const Observer = source.ownerDocument.defaultView?.MutationObserver ?? MutationObserver

		this.observer = new Observer(records => {
			this.sync(records)
		})
		this.observer.observe(source, { childList: true, subtree: true, attributes: true })
		this.target.style.visibility = source.style.visibility
		this.reconcile(source)
	}

	// The player's frame is written: the copy takes it now, and redraws what changes without a mutation.
	frame(): void {
		if (this.released) return

		this.sync(this.observer.takeRecords())

		for (const [copy, entry] of this.canvases) if (entry.dynamic) this.copyCanvas(entry.source, copy)
	}

	resize(ratio: number): void {
		if (this.released || ratio === this.ratio) return

		this.ratio = ratio

		for (const [copy, entry] of this.canvases) this.copyCanvas(entry.source, copy)
		for (const video of this.videos.values()) video.draw()
	}

	release(): void {
		if (this.released) return

		this.released = true
		this.observer.disconnect()

		for (const copy of this.canvases.keys()) {
			copy.width = 0
			copy.height = 0
		}

		for (const video of this.videos.values()) video.stop()

		this.canvases.clear()
		this.videos.clear()
		this.copies.clear()
		this.sources.clear()
		this.target.replaceChildren()
		this.target.style.visibility = ""
		this.onRelease?.()
	}

	// Copies (by source node) of the nodes the mirror holds: tests.
	copyOf(node: Node): Node | undefined {
		return this.copies.get(node)
	}

	private sync(records: readonly MutationRecord[]): void {
		if (this.released || records.length === 0) return

		const parents = new Set<Node>()
		const removed = new Set<Node>()
		const attributes = new Map<Element, Set<string>>()

		for (const record of records) {
			if (record.type === "childList") {
				parents.add(record.target)

				for (const node of record.removedNodes) removed.add(node)
			} else if (record.type === "attributes" && record.attributeName !== null) {
				const element = record.target as Element
				let names = attributes.get(element)

				if (names === undefined) {
					names = new Set()
					attributes.set(element, names)
				}

				names.add(record.attributeName)
			}
		}

		for (const parent of parents) this.reconcile(parent)

		// Moved nodes are still in the stage (their copies moved with them); the rest go.
		for (const node of removed) if (!this.source.contains(node)) this.forget(node)

		for (const [element, names] of attributes) this.attributes(element, names)
	}

	// The copy of `parent` holds the copies of its children, in order.
	private reconcile(parent: Node): void {
		const copy = parent === this.source ? this.target : this.copies.get(parent)

		if (copy === undefined || this.canvases.has(copy as HTMLCanvasElement) || this.videos.has(copy as HTMLCanvasElement)) return

		const children: Node[] = []

		for (const child of parent.childNodes) {
			const made = this.copyNode(child)

			if (made !== undefined) children.push(made)
		}

		const current = copy.childNodes

		if (current.length === children.length && children.every((child, k) => current[k] === child)) return

		;(copy as Element).replaceChildren(...children)
	}

	private copyNode(node: Node): Node | undefined {
		const held = this.copies.get(node)

		if (held !== undefined) return held

		let made: Node | undefined

		if (node.nodeType === 3) made = this.document.createTextNode((node as Text).data)
		else if (node.nodeType !== 1 || skipped(node as Element)) return undefined
		else if (isHtml(node, "canvas")) made = this.copyOfCanvas(node as HTMLCanvasElement)
		else if (isHtml(node, "video")) made = this.copyOfVideo(node as HTMLVideoElement)
		else made = this.document.importNode(node as Element, false)

		this.copies.set(node, made)
		this.sources.set(made, node)

		if (node.nodeType === 1 && !this.canvases.has(made as HTMLCanvasElement) && !this.videos.has(made as HTMLCanvasElement))
			this.reconcile(node)

		return made
	}

	private copyOfCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
		const copy = this.document.createElement("canvas")
		// A slide's layer bitmaps never change once drawn; what is drawn outside a slide box (a transition's pieces and
		// WebGL) and tints do.
		const dynamic = source.classList.contains("fo-show-tint") || source.closest("[data-fo-show-slide]") === null

		copyLook(source, copy)
		this.canvases.set(copy, { source, dynamic })
		this.copyCanvas(source, copy)

		return copy
	}

	// The source's pixels at the copy's resolution (by its CSS width at slide px when it has one).
	private copyCanvas(source: HTMLCanvasElement, copy: HTMLCanvasElement): void {
		const css = px(source.style.width)
		const sourceRatio = css > 0 && source.width > 0 ? source.width / css : this.sourceRatio()
		const scale = sourceRatio > 0 && this.ratio > 0 ? Math.min(1, this.ratio / sourceRatio) : 0
		const width = source.width === 0 ? 0 : Math.max(1, Math.min(MAX_SIDE, Math.round(source.width * scale)))
		const height = source.height === 0 ? 0 : Math.max(1, Math.min(MAX_SIDE, Math.round(source.height * scale)))

		if (scale === 0 || width === 0 || height === 0) {
			if (copy.width !== 0) copy.width = 0
			if (copy.height !== 0) copy.height = 0

			return
		}

		const resized = copy.width !== width || copy.height !== height

		if (copy.width !== width) copy.width = width
		if (copy.height !== height) copy.height = height

		const context = copy.getContext("2d")

		if (context === null) return

		if (!resized) context.clearRect(0, 0, width, height)

		try {
			context.drawImage(source, 0, 0, width, height)
		} catch {
			// A source with no backing store yet: blank until it has one.
		}
	}

	// A canvas in the video's place, drawn (object-fit: contain) at each frame the element presents.
	private copyOfVideo(source: HTMLVideoElement): HTMLCanvasElement {
		const copy = this.document.createElement("canvas")
		const view = source.ownerDocument.defaultView
		let frame = 0
		let raf = 0
		let stopped = false

		copyLook(source, copy)

		const draw = (): void => {
			if (stopped) return

			// The element fills its box (VIDEO_STYLE): the box's size at slide px, no layout read.
			const box = source.parentElement
			const width = Math.max(0, Math.min(MAX_SIDE, Math.round(px(box?.style.width) * this.ratio)))
			const height = Math.max(0, Math.min(MAX_SIDE, Math.round(px(box?.style.height) * this.ratio)))

			if (copy.width !== width) copy.width = width
			if (copy.height !== height) copy.height = height

			const context = width === 0 || height === 0 ? null : copy.getContext("2d")

			if (context === null) return

			context.clearRect(0, 0, width, height)

			const vw = source.videoWidth
			const vh = source.videoHeight

			// HAVE_CURRENT_DATA: a frame to draw.
			if (source.readyState < 2 || vw === 0 || vh === 0) return

			const fit = Math.min(width / vw, height / vh)
			const w = vw * fit
			const h = vh * fit

			try {
				context.drawImage(source, (width - w) / 2, (height - h) / 2, w, h)
			} catch {
				// Nothing decoded yet.
			}
		}
		const perFrame = typeof Reflect.get(source, "requestVideoFrameCallback") === "function"
		const onVideoFrame = (): void => {
			draw()

			if (!stopped) frame = source.requestVideoFrameCallback(onVideoFrame)
		}
		// Without video frame callbacks: the window's frames while it plays.
		const onAnimationFrame = (): void => {
			raf = 0
			draw()

			if (!stopped && !source.paused && view !== null) raf = view.requestAnimationFrame(onAnimationFrame)
		}
		const onPlay = (): void => {
			if (raf === 0 && view !== null) raf = view.requestAnimationFrame(onAnimationFrame)
		}
		const events = ["loadeddata", "seeked", "emptied", "pause", "ended"] as const

		for (const type of events) source.addEventListener(type, draw)

		if (perFrame) frame = source.requestVideoFrameCallback(onVideoFrame)
		else {
			source.addEventListener("play", onPlay)

			if (!source.paused) onPlay()
		}

		this.videos.set(copy, {
			source,
			draw,
			stop: () => {
				stopped = true

				for (const type of events) source.removeEventListener(type, draw)

				source.removeEventListener("play", onPlay)

				if (perFrame) source.cancelVideoFrameCallback(frame)
				if (raf !== 0) view?.cancelAnimationFrame(raf)

				copy.width = 0
				copy.height = 0
			}
		})
		draw()

		return copy
	}

	private attributes(element: Element, names: ReadonlySet<string>): void {
		if (element === this.source) {
			// The stage's own box is scaled for the audience: only whether the slide shows (black and white screens).
			if (names.has("style")) this.target.style.visibility = this.source.style.visibility

			return
		}

		const copy = this.copies.get(element) as Element | undefined

		if (copy === undefined) return

		const canvas = this.canvases.get(copy as HTMLCanvasElement)

		if (canvas !== undefined) {
			copyLook(element, copy as HTMLElement)

			if (names.has("width") || names.has("height") || names.has("style")) this.copyCanvas(canvas.source, copy as HTMLCanvasElement)

			return
		}

		const video = this.videos.get(copy as HTMLCanvasElement)

		if (video !== undefined) {
			copyLook(element, copy as HTMLElement)
			video.draw()

			return
		}

		for (const name of names) {
			const value = element.getAttribute(name)

			if (value === null) copy.removeAttribute(name)
			else if (copy.getAttribute(name) !== value) copy.setAttribute(name, value)
		}
	}

	// A node gone from the stage: its copy and everything copied in it.
	private forget(node: Node): void {
		const copy = this.copies.get(node)

		if (copy === undefined) return

		const stack: Node[] = [copy]

		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			const source = this.sources.get(next)

			if (source !== undefined) {
				this.copies.delete(source)
				this.sources.delete(next)
			}

			const canvas = next as HTMLCanvasElement

			if (this.canvases.delete(canvas)) {
				canvas.width = 0
				canvas.height = 0
			}

			this.videos.get(canvas)?.stop()
			this.videos.delete(canvas)
			stack.push(...next.childNodes)
		}

		;(copy as ChildNode).remove()
	}
}

// Keeps one copy of the stage in the presenter's view, on whichever controller drives the show: a player that
// re-renders hands over a new controller, and the view may mount before or after it. A ref callback detached and
// attached again with the same controller in one commit keeps the copy (it is released in a microtask only when no
// controller came back).
export class ShowMirrorLink {
	private controller: ShowController | undefined
	private target: HTMLElement | undefined
	private ratio = 0
	private mirror: ShowMirror | undefined
	// What the copy was made from.
	private linked: { readonly controller: ShowController; readonly target: HTMLElement } | undefined

	connect(controller: ShowController): void {
		this.controller = controller
		this.settle()
	}

	// Only while `controller` is the one connected (a newer one may have taken its place).
	disconnect(controller: ShowController): void {
		if (controller !== this.controller) return

		this.controller = undefined
		queueMicrotask(() => {
			this.settle()
		})
	}

	// The view's host at `ratio` device px per slide px; undefined when it unmounts.
	view(target: HTMLElement | undefined, ratio = this.ratio): void {
		this.ratio = ratio
		this.target = target
		this.settle()
	}

	resize(ratio: number): void {
		this.view(this.target, ratio)
	}

	private settle(): void {
		const controller = this.controller
		const target = this.target

		if (this.linked !== undefined && this.linked.controller === controller && this.linked.target === target) {
			this.mirror?.resize(this.ratio)

			return
		}

		this.mirror?.release()
		this.mirror = controller === undefined || target === undefined ? undefined : controller.mirror?.(target, this.ratio)
		this.linked = this.mirror === undefined || controller === undefined || target === undefined ? undefined : { controller, target }
	}
}
