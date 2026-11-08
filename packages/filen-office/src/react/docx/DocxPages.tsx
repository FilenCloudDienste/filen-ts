import {
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	type Ref
} from "react"
import type { DocxLinkTarget, DocxPageData, DocxSessionApi } from "../../dom/docx/protocol"
import { matchTop, type DocxFindMatch } from "./find"
import type { DocxMediaCache } from "./media"
import { paintObjects } from "./paint/objects"
import { paintPage, type PaintedPage } from "./paint/page"
import type { DocxDocument, DocxTables } from "./store"
import { anchoredScrollTop, pageAt, readViewport, type PagesViewport } from "./viewport"

// The page list: scroll height from the page sizes, only the pages in view (plus `overscan` on each side)
// mounted, each painted once from its display list and scaled by CSS for zoom. Structure and data-*
// attributes only; the look comes from docx.css and the --fo-* variables.

export interface DocxPagesHandle {
	scrollToPage(index: number, y?: number): void
	// Scrolls to a bookmark; false when the document has none of that name.
	scrollToAnchor(anchor: string): Promise<boolean>
	scrollToMatch(match: DocxFindMatch): void
}

// Where a mounted page sits in the scrolled content (px, zoom applied).
export interface DocxPageFrame {
	readonly index: number
	readonly top: number
	readonly left: number
	readonly width: number
	readonly height: number
}

export interface DocxPagesFind {
	readonly matches: readonly DocxFindMatch[]
	// Index into matches of the current one, or -1.
	readonly active: number
}

export interface DocxPagesProps {
	readonly document: DocxDocument
	// 1 = 100 % (96 px per inch).
	readonly zoom: number
	// Space between pages and around them (px, unscaled).
	readonly gap?: number
	readonly overscan?: number
	readonly className?: string
	readonly label?: string
	readonly pageLabel: (index: number, count: number) => string
	// External links (internal ones scroll to their bookmark). The policy is the caller's.
	readonly onLinkActivate?: (link: Extract<DocxLinkTarget, { kind: "external" }>) => void
	readonly onPageChange?: (index: number) => void
	// The scroll area's content width, for fit-to-width zoom.
	readonly onViewportWidth?: (width: number) => void
	readonly find?: DocxPagesFind | undefined
	// Space kept free right of the pages (px on screen, not zoomed), e.g. for margin balloons.
	readonly asideWidth?: number
	// Drawn in the scrolled content over and beside the mounted pages (comment balloons, change bars).
	readonly overlay?: (frames: readonly DocxPageFrame[]) => ReactNode
	readonly ref?: Ref<DocxPagesHandle>
}

const DEFAULT_PAGE_WIDTH = 816
const DEFAULT_PAGE_HEIGHT = 1056
const FIND_HIGHLIGHT = "fo-docx-find"
const FIND_ACTIVE_HIGHLIGHT = "fo-docx-find-active"

interface HighlightLike {
	add(range: Range): unknown
	delete(range: Range): unknown
}

interface HighlightRegistry {
	set(name: string, highlight: HighlightLike): unknown
	delete(name: string): unknown
}

interface Highlights {
	readonly all: HighlightLike
	readonly active: HighlightLike
}

function createHighlights(): Highlights | null {
	const api = highlightApi()

	return api === undefined ? null : { all: api.create(), active: api.create() }
}

// The CSS Custom Highlight API where the browser has it; find then works without touching layout.
function highlightApi(): { registry: HighlightRegistry; create: () => HighlightLike } | undefined {
	const css: unknown = Reflect.get(globalThis, "CSS")
	const HighlightClass: unknown = Reflect.get(globalThis, "Highlight")
	const registry: unknown = typeof css === "object" && css !== null ? Reflect.get(css, "highlights") : undefined

	if (typeof HighlightClass !== "function" || typeof registry !== "object" || registry === null) return undefined

	return { registry: registry as HighlightRegistry, create: () => new (HighlightClass as new () => HighlightLike)() }
}

interface Layout {
	readonly tops: Float64Array
	readonly heights: Float64Array
	readonly widths: Float64Array
	readonly total: number
	readonly contentWidth: number
}

function pageLayout(document: DocxDocument, zoom: number, gap: number, aside: number): Layout {
	const count = Math.max(document.pageCount, document.pages.length)
	const tops = new Float64Array(count)
	const heights = new Float64Array(count)
	const widths = new Float64Array(count)
	const fallback = document.pages[document.pages.length - 1]
	let y = gap
	let widest = 0

	for (let i = 0; i < count; i++) {
		const page = document.pages[i]
		const width = (page?.width ?? fallback?.width ?? document.info?.pageWidth ?? DEFAULT_PAGE_WIDTH) * zoom
		const height = (page?.height ?? fallback?.height ?? document.info?.pageHeight ?? DEFAULT_PAGE_HEIGHT) * zoom

		tops[i] = y
		heights[i] = height
		widths[i] = width
		widest = Math.max(widest, width)
		y += height + gap
	}

	return { tops, heights, widths, total: y, contentWidth: widest + 2 * gap + aside }
}

