import { describe, expect, it } from "vitest"
import {
	mostVisiblePage,
	canvasDimsForViewport,
	canvasRenderTransform,
	pdfPageAction,
	clampPdfScale,
	pdfStepZoomScale,
	pdfWheelZoomScale,
	PDF_PAGE_RENDER_MARGIN_PX,
	PDF_PAGE_EVICT_MARGIN_PX,
	PDF_MIN_SCALE,
	PDF_MAX_SCALE,
	PDF_ZOOM_STEP,
	type PageVisibility
} from "@/features/preview/components/pdfViewer.logic"

describe("mostVisiblePage", () => {
	it("picks the entry with the highest ratio", () => {
		const entries: PageVisibility[] = [
			{ page: 1, ratio: 0.2 },
			{ page: 2, ratio: 0.9 },
			{ page: 3, ratio: 0.5 }
		]

		expect(mostVisiblePage(entries, 1)).toBe(2)
	})

	it("ignores zero-ratio (non-intersecting) entries", () => {
		const entries: PageVisibility[] = [
			{ page: 1, ratio: 0 },
			{ page: 2, ratio: 0.1 }
		]

		expect(mostVisiblePage(entries, 1)).toBe(2)
	})

	it("falls back to the previous page when every entry is at ratio 0", () => {
		const entries: PageVisibility[] = [
			{ page: 1, ratio: 0 },
			{ page: 2, ratio: 0 }
		]

		expect(mostVisiblePage(entries, 5)).toBe(5)
	})

	it("falls back on an empty list", () => {
		expect(mostVisiblePage([], 3)).toBe(3)
	})

	it("keeps the first entry on an exact tie", () => {
		const entries: PageVisibility[] = [
			{ page: 1, ratio: 0.5 },
			{ page: 2, ratio: 0.5 }
		]

		expect(mostVisiblePage(entries, 1)).toBe(1)
	})

	it("ignores a negative ratio the same as zero", () => {
		const entries: PageVisibility[] = [{ page: 1, ratio: -0.1 }]

		expect(mostVisiblePage(entries, 7)).toBe(7)
	})
})

describe("canvasDimsForViewport", () => {
	it("matches the CSS size at devicePixelRatio 1", () => {
		expect(canvasDimsForViewport(200, 300, 1)).toEqual({ bufferWidth: 200, bufferHeight: 300, cssWidth: 200, cssHeight: 300 })
	})

	it("scales the buffer only at devicePixelRatio 2", () => {
		expect(canvasDimsForViewport(200, 300, 2)).toEqual({ bufferWidth: 400, bufferHeight: 600, cssWidth: 200, cssHeight: 300 })
	})

	it("floors fractional pixels", () => {
		expect(canvasDimsForViewport(200.7, 300.4, 1.5)).toEqual({ bufferWidth: 301, bufferHeight: 450, cssWidth: 200, cssHeight: 300 })
	})

	it("treats a non-positive devicePixelRatio as 1 (a hostile/unset environment)", () => {
		expect(canvasDimsForViewport(100, 100, 0)).toEqual({ bufferWidth: 100, bufferHeight: 100, cssWidth: 100, cssHeight: 100 })
	})
})

describe("canvasRenderTransform", () => {
	it("is the identity matrix at ratio 1", () => {
		expect(canvasRenderTransform(1)).toEqual([1, 0, 0, 1, 0, 0])
	})

	it("scales x/y uniformly at a higher ratio", () => {
		expect(canvasRenderTransform(2)).toEqual([2, 0, 0, 2, 0, 0])
	})

	it("treats a non-positive ratio as 1", () => {
		expect(canvasRenderTransform(0)).toEqual([1, 0, 0, 1, 0, 0])
	})
})

describe("PDF_PAGE_EVICT_MARGIN_PX", () => {
	it("stays wider than the render margin, or eviction would thrash at the boundary", () => {
		expect(PDF_PAGE_EVICT_MARGIN_PX).toBeGreaterThan(PDF_PAGE_RENDER_MARGIN_PX)
	})
})

