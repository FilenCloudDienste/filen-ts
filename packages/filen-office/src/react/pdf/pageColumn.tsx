import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react"
import {
	pageMatchRange,
	pdfBox,
	pdfCanvasDims,
	pdfLinks,
	pdfPageAction,
	pdfPageRotation,
	pdfRenderRatio,
	pdfRenderTransform,
	resolveDestination,
	PDF_PAGE_EVICT_MARGIN_PX,
	PDF_PAGE_RENDER_MARGIN_PX,
	PDF_ZOOM_RENDER_DELAY_MS,
	type PdfDestination,
	type PdfPage as PdfPageProxy,
	type PdfRect,
	type PdfRenderTask,
	type PdfViewport
} from "../../dom/pdf/index"
import { paintMatches } from "./highlight"
import type { PdfDomDocument, PdfJsDom, PdfTextLayer } from "./types"

// The page column, unstyled, for either engine: a document is anything with pdf.js's page contract (PdfDomDocument:
// viewports, rendering into a canvas, text content, annotations), pdf.js's own or the editor's MuPDF one
// (react/pdfedit). Every page gets a sized wrapper at once (so the scroll height is right), and only pages near the
// view hold a canvas, a text layer and links. A page renders once it nears the view and releases its canvas, text
// layer and engine resources once it is far away again, so a long document never holds more than a screenful or so of
// bitmaps. Three IntersectionObservers serve all pages. A page reads its page only once it nears the view (a long
// document opens without a worker round trip per page); until then it is sized from page 1, as pdf.js's own viewer
// does. Pages near the view but outside it wait until a page in it has painted, so the first paint has the file's
// reads and pdf.js's worker to itself. A new document (the editor taking over from the viewer) keeps every page's size and painted bitmap until its
// own page has been read and drawn, so the view neither jumps nor blanks.

// The largest canvas a page allocates: WebKit refuses canvases over 16,777,216 pixels, and a large page zoomed
// in on a high-density screen would pass that. Above it the page renders at a lower pixel ratio.
export const PDF_MAX_PAGE_CANVAS_BYTES = 64 * 1024 * 1024

// Joined to the package's own classes, which @filen/office/css/pdf.css styles (the host imports it).
export interface PdfPagesClassNames {
	readonly column?: string
	readonly page?: string
	// `painted`: the canvas holds a bitmap to show (after a zoom, the previous one stretched until the sharper one
	// replaces it).
	readonly canvas?: (painted: boolean) => string
	readonly textLayer?: string
	readonly link?: string
}

export interface PdfPagesFind {
	// All matches (PDF_FIND_INTS each), or null.
	readonly matches: Int32Array | null
	readonly active: number
	// Changes each time the active match should be scrolled to.
	readonly reveal: number
}

export interface PdfPagesBinding {
	readonly document: PdfDomDocument
	readonly scale: number
	// The view's turn, added to each page's own /Rotate (0, 90, 180 or 270).
	readonly rotation: number
	readonly find: PdfPagesFind
	readonly scrollerRef: RefObject<HTMLDivElement | null>
	readonly registerPage: (page: number, element: HTMLElement | null) => void
	// An in-document link was followed.
	readonly onNavigate: (to: PdfDestination) => void
}

// What a host draws over a page (an editor's form fields and tools): given the page's viewport, which maps the page's
// bottom-left user space to its box; shown while the page is near the view.
export type PdfPageOverlay = (page: number, viewport: PdfViewport) => ReactNode

