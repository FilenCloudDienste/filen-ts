// Pure page-visibility/canvas-sizing math for pdfViewer.tsx — framework-free so it is testable in
// node (pdfViewer.logic.test.ts) with no pdf.js, canvas, or DOM involved.

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

// User-controlled zoom bounds/step, independent of BASE_SCALE (the document's own initial render
// scale, unchanged) — PDF_PAGE_RENDER_MARGIN_PX/PDF_PAGE_EVICT_MARGIN_PX above stay absolute-pixel
// IntersectionObserver margins that never need to change with scale: a page's own wrapper div is
// always sized to its CURRENT scale's viewport (pdfViewer.tsx derives it fresh from `page.getViewport({
// scale })` on every scale change), so the hysteresis gap between those two margins keeps meaning the
// same "how many CSS pixels of scroll before render/evict" at any zoom level — only how many PAGES fit
// in that pixel span changes, not the render/evict decision itself (pdfPageAction stays scale-blind by
// design).
export const PDF_MIN_SCALE = 0.5
export const PDF_MAX_SCALE = 4
export const PDF_ZOOM_STEP = 0.25
// Wheel delta -> scale factor for ctrl/cmd+wheel — same sensitivity constant shape as the image
// viewer's own wheel-zoom (imageViewer.logic.ts), tuned separately since a PDF page and an image fill
// very different portions of the viewport.
export const PDF_ZOOM_WHEEL_SENSITIVITY = 0.0015

export function clampPdfScale(scale: number): number {
	return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale))
}

// The +/- toolbar buttons' own step function — always lands on a PDF_ZOOM_STEP-aligned value from
// BASE_SCALE (1.5, 1.75, ...) regardless of where ctrl/cmd+wheel last left `current`, since floating
// zoom from the wheel path can drift off that grid.
export function pdfStepZoomScale(current: number, direction: 1 | -1): number {
	return clampPdfScale(current + direction * PDF_ZOOM_STEP)
}

export function pdfWheelZoomScale(current: number, deltaY: number): number {
	return clampPdfScale(current - deltaY * PDF_ZOOM_WHEEL_SENSITIVITY)
}
