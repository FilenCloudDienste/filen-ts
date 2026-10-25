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
	type PdfPage as PdfPageProxy,
	type PdfRect
} from "../../dom/pdf/index"
import { paintMatches } from "./highlight"
import type { PdfDomDocument, PdfJsDom, PdfTextLayer } from "./types"

// The page column, unstyled: every page gets a sized wrapper at once (so the scroll height is right), and only
// pages near the view hold a canvas, a text layer and links. A page renders once it nears the view and releases
// its canvas, text layer and pdf.js resources once it is far away again, so a long document never holds more
// than a screenful or so of bitmaps. Two IntersectionObservers serve all pages.

// The largest canvas a page allocates: WebKit refuses canvases over 16,777,216 pixels, and a large page zoomed
// in on a high-density screen would pass that. Above it the page renders at a lower pixel ratio.
export const PDF_MAX_PAGE_CANVAS_BYTES = 64 * 1024 * 1024

// Joined to the package's own classes, which @filen/office/css/pdf.css styles (the host imports it).
export interface PdfPagesClassNames {
	readonly column?: string
	readonly page?: string
	readonly canvas?: (rendered: boolean) => string
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
	readonly onVisible: (page: number, ratio: number) => void
	readonly registerPage: (page: number, element: HTMLElement | null) => void
	readonly onNavigate: (page: number) => void
}

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
}

function classes(own: string, host: string | undefined): string {
	return host === undefined || host.length === 0 ? own : `${own} ${host}`
}

type EntryHandler = (entry: IntersectionObserverEntry) => void

const THRESHOLDS = [0, 0.25, 0.5, 0.75, 1]

// Both observers for every page: one with ratio thresholds at the render margin (render gate and the page most
// in view), one at the evict margin. Pages register before the scroller attaches (children's effects run
// first); they are observed once it does.
class PageWatcher {
	private readonly renders = new Map<Element, EntryHandler>()
	private readonly evicts = new Map<Element, EntryHandler>()
	private render: IntersectionObserver | null = null
	private evict: IntersectionObserver | null = null

	attach(root: Element): void {
		const dispatch =
			(handlers: Map<Element, EntryHandler>) =>
			(entries: IntersectionObserverEntry[]): void => {
				for (const entry of entries) handlers.get(entry.target)?.(entry)
			}

		this.render = new IntersectionObserver(dispatch(this.renders), {
			root,
			rootMargin: `${String(PDF_PAGE_RENDER_MARGIN_PX)}px 0px`,
			threshold: THRESHOLDS
		})
		this.evict = new IntersectionObserver(dispatch(this.evicts), { root, rootMargin: `${String(PDF_PAGE_EVICT_MARGIN_PX)}px 0px` })

		for (const element of this.renders.keys()) {
			this.render.observe(element)
			this.evict.observe(element)
		}
	}

	detach(): void {
		this.render?.disconnect()
		this.evict?.disconnect()
		this.render = null
		this.evict = null
	}

	watch(element: Element, onRender: EntryHandler, onEvict: EntryHandler): () => void {
		this.renders.set(element, onRender)
		this.evicts.set(element, onEvict)
		this.render?.observe(element)
		this.evict?.observe(element)

		return () => {
			this.renders.delete(element)
			this.evicts.delete(element)
			this.render?.unobserve(element)
			this.evict?.unobserve(element)
		}
	}
}

export function PdfPages({
	pdfjs,
	document,
	scale,
	rotation,
	find,
	scrollerRef,
	onVisible,
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
	onAuxClick
}: PdfPagesProps) {
	const total = document.numPages
	const [watcher] = useState(() => new PageWatcher())
	const pages = Array.from({ length: total }, (_, index) => index + 1)

	useEffect(() => {
		const root = scrollerRef.current

		if (root === null) return

		watcher.attach(root)

		return () => {
			watcher.detach()
		}
	}, [watcher, scrollerRef])

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
							onVisible={onVisible}
							registerPage={registerPage}
							onNavigate={onNavigate}
						/>
					)
				})}
			</div>
		</div>
	)
}