function frameLeft(layout: Layout, index: number, viewportWidth: number, aside: number, gap: number): number {
	return Math.max(gap, ((Math.max(viewportWidth, layout.contentWidth) - aside - (layout.widths[index] ?? 0)) / 2) | 0)
}

// The overlay, given where the mounted pages sit. Its own component, so a scroll step within the mounted
// range renders neither it nor what it draws.
function PagesOverlay(props: {
	readonly overlay: (frames: readonly DocxPageFrame[]) => ReactNode
	readonly layout: Layout
	readonly gap: number
	readonly aside: number
	readonly first: number
	readonly last: number
	readonly viewportWidth: number
}) {
	const layout = props.layout
	const frames: DocxPageFrame[] = []

	for (let index = props.first; index <= props.last; index++) {
		frames.push({
			index,
			top: layout.tops[index] ?? 0,
			left: frameLeft(layout, index, props.viewportWidth, props.aside, props.gap),
			width: layout.widths[index] ?? 0,
			height: layout.heights[index] ?? 0
		})
	}

	return <>{props.overlay(frames)}</>
}

interface Range2 {
	readonly first: number
	readonly last: number
}

export function DocxPages({
	document,
	zoom,
	find,
	gap: gapProp,
	overscan: overscanProp,
	className,
	label,
	pageLabel,
	onLinkActivate,
	onPageChange,
	onViewportWidth,
	asideWidth,
	overlay,
	ref
}: DocxPagesProps) {
	const gap = gapProp ?? 16
	const overscan = overscanProp ?? 2
	const aside = Math.max(0, asideWidth ?? 0)
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [viewport, setViewport] = useState<PagesViewport>({ top: 0, height: 0, width: 0 })
	// Page positions change with the pages, not with scrolling: computed once per document, zoom and gap.
	const layout = useMemo(() => pageLayout(document, zoom, gap, aside), [document, zoom, gap, aside])
	const count = layout.tops.length
	// Where the view is, as a page and a fraction of it: kept across zoom changes.
	const lastPageRef = useRef(-1)
	// The scroll position before the commit that changed the zoom (the browser may already have clamped
	// scrollTop to the new, shorter content when the layout effect reads it).
	const scrollTopRef = useRef(0)
	const previousRef = useRef<{ layout: Layout; zoom: number } | null>(null)
	// Null where the browser has no CSS Custom Highlight API: pages then draw boxes over matches.
	const [highlights] = useState(createHighlights)
	const session = document.session
	const visible: Range2 =
		count === 0
			? { first: 0, last: -1 }
			: {
					first: Math.max(0, pageAt(layout, viewport.top) - overscan),
					last: Math.min(count - 1, pageAt(layout, viewport.top + viewport.height) + overscan)
				}

	const cache = document.media
	// The view's size and scroll position: read in the commit that sizes the content (a scrollbar it brings or
	// takes away moves the pages in the same paint), then once per frame on scrolling and resizing.
	useLayoutEffect(() => {
		const container = containerRef.current

		if (container !== null) setViewport(readViewport(container))
	}, [layout.total, layout.contentWidth])

	useEffect(() => {
		const container = containerRef.current

		if (container === null) return

		let frame = 0
		const onScroll = (): void => {
			scrollTopRef.current = container.scrollTop
			schedule()
		}
		const read = (): void => {
			frame = 0
			setViewport(readViewport(container))
		}
		const schedule = (): void => {
			if (frame === 0) frame = requestAnimationFrame(read)
		}
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined

		scrollTopRef.current = container.scrollTop
		container.addEventListener("scroll", onScroll, { passive: true })
		observer?.observe(container)

		return () => {
			container.removeEventListener("scroll", onScroll)
			observer?.disconnect()

			if (frame !== 0) cancelAnimationFrame(frame)
		}
	}, [])

	useEffect(() => {
		if (viewport.width > 0) onViewportWidth?.(viewport.width)
	}, [viewport.width, onViewportWidth])

	// The page in the middle of the view, reported when it changes.
	useEffect(() => {
		if (count === 0 || viewport.height === 0) return

		const middle = pageAt(layout, viewport.top + viewport.height / 2)

		if (middle !== lastPageRef.current) {
			lastPageRef.current = middle
			onPageChange?.(middle)
		}
	})

	// Zooming keeps the same spot of the same page at the top of the view: where the view was in the
	// previous layout, mapped into this one.
	useLayoutEffect(() => {
		const container = containerRef.current
		const previous = previousRef.current

		previousRef.current = { layout, zoom }

		if (container === null || previous === null || previous.zoom === zoom || previous.layout.tops.length === 0) return

		const top = anchoredScrollTop(previous.layout, layout, scrollTopRef.current)

		container.scrollTop = top
		scrollTopRef.current = top
	})

	useEffect(() => {
		const api = highlightApi()

		if (api === undefined || highlights === null) return

		api.registry.set(FIND_HIGHLIGHT, highlights.all)
		api.registry.set(FIND_ACTIVE_HIGHLIGHT, highlights.active)

		return () => {
			api.registry.delete(FIND_HIGHLIGHT)
			api.registry.delete(FIND_ACTIVE_HIGHLIGHT)
		}
	}, [highlights])

	const scrollToPage = (index: number, y = 0): void => {
		const container = containerRef.current

		if (container === null || index < 0 || index >= count) return

		container.scrollTop = Math.max(0, (layout.tops[index] ?? 0) + y * zoom - gap)
	}

	useImperativeHandle(ref, () => ({
		scrollToPage,
		async scrollToAnchor(anchor) {
			const location = await session?.locate(anchor).catch(() => null)

			if (location === null || location === undefined) return false

			scrollToPage(location.page, location.y)

			return true
		},
		scrollToMatch(match) {
			const page = document.pages[match.page]
			const container = containerRef.current

			if (page === undefined || container === null) return

			container.scrollTop = Math.max(0, (layout.tops[match.page] ?? 0) + matchTop(page, match) * zoom - container.clientHeight / 3)
		}
	}))

	const linkOf = (element: EventTarget | null): DocxLinkTarget | undefined => {
		const target = element instanceof Element ? element.closest<HTMLElement>("[data-fo-link]") : null
		const index = Number(target?.dataset["foLink"] ?? Number.NaN)

		return Number.isInteger(index) ? document.tables.links[index] : undefined
	}

	const activate = (link: DocxLinkTarget): void => {
		if (link.kind === "internal") {
			void session
				?.locate(link.anchor)
				.then(location => {
					if (location !== null) scrollToPage(location.page, location.y)
				})
				.catch(() => undefined)
		} else {
			onLinkActivate?.(link)
		}
	}

	const onClick = (event: MouseEvent<HTMLDivElement>): void => {
		// A click that ends a selection is not a link activation.
		if (event.button !== 0 || (globalThis.getSelection?.()?.isCollapsed ?? true) === false) return

		const link = linkOf(event.target)

		if (link === undefined) return

		event.preventDefault()
		activate(link)
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Enter") return

		const link = linkOf(event.target)

		if (link === undefined) return

		event.preventDefault()
		activate(link)
	}

	const pages: ReactNode[] = []
	const activeMatch = find === undefined ? undefined : find.matches[find.active]

	for (let index = visible.first; index <= visible.last; index++) {
		const page = document.pages[index]
		const left = frameLeft(layout, index, viewport.width, aside, gap)

		pages.push(
			page === undefined || cache === undefined || session === undefined ? (
				<div
					key={index}
					className="fo-docx-page"
					data-fo-pending=""
					style={{ top: layout.tops[index], left, width: layout.widths[index], height: layout.heights[index] }}
				/>
			) : (
				<DocxPageView
					key={index}
					page={page}
					tables={document.tables}
					session={session}
					media={cache}
					zoom={zoom}
					top={layout.tops[index] ?? 0}
					left={left}
					label={pageLabel(index, count)}
					matches={find?.matches}
					activeMatch={activeMatch?.page === index ? activeMatch : undefined}
					highlights={highlights}
				/>
			)
		)
	}

	return (
		<div
			ref={containerRef}
			className={className === undefined ? "fo-docx-pages" : `fo-docx-pages ${className}`}
			data-fo-status={document.status}
			role="document"
			aria-label={label}
			aria-busy={document.status === "loading" || document.status === "streaming"}
			tabIndex={0}
			onClick={onClick}
			onKeyDown={onKeyDown}
		>
			<div
				className="fo-docx-pages-content"
				style={{ height: layout.total, width: layout.contentWidth }}
			>
				{pages}
				{overlay === undefined ? null : (
					<PagesOverlay
						overlay={overlay}
						layout={layout}
						gap={gap}
						aside={aside}
						first={visible.first}
						last={visible.last}
						viewportWidth={viewport.width}
					/>
				)}
			</div>
		</div>
	)
}