describe("pdfPageAction", () => {
	it("renders once within the extended viewport and not yet rendered", () => {
		expect(pdfPageAction(true, false)).toBe("render")
	})

	it("goes idle once rendered and still within the extended viewport", () => {
		expect(pdfPageAction(true, true)).toBe("idle")
	})

	it("evicts a rendered page once it leaves the extended viewport", () => {
		expect(pdfPageAction(false, true)).toBe("evict")
	})

	it("also evicts an unrendered page outside the extended viewport (a cancelled mid-render still sized its canvas)", () => {
		expect(pdfPageAction(false, false)).toBe("evict")
	})
})

describe("clampPdfScale", () => {
	it("clamps to the minimum", () => {
		expect(clampPdfScale(0)).toBe(PDF_MIN_SCALE)
	})

	it("clamps to the maximum", () => {
		expect(clampPdfScale(100)).toBe(PDF_MAX_SCALE)
	})

	it("passes through an in-range value", () => {
		expect(clampPdfScale(2)).toBe(2)
	})
})

describe("pdfStepZoomScale", () => {
	it("steps up by PDF_ZOOM_STEP", () => {
		expect(pdfStepZoomScale(1.5, 1)).toBeCloseTo(1.5 + PDF_ZOOM_STEP, 10)
	})

	it("steps down by PDF_ZOOM_STEP", () => {
		expect(pdfStepZoomScale(1.5, -1)).toBeCloseTo(1.5 - PDF_ZOOM_STEP, 10)
	})

	it("clamps a step past the maximum", () => {
		expect(pdfStepZoomScale(PDF_MAX_SCALE, 1)).toBe(PDF_MAX_SCALE)
	})

	it("clamps a step past the minimum", () => {
		expect(pdfStepZoomScale(PDF_MIN_SCALE, -1)).toBe(PDF_MIN_SCALE)
	})
})

describe("pdfWheelZoomScale", () => {
	it("zooms in on a negative deltaY (wheel up)", () => {
		expect(pdfWheelZoomScale(1.5, -100)).toBeGreaterThan(1.5)
	})

	it("zooms out on a positive deltaY (wheel down)", () => {
		expect(pdfWheelZoomScale(1.5, 100)).toBeLessThan(1.5)
	})

	it("never exceeds the clamped bounds regardless of delta magnitude", () => {
		expect(pdfWheelZoomScale(1.5, -1_000_000)).toBe(PDF_MAX_SCALE)
		expect(pdfWheelZoomScale(1.5, 1_000_000)).toBe(PDF_MIN_SCALE)
	})
})

// A page's own render-effect gate (pdfPageAction) reads only `withinExtendedView`/`rendered` — never
// `scale` — by design: pdfViewer.tsx derives `rendered` itself as `renderedAtScale === scale`, so a
// scale change alone (independent of any IntersectionObserver crossing) already flips that boolean to
// false, which pdfPageAction then reads as an ordinary "not yet rendered" case. The absolute-pixel
// render/evict margins stay meaningful at any zoom level for the same reason PDF_PAGE_EVICT_MARGIN_PX
// must stay wider than PDF_PAGE_RENDER_MARGIN_PX above: the hysteresis is about SCROLL distance, which
// a zoom change doesn't alter.
// Widens a literal to plain `number` — the two scale values compared below are deliberately DIFFERENT
// float literals, which TS would otherwise narrow to disjoint literal types and flag their `===` as an
// impossible comparison; both are really just `number`s at runtime (one read from a `scale` prop, the
// other from a `renderedAtScale` state value), so this mirrors that at the type level too.
function asScale(scale: number): number {
	return scale
}

describe("pdfPageAction — scale-change re-render (via a stale-vs-current renderedAtScale comparison)", () => {
	it("treats a scale change as unrendered, forcing a re-render even while still within the extended viewport", () => {
		const renderedAtScale = asScale(1.5)
		const currentScale = asScale(1.75)
		const rendered = renderedAtScale === currentScale

		expect(pdfPageAction(true, rendered)).toBe("render")
	})

	it("stays idle when the scale hasn't changed since the last render", () => {
		const renderedAtScale = asScale(1.5)
		const currentScale = asScale(1.5)
		const rendered = renderedAtScale === currentScale

		expect(pdfPageAction(true, rendered)).toBe("idle")
	})
})