export interface PdfPagesProps extends PdfPagesBinding {
	readonly pdfjs: PdfJsDom
	readonly className?: string
	readonly classNames?: PdfPagesClassNames
	// The canvas's accessible name and an in-document link's (the page it leads to).
	readonly pageLabel: (page: number, total: number) => string
	// Shown over a page until its canvas has painted.
	readonly placeholder?: ReactNode
	// Narrows the shared link policy for external links (never widens it).
	readonly allowLink?: (url: string) => boolean
	readonly maxCanvasBytes?: number
	// The scroller's (-1: focusable from code, so a closed find bar can hand focus back).
	readonly tabIndex?: number
	// On the scroller: a host's link handling (external links are anchors with target _blank).
	readonly onClick?: (event: MouseEvent<HTMLDivElement>) => void
	readonly onAuxClick?: (event: MouseEvent<HTMLDivElement>) => void
	readonly overlay?: PdfPageOverlay
}

// A page's size before page 1 has been read.
const DEFAULT_PAGE_WIDTH = 300
const DEFAULT_PAGE_HEIGHT = 400

function classes(own: string, host: string | undefined): string {
	return host === undefined || host.length === 0 ? own : `${own} ${host}`
}

type EntryHandler = (entry: IntersectionObserverEntry) => void

// The observers for every page: one at the render margin (the render gate), one at the evict margin and one at the
// view itself (a page in view renders at once). The page in view is measured by the viewer from the page boxes, not
// from these. Pages register before the scroller attaches (children's effects run first); they are observed once it
// does.
class PageWatcher {
	private readonly renders = new Map<Element, EntryHandler>()
	private readonly evicts = new Map<Element, EntryHandler>()
	private readonly shows = new Map<Element, EntryHandler>()
	private render: IntersectionObserver | null = null
	private evict: IntersectionObserver | null = null
	private shown: IntersectionObserver | null = null
	// Open once a page has painted (or its render settled otherwise); until then pages in the render margin wait.
	private painted = false
	private readonly waiting = new Set<() => void>()

	attach(root: Element): void {
		const dispatch =
			(handlers: Map<Element, EntryHandler>) =>
			(entries: IntersectionObserverEntry[]): void => {
				for (const entry of entries) handlers.get(entry.target)?.(entry)
			}

		this.render = new IntersectionObserver(dispatch(this.renders), { root, rootMargin: `${String(PDF_PAGE_RENDER_MARGIN_PX)}px 0px` })
		this.evict = new IntersectionObserver(dispatch(this.evicts), { root, rootMargin: `${String(PDF_PAGE_EVICT_MARGIN_PX)}px 0px` })
		this.shown = new IntersectionObserver(dispatch(this.shows), { root })

		for (const element of this.renders.keys()) {
			this.render.observe(element)
			this.evict.observe(element)
			this.shown.observe(element)
		}
	}

	detach(): void {
		this.render?.disconnect()
		this.evict?.disconnect()
		this.shown?.disconnect()
		this.render = null
		this.evict = null
		this.shown = null
	}

	watch(element: Element, onRender: EntryHandler, onEvict: EntryHandler, onShow: EntryHandler): () => void {
		this.renders.set(element, onRender)
		this.evicts.set(element, onEvict)
		this.shows.set(element, onShow)
		this.render?.observe(element)
		this.evict?.observe(element)
		this.shown?.observe(element)

		return () => {
			this.renders.delete(element)
			this.evicts.delete(element)
			this.shows.delete(element)
			this.render?.unobserve(element)
			this.evict?.unobserve(element)
			this.shown?.unobserve(element)
		}
	}

	// Runs `run` once a page has painted (at once if one has); the returned function drops it.
	afterFirstPaint(run: () => void): () => void {
		if (this.painted) {
			run()

			return () => undefined
		}

		this.waiting.add(run)

		return () => {
			this.waiting.delete(run)
		}
	}

	// A page's render settled: drawn or failed (a page that cannot paint never holds the others back).
	settled(): void {
		if (this.painted) return

		this.painted = true

		for (const run of [...this.waiting]) run()

		this.waiting.clear()
	}
}

