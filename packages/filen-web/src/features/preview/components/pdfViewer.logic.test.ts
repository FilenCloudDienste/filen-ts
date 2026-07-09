import { describe, expect, it } from "vitest"
import {
	mostVisiblePage,
	canvasDimsForViewport,
	canvasRenderTransform,
	pdfPageAction,
	PDF_PAGE_RENDER_MARGIN_PX,
	PDF_PAGE_EVICT_MARGIN_PX,
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