interface DocxPageViewProps {
	readonly page: DocxPageData
	readonly tables: DocxTables
	readonly session: DocxSessionApi
	readonly media: DocxMediaCache
	readonly zoom: number
	readonly top: number
	readonly left: number
	readonly label: string
	readonly matches: readonly DocxFindMatch[] | undefined
	readonly activeMatch: DocxFindMatch | undefined
	readonly highlights: Highlights | null
}

// The text node and offset holding character `offset` of an element's text, walking nested spans.
function textPosition(element: HTMLElement, offset: number, end: boolean): { node: Node; offset: number } | undefined {
	const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
	let remaining = offset
	let last: Node | undefined

	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const length = node.textContent?.length ?? 0

		if (remaining < length || (end && remaining === length)) return { node, offset: remaining }

		remaining -= length
		last = node
	}

	return last === undefined ? undefined : { node: last, offset: last.textContent?.length ?? 0 }
}

// Ranges over the painted text of one match.
function matchRanges(painted: PaintedPage, match: DocxFindMatch): Range[] {
	const out: Range[] = []

	for (const text of painted.texts) {
		if (text.source !== match.source || text.end <= match.start || text.start >= match.end) continue

		const start = textPosition(text.element, Math.max(0, match.start - text.start), false)
		const end = textPosition(text.element, Math.min(text.end, match.end) - text.start, true)

		if (start === undefined || end === undefined) continue

		const range = text.element.ownerDocument.createRange()

		range.setStart(start.node, start.offset)
		range.setEnd(end.node, end.offset)
		out.push(range)
	}

	return out
}