// pdf.js's text-selection aid (TextLayerBuilder and its global selection listener). The layer is spans with gaps
// between them; with nothing under the pointer in a gap, Chromium snaps a drag selection to the layer's start or
// end. Each layer ends in an .endOfContent block that covers the whole layer while a selection is made in it
// (.selecting, pdf.css), and where the browser needs it (not Firefox, not Chromium 148+) it moves next to the
// selection's moving end. One set of document listeners serves every page's layer.
const selectionLayers = new Map<HTMLElement, HTMLElement>()
let selectionListeners: AbortController | null = null
// Firefox or Chromium 148+, which select across the gaps by themselves; read once, on the first change.
let selectsAcrossGaps: boolean | undefined
let previousRange: Range | null = null

function resetSelection(end: HTMLElement, layer: HTMLElement): void {
	layer.append(end)
	end.style.width = ""
	end.style.height = ""
	end.style.userSelect = ""
	layer.classList.remove("selecting")
}

function resetSelections(): void {
	selectionLayers.forEach(resetSelection)
}

function chromiumMajor(): number | null {
	const data: unknown = Reflect.get(navigator, "userAgentData")
	const brands: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "brands") : undefined

	if (Array.isArray(brands)) {
		for (const brand of brands as unknown[]) {
			if (typeof brand === "object" && brand !== null && Reflect.get(brand, "brand") === "Chromium") {
				const version = Number.parseInt(String(Reflect.get(brand, "version")), 10)

				return Number.isFinite(version) ? version : null
			}
		}

		return null
	}

	const match = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)

	return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

function onSelectionChange(): void {
	const selection = globalThis.document.getSelection()

	if (selection === null || selection.rangeCount === 0) {
		resetSelections()

		return
	}

	const active = new Set<HTMLElement>()

	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index)

		for (const layer of selectionLayers.keys()) {
			if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer)
		}
	}

	for (const [layer, end] of selectionLayers) {
		if (active.has(layer)) layer.classList.add("selecting")
		else resetSelection(end, layer)
	}

	if (selectsAcrossGaps === undefined) {
		const first = selectionLayers.values().next().value

		// pdf.css gives .endOfContent -moz-user-select: none, which only Firefox reports back.
		selectsAcrossGaps =
			(first !== undefined && getComputedStyle(first).getPropertyValue("-moz-user-select") === "none") ||
			(chromiumMajor() ?? 0) >= 148
	}

	if (selectsAcrossGaps) return

	const range = selection.getRangeAt(0)
	const modifyStart =
		previousRange !== null &&
		(range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
			range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0)
	let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer

	if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode

	if (anchor instanceof Element && anchor.classList.contains("highlight")) anchor = anchor.parentNode

	if (!modifyStart && range.endOffset === 0) {
		do {
			while (anchor !== null && anchor.previousSibling === null) anchor = anchor.parentNode

			anchor = anchor?.previousSibling ?? null
		} while (anchor !== null && anchor.childNodes.length === 0)
	}

	const parent = anchor?.parentElement ?? null
	const layer = parent?.closest<HTMLElement>(".fo-pdf-text-layer") ?? null
	const end = layer === null ? undefined : selectionLayers.get(layer)

	if (anchor !== null && parent !== null && layer !== null && end !== undefined) {
		end.style.width = layer.style.width
		end.style.height = layer.style.height
		end.style.userSelect = "text"
		parent.insertBefore(end, modifyStart ? anchor : anchor.nextSibling)
	}

	previousRange = range.cloneRange()
}

