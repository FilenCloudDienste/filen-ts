// Pure page-visibility/canvas-sizing math for pdf-viewer.tsx — framework-free so it is testable in
// node (pdf-viewer.logic.test.ts) with no pdf.js, canvas, or DOM involved.

// One page's current IntersectionObserver ratio, as reported by pdf-viewer.tsx's per-page observer.
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