type PageLink =
	| { readonly kind: "external"; readonly rect: PdfRect; readonly url: string }
	| { readonly kind: "internal"; readonly rect: PdfRect; readonly page: number }

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
	readonly onVisible: (page: number, ratio: number) => void
	readonly registerPage: (page: number, element: HTMLElement | null) => void
	readonly onNavigate: (page: number) => void
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
	onVisible,
	registerPage,
	onNavigate
}: PdfPageViewProps) {
	const wrapperRef = useRef<HTMLDivElement | null>(null)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const textRef = useRef<HTMLDivElement | null>(null)
	const layerRef = useRef<PdfTextLayer | null>(null)
	const proxyRef = useRef<PdfPageProxy<ReadableStream> | null>(null)
	const linksFor = useRef<PdfPageProxy<ReadableStream> | null>(null)
	const revealed = useRef(0)
	const [proxy, setProxy] = useState<PdfPageProxy<ReadableStream> | null>(null)
	// Set the first time the page nears the view, never cleared: the gate that keeps a long document from
	// rendering every page at open. Page 1 starts open, so the first paint waits for no observer.
	const [nearView, setNearView] = useState(pageNumber === 1)
	// Within the evict margin.
	const [inView, setInView] = useState(false)
	// The scale and turn the canvas was painted at, or null; a zoom or a turn makes it stale in the same render.
	const [paintedAt, setPaintedAt] = useState<{ readonly scale: number; readonly rotation: number } | null>(null)
	// Bumped when a text layer has rendered, for the find highlights.
	const [textEpoch, setTextEpoch] = useState(0)
	const [links, setLinks] = useState<readonly PageLink[]>([])
	const rendered = paintedAt !== null && paintedAt.scale === scale && paintedAt.rotation === rotation

	useEffect(() => {
		let live = true

		void document.getPage(pageNumber).then(
			resolved => {
				if (live) {
					proxyRef.current = resolved
					setProxy(resolved)
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
	}, [document, pageNumber])

	useEffect(() => {
		const element = wrapperRef.current

		if (element === null) return

		registerPage(pageNumber, element)

		const unwatch = watcher.watch(
			element,
			entry => {
				if (entry.isIntersecting) setNearView(true)

				onVisible(pageNumber, entry.intersectionRatio)
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
			}
		)

		return () => {
			unwatch()
			registerPage(pageNumber, null)
		}
	}, [watcher, pageNumber, onVisible, registerPage])

	useEffect(() => {
		const canvas = canvasRef.current

		if (proxy === null || !nearView || canvas === null || pdfPageAction(inView, rendered) !== "render") return

		let cancelled = false
		const viewport = proxy.getViewport({ scale, rotation: pdfPageRotation(proxy.rotate, rotation) })
		const ratio = pdfRenderRatio(viewport.width, viewport.height, window.devicePixelRatio, maxCanvasBytes)
		const dims = pdfCanvasDims(viewport.width, viewport.height, ratio)

		canvas.width = dims.bufferWidth
		canvas.height = dims.bufferHeight
		canvas.style.width = `${String(dims.cssWidth)}px`
		canvas.style.height = `${String(dims.cssHeight)}px`

		const task = proxy.render({ canvas, viewport, transform: pdfRenderTransform(ratio) })

		task.promise.then(
			() => {
				if (!cancelled) setPaintedAt({ scale, rotation })
			},
			() => {
				// A cancelled render (scrolled away, zoomed) rejects too. A page that fails to render stays a
				// placeholder; the document opened, so the rest still shows.
			}
		)

		return () => {
			cancelled = true
			task.cancel()
		}
	}, [proxy, nearView, inView, rendered, scale, rotation, maxCanvasBytes])

	// Its own effect, not the canvas's: that one re-runs as soon as its render resolves (`rendered` changes), and a
	// text layer torn down there would be gone right after every paint. Leaving the evict margin tears it down.
	useEffect(() => {
		const container = textRef.current

		if (proxy === null || !nearView || !inView || container === null) return

		const layer = new pdfjs.TextLayer({
			textContentSource: proxy.streamTextContent(),
			container,
			viewport: proxy.getViewport({ scale, rotation: pdfPageRotation(proxy.rotate, rotation) })
		})

		layerRef.current = layer
		layer.render().then(
			() => {
				if (layerRef.current === layer) setTextEpoch(epoch => epoch + 1)
			},
			() => {
				// The page stays readable, only not selectable.
			}
		)

		return () => {
			layer.cancel()
			layerRef.current = null
			// render() appends as it streams and the constructor never clears, so a rebuild would stack spans.
			container.replaceChildren()
		}
	}, [pdfjs, proxy, nearView, inView, scale, rotation])

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

						return target === null ? null : { kind: "internal", rect: link.rect, page: target }
					})
				)

				if (linksFor.current === proxy) setLinks(found.filter(link => link !== null))
			})
			.catch(() => {
				// The page still shows, without its links.
			})
	}, [document, proxy, inView, allowLink])

	// The text layer and links follow the canvas: pdf.js turns the layer by the viewport's rotation (pdf.css).
	const viewport = proxy?.getViewport({ scale, rotation: pdfPageRotation(proxy.rotate, rotation) })

	return (
		<div
			ref={wrapperRef}
			className={classes("fo-pdf-page", classNames?.page)}
			data-page={pageNumber}
			data-rendered={rendered}
			style={viewport === undefined ? { width: 300, height: 400 } : { width: viewport.width, height: viewport.height }}
		>
			{rendered ? null : placeholder}
			<canvas
				ref={canvasRef}
				aria-label={pageLabel(pageNumber, total)}
				className={classNames?.canvas?.(rendered)}
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
								key={`#${String(link.page)}-${String(box.left)}-${String(box.top)}`}
								role="link"
								tabIndex={0}
								aria-label={pageLabel(link.page, total)}
								className={classes("fo-pdf-link", classNames?.link)}
								style={style}
								onClick={event => {
									event.preventDefault()
									onNavigate(link.page)
								}}
								onKeyDown={event => {
									if (event.key === "Enter") {
										event.preventDefault()
										onNavigate(link.page)
									}
								}}
							/>
						)
					})
				: null}
		</div>
	)
}