function watchSelection(layer: HTMLElement, end: HTMLElement): () => void {
	const onPointerDown = (): void => {
		layer.classList.add("selecting")
	}

	layer.addEventListener("mousedown", onPointerDown)
	selectionLayers.set(layer, end)

	if (selectionListeners === null) {
		const listeners = new AbortController()
		const { signal } = listeners
		let pointerDown = false

		selectionListeners = listeners
		globalThis.document.addEventListener(
			"pointerdown",
			() => {
				pointerDown = true
			},
			{ signal }
		)
		globalThis.document.addEventListener(
			"pointerup",
			() => {
				pointerDown = false
				resetSelections()
			},
			{ signal }
		)
		window.addEventListener(
			"blur",
			() => {
				pointerDown = false
				resetSelections()
			},
			{ signal }
		)
		globalThis.document.addEventListener(
			"keyup",
			() => {
				if (!pointerDown) resetSelections()
			},
			{ signal }
		)
		globalThis.document.addEventListener("selectionchange", onSelectionChange, { signal })
	}

	return () => {
		layer.removeEventListener("mousedown", onPointerDown)
		layer.classList.remove("selecting")
		selectionLayers.delete(layer)

		if (selectionLayers.size === 0) {
			selectionListeners?.abort()
			selectionListeners = null
			previousRange = null
		}
	}
}

export function PdfPageColumn({
	pdfjs,
	document,
	scale,
	rotation,
	find,
	scrollerRef,
	registerPage,
	onNavigate,
	className,
	classNames,
	pageLabel,
	placeholder,
	allowLink,
	maxCanvasBytes,
	tabIndex,
	onClick,
	onAuxClick,
	overlay
}: PdfPagesProps) {
	const total = document.numPages
	const [watcher] = useState(() => new PageWatcher())
	const pages = Array.from({ length: total }, (_, index) => index + 1)
	// Page 1, which sizes every page not read yet (pdf.js caches the page, so its own view reads it again free). A new
	// document's page 1 replaces the previous one's once read, so unread pages keep their size meanwhile.
	// null for a page 1 that could not be read (the unread pages keep the default size).
	const [first, setFirst] = useState<{ readonly document: PdfDomDocument; readonly page: PdfPageProxy<ReadableStream> | null } | null>(
		null
	)
	const firstPage = first?.page ?? null
	const fallback = firstPage?.getViewport({ scale, rotation: pdfPageRotation(firstPage.rotate, rotation) })
	// The pages are watched once they have their size: laid out at the default size, more of them would sit near the
	// view for a moment, and each one that does reads its page (and starts rendering it) for good.
	const sized = first !== null

	useEffect(() => {
		let live = true

		void document.getPage(1).then(
			page => {
				if (live) setFirst({ document, page })
			},
			() => {
				if (live) setFirst(previous => previous ?? { document, page: null })
			}
		)

		return () => {
			live = false
		}
	}, [document])

	useEffect(() => {
		const root = scrollerRef.current

		if (root === null || !sized) return

		watcher.attach(root)

		return () => {
			watcher.detach()
		}
	}, [watcher, scrollerRef, sized])

	return (
		<div
			ref={scrollerRef}
			className={className}
			tabIndex={tabIndex}
			onClick={onClick}
			onAuxClick={onAuxClick}
		>
			<div className={classNames?.column}>
				{pages.map(page => {
					const [from, to] = find.matches === null ? [0, 0] : pageMatchRange(find.matches, page)
					const active = find.active >= from && find.active < to ? find.active : -1

					return (
						<PdfPageView
							key={page}
							pdfjs={pdfjs}
							document={document}
							page={page}
							total={total}
							scale={scale}
							rotation={rotation}
							watcher={watcher}
							matches={from < to ? find.matches : null}
							from={from}
							to={to}
							active={active}
							reveal={active >= 0 ? find.reveal : 0}
							classNames={classNames}
							pageLabel={pageLabel}
							placeholder={placeholder}
							allowLink={allowLink}
							maxCanvasBytes={maxCanvasBytes ?? PDF_MAX_PAGE_CANVAS_BYTES}
							fallbackWidth={fallback?.width ?? DEFAULT_PAGE_WIDTH}
							fallbackHeight={fallback?.height ?? DEFAULT_PAGE_HEIGHT}
							registerPage={registerPage}
							onNavigate={onNavigate}
							overlay={overlay}
						/>
					)
				})}
			</div>
		</div>
	)
}

type PageLink =
	| { readonly kind: "external"; readonly rect: PdfRect; readonly url: string }
	| { readonly kind: "internal"; readonly rect: PdfRect; readonly to: PdfDestination }

