// Pure page-visibility/canvas-sizing math for pdfViewer.tsx — framework-free so it is testable in
// node (pdf-viewer.logic.test.ts) with no pdf.js, canvas, or DOM involved.

// Two IntersectionObserver rootMargin values per page: RENDER (tight) triggers the first render as a
// page approaches the viewport; EVICT (generous) releases that page's canvas only once it has
// scrolled much further away. The gap between them is deliberate hysteresis — a single shared
// threshold would render and evict the same page repeatedly while it sits near the boundary.
export const PDF_PAGE_RENDER_MARGIN_PX = 400
export const PDF_PAGE_EVICT_MARGIN_PX = 1200

export type PdfPageAction = "render" | "evict" | "idle"

// What a page's canvas should do given its current extended-viewport membership and render state.
// pdfViewer.tsx's render effect only acts on "render" (start a page.render() task); "evict" is
// unconditional on !withinExtendedView rather than gated on `rendered` because the actual release
// (canvas resize + un-rendering) runs eagerly from the eviction observer's own callback the instant
// visibility flips, not from this decision — a page whose render task got cancelled mid-flight had
// already sized its canvas to a full bitmap by then, so it needs releasing too, not just a page that
// finished. Kept as one three-way decision (not two separate booleans) because it's the single place
// documenting the hysteresis: render and evict never both read true for the same input.
export function pdfPageAction(withinExtendedView: boolean, rendered: boolean): PdfPageAction {
	if (!withinExtendedView) {
		return "evict"
	}

	return rendered ? "idle" : "render"
}

// One page's current IntersectionObserver ratio, as reported by pdfViewer.tsx's per-page observer.
export interface PageVisibility {
	page: number
	ratio: number
}

// Picks the page with the highest visibility ratio among currently-intersecting entries (ratio > 0)
// — the page-nav toolbar's "Page X of N" indicator and the value the Prev/Next-page buttons step
// from. Falls back to the previously-current page when nothing is intersecting (e.g. a single
// observer callback mid-fast-scroll where every entry has already left the root's bounds), and on a
// tie keeps whichever entry sorts first — stable, since the caller always passes entries in page order.
export function mostVisiblePage(entries: readonly PageVisibility[], fallback: number): number {
	let best: PageVisibility | null = null

	for (const entry of entries) {
		if (entry.ratio <= 0) {
			continue
		}

		if (best === null || entry.ratio > best.ratio) {
			best = entry
		}
	}

	return best?.page ?? fallback
}

// HiDPI canvas sizing for one page's render — mirrors pdf.js's own recommended recipe: the canvas's
// pixel BUFFER scales with devicePixelRatio for a crisp bitmap, while its CSS box stays at the
// viewport's own (unscaled) size so the page occupies the same on-screen space regardless of DPR.
// Both are floored to whole pixels — a fractional buffer leaves a 1px transparent gutter on some
// browsers once the CSS box rounds up.
export interface CanvasDims {
	bufferWidth: number
	bufferHeight: number
	cssWidth: number
	cssHeight: number
}

export function canvasDimsForViewport(viewportWidth: number, viewportHeight: number, devicePixelRatio: number): CanvasDims {
	const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1

	return {
		bufferWidth: Math.floor(viewportWidth * ratio),
		bufferHeight: Math.floor(viewportHeight * ratio),
		cssWidth: Math.floor(viewportWidth),
		cssHeight: Math.floor(viewportHeight)
	}
}

// The render-time canvas transform matching canvasDimsForViewport's buffer scale — the identity
// matrix at ratio 1, else pdf.js's own documented [sx, 0, 0, sy, 0, 0] form.
export function canvasRenderTransform(devicePixelRatio: number): [number, number, number, number, number, number] {
	const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1

	return [ratio, 0, 0, ratio, 0, 0]
}
