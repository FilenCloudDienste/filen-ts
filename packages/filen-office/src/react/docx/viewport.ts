import type { DocxDocument } from "./store"

// The part of the pages a scroll container shows, read from it. The pages are centred in its width, which a
// scrollbar coming or going with the content's size changes: read again in the commit that changes that
// size (a layout effect), so pages are never painted where the previous width put them.

export interface PagesViewport {
	readonly top: number
	readonly height: number
	readonly width: number
}

// What readViewport reads of a scroll container; structural, so the pure page helpers here type-check
// without the DOM lib.
export interface ScrollBox {
	readonly scrollTop: number
	readonly clientHeight: number
	readonly clientWidth: number
}

// A state update to `container`'s viewport, keeping the previous object where nothing changed.
export function readViewport(container: ScrollBox): (previous: PagesViewport) => PagesViewport {
	return previous =>
		previous.top === container.scrollTop && previous.height === container.clientHeight && previous.width === container.clientWidth
			? previous
			: { top: container.scrollTop, height: container.clientHeight, width: container.clientWidth }
}

// Pages stacked top to bottom, in px on screen.
export interface PageStack {
	readonly tops: Float64Array
	readonly heights: Float64Array
}

// Letter at 96 px per inch: the size of a page before the document says.
export const DEFAULT_PAGE_WIDTH = 816
export const DEFAULT_PAGE_HEIGHT = 1056

// What sizes the pages: the laid-out pages and the document's own page size.
export type PagedDocument = Pick<DocxDocument, "pages" | "info">

// The pages stacked with `gap` between and around them, `aside` kept free right of them (px on screen).
export interface PageLayout extends PageStack {
	readonly widths: Float64Array
	readonly total: number
	readonly contentWidth: number
}

// A page's size on screen; one not laid out yet is sized like the last that is.
export function pageWidthAt(document: PagedDocument, index: number, zoom: number): number {
	const page = document.pages[index] ?? document.pages[document.pages.length - 1]

	return (page?.width ?? document.info?.pageWidth ?? DEFAULT_PAGE_WIDTH) * zoom
}

export function pageHeightAt(document: PagedDocument, index: number, zoom: number): number {
	const page = document.pages[index] ?? document.pages[document.pages.length - 1]

	return (page?.height ?? document.info?.pageHeight ?? DEFAULT_PAGE_HEIGHT) * zoom
}

// `count` pages top to bottom; the viewer and the editor stack them alike, so a page sits in the same place
// in both.
export function stackPages(document: PagedDocument, count: number, zoom: number, gap: number, aside: number): PageLayout {
	const tops = new Float64Array(count)
	const heights = new Float64Array(count)
	const widths = new Float64Array(count)
	let y = gap
	let widest = 0

	for (let i = 0; i < count; i++) {
		const width = pageWidthAt(document, i, zoom)
		const height = pageHeightAt(document, i, zoom)

		tops[i] = y
		heights[i] = height
		widths[i] = width
		widest = Math.max(widest, width)
		y += height + gap
	}

	return { tops, heights, widths, total: y, contentWidth: widest + 2 * gap + aside }
}

// Page `index`'s left edge in the scrolled content: centred in the view's width less `aside`, at least `gap`
// from the edge.
export function pageLeft(layout: PageLayout, index: number, viewportWidth: number, aside: number, gap: number): number {
	return Math.max(gap, ((Math.max(viewportWidth, layout.contentWidth) - aside - (layout.widths[index] ?? 0)) / 2) | 0)
}

// The first page whose bottom is below `y`.
export function pageAt(stack: PageStack, y: number): number {
	let low = 0
	let high = stack.tops.length - 1

	while (low < high) {
		const middle = (low + high) >> 1

		if ((stack.tops[middle] ?? 0) + (stack.heights[middle] ?? 0) < y) low = middle + 1
		else high = middle
	}

	return low
}

// The scroll position that keeps the spot of the page at the view's top there when the pages are stacked
// anew (another zoom): the same page, the same fraction down it.
export function anchoredScrollTop(previous: PageStack, next: PageStack, scrollTop: number): number {
	if (previous.tops.length === 0 || next.tops.length === 0) return scrollTop

	const page = Math.min(pageAt(previous, scrollTop), next.tops.length - 1)
	const height = previous.heights[page] ?? 0
	const fraction = height > 0 ? (scrollTop - (previous.tops[page] ?? 0)) / height : 0

	return Math.max(0, (next.tops[page] ?? 0) + fraction * (next.heights[page] ?? 0))
}