function viewportPoint(point: readonly unknown[]): readonly [number, number] {
	const [x, y] = point

	return [typeof x === "number" ? x : 0, typeof y === "number" ? y : 0]
}

// pdf.js sizes the text layer from the page's unscaled box with these (round(down, var(--total-scale-factor) *
// <px>, var(--scale-round-x))); all three must be set or the declaration is invalid. The page's UserUnit is
// folded in, as the viewport the canvas and links use already carries it.
export function pdfTextLayerVars(scale: number, userUnit: number): CSSProperties {
	return { "--total-scale-factor": String(scale * userUnit), "--scale-round-x": "1px", "--scale-round-y": "1px" } as CSSProperties
}

interface PdfPageViewProps {
	readonly pdfjs: PdfJsDom
	readonly document: PdfDomDocument
	readonly page: number
	readonly total: number
	readonly scale: number
	readonly rotation: number
	readonly watcher: PageWatcher
	readonly matches: Int32Array | null
	readonly from: number
	readonly to: number
	readonly active: number
	readonly reveal: number
	readonly classNames: PdfPagesClassNames | undefined
	readonly pageLabel: (page: number, total: number) => string
	readonly placeholder: ReactNode
	readonly allowLink: ((url: string) => boolean) | undefined
	readonly maxCanvasBytes: number
	// The size until this page has been read: page 1's at the current scale and turn.
	readonly fallbackWidth: number
	readonly fallbackHeight: number
	readonly registerPage: (page: number, element: HTMLElement | null) => void
	readonly onNavigate: (to: PdfDestination) => void
	readonly overlay: PdfPageOverlay | undefined
}