function paintFindBoxes(root: HTMLElement, pageWidth: number, all: readonly Range[], active: readonly Range[]): HTMLElement {
	const document = root.ownerDocument
	const layer = document.createElement("div")
	const bounds = root.getBoundingClientRect()
	const scale = bounds.width > 0 && pageWidth > 0 ? bounds.width / pageWidth : 1

	layer.className = "fo-docx-layer fo-docx-find-layer"

	for (const [ranges, current] of [
		[all, false],
		[active, true]
	] as const) {
		for (const range of ranges) {
			for (const rect of range.getClientRects()) {
				const box = document.createElement("div")

				box.className = "fo-docx-find"
				box.style.cssText = `left:${(rect.left - bounds.left) / scale}px;top:${(rect.top - bounds.top) / scale}px;width:${rect.width / scale}px;height:${rect.height / scale}px;`

				if (current) box.dataset["foActive"] = ""

				layer.appendChild(box)
			}
		}
	}

	root.appendChild(layer)

	return layer
}

function DocxPageView(props: DocxPageViewProps) {
	const { page, tables, session, media, matches, activeMatch, highlights } = props
	const hostRef = useRef<HTMLDivElement | null>(null)
	const paintedRef = useRef<PaintedPage | null>(null)

	useLayoutEffect(() => {
		const host = hostRef.current

		if (host === null) return

		const signal = { aborted: false }
		const result = paintPage(page, { document: host.ownerDocument, tables })

		host.replaceChildren(result.root)

		const release = paintObjects(result.objects, { document: host.ownerDocument, session, media, signal })

		paintedRef.current = result

		return () => {
			signal.aborted = true
			release()
			host.replaceChildren()
			paintedRef.current = null
		}
	}, [page, tables, session, media])

	// Runs after the paint above whenever either changes (the page is a dependency of both).
	useEffect(() => {
		const painted = paintedRef.current

		if (painted === null || matches === undefined) return

		const all: Range[] = []
		const active: Range[] = []

		for (const match of matches) {
			if (match.page !== page.index) continue

			for (const range of matchRanges(painted, match)) {
				if (match === activeMatch) active.push(range)
				else all.push(range)
			}
		}

		if (highlights !== null) {
			for (const range of all) highlights.all.add(range)
			for (const range of active) highlights.active.add(range)

			return () => {
				for (const range of all) highlights.all.delete(range)
				for (const range of active) highlights.active.delete(range)
			}
		}

		// Without the Highlight API: boxes behind the text, in page coordinates (whatever the zoom).
		if (all.length === 0 && active.length === 0) return

		const layer = paintFindBoxes(painted.root, page.width, all, active)

		return () => layer.remove()
	}, [page, matches, activeMatch, highlights])

	return (
		<div
			className="fo-docx-page"
			role="group"
			aria-label={props.label}
			data-fo-page={page.index}
			style={{ top: props.top, left: props.left, width: page.width * props.zoom, height: page.height * props.zoom }}
		>
			<div
				ref={hostRef}
				className="fo-docx-page-scale"
				style={{ transform: props.zoom === 1 ? undefined : `scale(${props.zoom})` }}
			/>
		</div>
	)
}