function PdfPageView({
	pdfjs,
	document,
	page: pageNumber,
	total,
	scale,
	rotation,
	watcher,
	matches,
	from,
	to,
	active,
	reveal,
	classNames,
	pageLabel,
	placeholder,
	allowLink,
	maxCanvasBytes,
	fallbackWidth,
	fallbackHeight,
	registerPage,
	onNavigate,
	overlay
}: PdfPageViewProps) {
	const wrapperRef = useRef<HTMLDivElement | null>(null)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const textRef = useRef<HTMLDivElement | null>(null)
	const layerRef = useRef<PdfTextLayer | null>(null)
	const proxyRef = useRef<PdfPageProxy<ReadableStream> | null>(null)
	const linksFor = useRef<PdfPageProxy<ReadableStream> | null>(null)
	const revealed = useRef(0)
	// The page as last read, and the document it was read from: a new document's page replaces it once read, and
	// sizes the page meanwhile.
	const [loaded, setLoaded] = useState<{ readonly document: PdfDomDocument; readonly page: PdfPageProxy<ReadableStream> } | null>(null)
	// The page as last read. An engine may hand out the same page object for a new document (the editor's, after a change
	// elsewhere): what it painted stays current then.
	const proxy = loaded?.page ?? null
	// Read from the document shown (a page of the previous one only sizes and shows its bitmap until replaced).
	const fresh = loaded !== null && loaded.document === document
	// Set the first time the page nears the view, never cleared: the gate that keeps a long document from
	// rendering every page at open. Page 1 starts open, so the first paint waits for no observer.
	const [nearView, setNearView] = useState(pageNumber === 1)
	// Within the evict margin.
	const [inView, setInView] = useState(false)
	// The page, scale and turn the canvas was painted at, or null; a zoom, a turn or a new page makes it stale in the
	// same render.
	const [paintedAt, setPaintedAt] = useState<{
		readonly page: PdfPageProxy<ReadableStream>
		readonly scale: number
		readonly rotation: number
	} | null>(null)
	// Bumped when a text layer has rendered, for the find highlights.
	const [textEpoch, setTextEpoch] = useState(0)
	const [links, setLinks] = useState<readonly PageLink[]>([])
	const rendered = paintedAt !== null && paintedAt.page === proxy && paintedAt.scale === scale && paintedAt.rotation === rotation
	// The canvas holds a bitmap at this turn: a zoom keeps it on screen, stretched to the new size, until the sharper
	// one replaces it. A turn does not (stretched across, it would be distorted).
	const painted = paintedAt !== null && paintedAt.rotation === rotation
	// The scale and turn a new text layer is laid out at; later changes reach it through update().
	const layoutRef = useRef({ scale, rotation })

	// Read once the page nears the view, not at open: pdf.js's worker answers one page read at a time, and N reads
	// queued at open would hold up the first paint (and fetch every page's data from a ranged source).
	useEffect(() => {
		if (!nearView) return

		let live = true

		void document.getPage(pageNumber).then(
			resolved => {
				if (live) {
					proxyRef.current = resolved
					setLoaded({ document, page: resolved })
				}
			},
			() => {
				// A page that cannot be read stays a blank placeholder; the document opened, so the rest still shows.
			}
		)

		return () => {
			live = false
			proxyRef.current = null
		}
	}, [document, pageNumber, nearView])

	useEffect(() => {
		const element = wrapperRef.current

		if (element === null) return

		registerPage(pageNumber, element)

		const near = (): void => {
			setNearView(true)
		}
		let waiting: (() => void) | null = null
		const unwatch = watcher.watch(
			element,
			entry => {
				waiting?.()
				waiting = entry.isIntersecting ? watcher.afterFirstPaint(near) : null
			},
			entry => {
				setInView(entry.isIntersecting)

				if (!entry.isIntersecting) {
					// Released here, in the observer's callback, whether or not the render finished: a cancelled
					// render had already sized the canvas.
					const canvas = canvasRef.current

					if (canvas !== null) {
						canvas.width = 0
						canvas.height = 0
					}

					// pdf.js defers this until a cancelled render settles; a re-entry fetches the operators again.
					proxyRef.current?.cleanup()
					setPaintedAt(null)
				}
			},
			entry => {
				if (entry.isIntersecting) near()
			}
		)

		return () => {
			waiting?.()
			unwatch()
			registerPage(pageNumber, null)
		}
	}, [watcher, pageNumber, registerPage])

	useEffect(() => {
		const canvas = canvasRef.current

		if (proxy === null || !fresh || !nearView || canvas === null || pdfPageAction(inView, rendered) !== "render") return

		let cancelled = false
		let task: PdfRenderTask | null = null
		// While the canvas shows a stale bitmap the new one renders offscreen and is copied over in one step: sizing
		// the canvas itself would clear it for the whole render.
		let offscreen: HTMLCanvasElement | null = null

		const start = (): void => {
			const viewport = proxy.getViewport({ scale, rotation: pdfPageRotation(proxy.rotate, rotation) })
			const ratio = pdfRenderRatio(viewport.width, viewport.height, window.devicePixelRatio, maxCanvasBytes)
			const dims = pdfCanvasDims(viewport.width, viewport.height, ratio)
			const target = painted ? canvas.ownerDocument.createElement("canvas") : canvas

			if (target !== canvas) offscreen = target

			target.width = dims.bufferWidth
			target.height = dims.bufferHeight
			task = proxy.render({ canvas: target, viewport, transform: pdfRenderTransform(ratio) })
			task.promise.then(
				() => {
					if (cancelled) return

					if (target !== canvas) {
						canvas.width = dims.bufferWidth
						canvas.height = dims.bufferHeight
						canvas.getContext("2d")?.drawImage(target, 0, 0)
						target.width = 0
						target.height = 0
						offscreen = null
					}

					setPaintedAt({ page: proxy, scale, rotation })
					watcher.settled()
				},
				() => {
					// A cancelled render (scrolled away, zoomed) rejects too. A page that fails to render stays a
					// placeholder; the document opened, so the rest still shows. Only a render this effect cancelled keeps
					// the others waiting: a page in view takes its place.
					if (!cancelled) watcher.settled()
				}
			)
		}

		// A stale bitmap stays up while zoom steps keep coming; the render starts once they pause.
		const timer = painted ? setTimeout(start, PDF_ZOOM_RENDER_DELAY_MS) : null

		if (timer === null) start()

		return () => {
			cancelled = true

			if (timer !== null) clearTimeout(timer)

			task?.cancel()

			if (offscreen !== null) {
				offscreen.width = 0
				offscreen.height = 0
			}
		}
	}, [proxy, fresh, nearView, inView, rendered, painted, scale, rotation, maxCanvasBytes, watcher])

	// Before the text layer's effect, which reads it.
	useEffect(() => {
		layoutRef.current = { scale, rotation }
	}, [scale, rotation])

	// Its own effect, not the canvas's: that one re-runs as soon as its render resolves (`rendered` changes), and a
	// text layer torn down there would be gone right after every paint. Built once while the page stays near the
	// view (a zoom or a turn re-lays out its spans below, without reading the text again); leaving the evict margin
	// tears it down.
	useEffect(() => {
		const container = textRef.current

		if (proxy === null || !nearView || !inView || container === null) return

		const layout = layoutRef.current
		const layer = new pdfjs.TextLayer({
			textContentSource: proxy.streamTextContent(),
			container,
			viewport: proxy.getViewport({ scale: layout.scale, rotation: pdfPageRotation(proxy.rotate, layout.rotation) })
		})
		let unwatch: (() => void) | null = null

		layerRef.current = layer
		layer.render().then(
			() => {
				if (layerRef.current !== layer) return

				// pdf.js's selection aid (TextLayerBuilder): see watchSelection.
				const end = container.ownerDocument.createElement("div")

				end.className = "endOfContent"
				container.append(end)
				unwatch = watchSelection(container, end)
				setTextEpoch(epoch => epoch + 1)
			},
			() => {
				// The page stays readable, only not selectable.
			}
		)

		return () => {
			layer.cancel()
			layerRef.current = null
			unwatch?.()
			// render() appends as it streams and the constructor never clears, so a rebuild would stack spans.
			container.replaceChildren()
		}
	}, [pdfjs, proxy, nearView, inView])

	// A zoom or a turn re-lays out the spans in place, once the steps pause as the canvas does (it measures every
	// span again); meanwhile --total-scale-factor resizes them. The selection and the find highlights stay.
	useEffect(() => {
		if (proxy === null || layerRef.current === null) return

		const timer = setTimeout(() => {
			layerRef.current?.update({ viewport: proxy.getViewport({ scale, rotation: pdfPageRotation(proxy.rotate, rotation) }) })
		}, PDF_ZOOM_RENDER_DELAY_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [proxy, scale, rotation])

	// Matches painted into the text layer; the active one is scrolled to when `reveal` asks.
	useEffect(() => {
		const layer = layerRef.current

		if (layer === null || matches === null || textEpoch === 0) return

		const painted = paintMatches(layer.textDivs, layer.textContentItemsStr, matches, from, to, active)

		if (reveal !== 0 && reveal !== revealed.current && painted.selected !== null) {
			revealed.current = reveal
			painted.selected.scrollIntoView({ block: "center", inline: "nearest" })
		}

		return painted.restore
	}, [textEpoch, matches, from, to, active, reveal])

	// The active match is on a page whose text is not there yet: bring the page into view, which renders it.
	useEffect(() => {
		if (reveal === 0 || reveal === revealed.current || (layerRef.current !== null && textEpoch > 0)) return

		wrapperRef.current?.scrollIntoView({ block: "start" })
	}, [reveal, textEpoch])

	// Fetched once per page, when it first nears the view (one worker round trip per page read, not per page at
	// open). Kept when the page leaves the view: the round trip is paid already.
	useEffect(() => {
		if (proxy === null || !inView || linksFor.current === proxy) return

		linksFor.current = proxy

		void proxy
			.getAnnotations({ intent: "display" })
			.then(async annotations => {
				const found = await Promise.all(
					pdfLinks(annotations, allowLink).map(async (link): Promise<PageLink | null> => {
						if (link.kind === "external") return link

						const target = await resolveDestination(document, link.dest)

						return target === null ? null : { kind: "internal", rect: link.rect, to: target }
					})
				)

				if (linksFor.current === proxy) setLinks(found.filter(link => link !== null))
			})
			.catch(() => {
				// The page still shows, without its links.
			})
	}, [document, proxy, inView, allowLink])

	// The text layer and links follow the canvas: pdf.js turns the layer by the viewport's rotation (pdf.css). Sized by
	// the page as last read, the previous document's until the new one's is.
	const viewport = proxy?.getViewport({ scale, rotation: pdfPageRotation(proxy.rotate, rotation) })

	return (
		// Each page a labelled region ("Page 3 of 12"), its text layer what screen readers, selection and copy read.
		<div
			ref={wrapperRef}
			role="region"
			aria-label={pageLabel(pageNumber, total)}
			className={classes("fo-pdf-page", classNames?.page)}
			data-page={pageNumber}
			data-rendered={rendered}
			style={
				viewport === undefined
					? { width: fallbackWidth, height: fallbackHeight }
					: { width: viewport.width, height: viewport.height }
			}
		>
			{painted ? null : placeholder}
			{/* The CSS box follows every zoom step at once, so a stale bitmap stretches to the new size. */}
			<canvas
				ref={canvasRef}
				aria-hidden="true"
				className={classNames?.canvas?.(painted)}
				style={viewport === undefined ? undefined : { width: Math.floor(viewport.width), height: Math.floor(viewport.height) }}
			/>
			<div
				ref={textRef}
				className={classes("fo-pdf-text-layer", classNames?.textLayer)}
				style={pdfTextLayerVars(scale, proxy?.userUnit ?? 1)}
			/>
			{/* After the text layer, which covers the page: links before it could not be clicked. On the canvas's
			gate: an anchor over an evicted page would be invisible yet focusable. */}
			{viewport !== undefined && nearView && inView
				? links.map(link => {
						const [x1, y1] = viewportPoint(viewport.convertToViewportPoint(link.rect[0], link.rect[1]))
						const [x2, y2] = viewportPoint(viewport.convertToViewportPoint(link.rect[2], link.rect[3]))
						const box = pdfBox(x1, y1, x2, y2)
						const style: CSSProperties = {
							left: box.left,
							top: box.top,
							width: box.width,
							height: box.height
						}

						return link.kind === "external" ? (
							<a
								key={`${link.url}-${String(box.left)}-${String(box.top)}`}
								href={link.url}
								target="_blank"
								rel="noreferrer"
								aria-label={link.url}
								className={classes("fo-pdf-link", classNames?.link)}
								style={style}
							/>
						) : (
							// No href: a middle click would open the host page itself in a new tab.
							<a
								key={`#${String(link.to.page)}-${String(box.left)}-${String(box.top)}`}
								role="link"
								tabIndex={0}
								aria-label={pageLabel(link.to.page, total)}
								className={classes("fo-pdf-link", classNames?.link)}
								style={style}
								onClick={event => {
									event.preventDefault()
									onNavigate(link.to)
								}}
								onKeyDown={event => {
									if (event.key === "Enter") {
										event.preventDefault()
										onNavigate(link.to)
									}
								}}
							/>
						)
					})
				: null}
			{/* Last: over the text layer and links. Kept mounted while a new document's page is read (the editor hands
			out a new document on every change): taking it down would drop the focus and the keys typed meanwhile in a
			form field. The page's viewport is the last one read until then. */}
			{overlay !== undefined && viewport !== undefined && nearView && inView ? overlay(pageNumber, viewport) : null}
		</div>
	)
}
