import { describe, expect, it } from "vitest"
import {
	clampPdfScale,
	isPdfCommandEnabled,
	mostVisiblePage,
	pdfBox,
	pdfCanvasDims,
	pdfFitScale,
	pdfPageAction,
	pdfPageRotation,
	pdfPercentScale,
	pdfRenderRatio,
	pdfRenderTransform,
	pdfRotate,
	pdfStepZoomScale,
	pdfWheelZoomScale,
	pdfZoomPercent,
	PDF_BASE_SCALE,
	PDF_MAX_SCALE,
	PDF_MIN_SCALE,
	PDF_PAGE_EVICT_MARGIN_PX,
	PDF_PAGE_RENDER_MARGIN_PX,
	PDF_ZOOM_STEP,
	type PdfViewerState
} from "../dom/pdf/index"

describe("mostVisiblePage", () => {
	it("picks the page with the highest ratio", () => {
		expect(
			mostVisiblePage(
				new Map([
					[1, 0.2],
					[2, 0.9],
					[3, 0.5]
				])
			)
		).toBe(2)
	})

	it("ignores pages with no visible part and keeps the first on a tie", () => {
		expect(
			mostVisiblePage(
				new Map([
					[1, 0],
					[2, -0.1],
					[3, 0.5],
					[4, 0.5]
				])
			)
		).toBe(3)
	})

	it("gives null when nothing is visible, so the current page stays", () => {
		expect(mostVisiblePage(new Map([[1, 0]]))).toBeNull()
		expect(mostVisiblePage(new Map())).toBeNull()
	})
})

describe("page canvas geometry", () => {
	it("scales the buffer by the pixel ratio and keeps the CSS box, in whole pixels", () => {
		expect(pdfCanvasDims(200, 300, 1)).toEqual({ bufferWidth: 200, bufferHeight: 300, cssWidth: 200, cssHeight: 300 })
		expect(pdfCanvasDims(200, 300, 2)).toEqual({ bufferWidth: 400, bufferHeight: 600, cssWidth: 200, cssHeight: 300 })
		expect(pdfCanvasDims(200.7, 300.4, 1.5)).toEqual({ bufferWidth: 301, bufferHeight: 450, cssWidth: 200, cssHeight: 300 })
		expect(pdfCanvasDims(100, 100, 0)).toEqual({ bufferWidth: 100, bufferHeight: 100, cssWidth: 100, cssHeight: 100 })
	})

	it("renders with the matching transform", () => {
		expect(pdfRenderTransform(1)).toEqual([1, 0, 0, 1, 0, 0])
		expect(pdfRenderTransform(2)).toEqual([2, 0, 0, 2, 0, 0])
		expect(pdfRenderTransform(-1)).toEqual([1, 0, 0, 1, 0, 0])
	})

	it("lowers the pixel ratio so a page's canvas stays within its byte budget", () => {
		expect(pdfRenderRatio(600, 800, 2, 64 * 1024 * 1024)).toBe(2)

		// A4 at 400 % on a 2x screen: 4762 x 6736 pixels, 128 MB.
		const ratio = pdfRenderRatio(2381, 3368, 2, 64 * 1024 * 1024)
		const dims = pdfCanvasDims(2381, 3368, ratio)

		expect(ratio).toBeLessThan(2)
		expect(dims.bufferWidth * dims.bufferHeight * 4).toBeLessThanOrEqual(64 * 1024 * 1024)
		expect(dims.cssWidth).toBe(2381)
	})

	it("normalizes an annotation's flipped corners into a box", () => {
		expect(pdfBox(110, 40, 10, 20)).toEqual({ left: 10, top: 20, width: 100, height: 20 })
		expect(pdfBox(5, 5, 5, 5)).toEqual({ left: 5, top: 5, width: 0, height: 0 })
	})
})

describe("page render and eviction", () => {
	it("renders a page near the view that has not painted at the current scale", () => {
		expect(pdfPageAction(true, false)).toBe("render")
		expect(pdfPageAction(true, true)).toBe("idle")
	})

	it("releases a page outside the evict margin, finished or not", () => {
		expect(pdfPageAction(false, true)).toBe("evict")
		expect(pdfPageAction(false, false)).toBe("evict")
	})

	it("evicts further out than it renders, so a page at the edge does not thrash", () => {
		expect(PDF_PAGE_EVICT_MARGIN_PX).toBeGreaterThan(PDF_PAGE_RENDER_MARGIN_PX)
	})
})

describe("zoom", () => {
	it("clamps to the supported range", () => {
		expect(clampPdfScale(0)).toBe(PDF_MIN_SCALE)
		expect(clampPdfScale(100)).toBe(PDF_MAX_SCALE)
		expect(clampPdfScale(2)).toBe(2)
	})

	it("steps by one zoom step and stops at the ends", () => {
		expect(pdfStepZoomScale(PDF_BASE_SCALE, 1)).toBeCloseTo(PDF_BASE_SCALE + PDF_ZOOM_STEP, 10)
		expect(pdfStepZoomScale(PDF_BASE_SCALE, -1)).toBeCloseTo(PDF_BASE_SCALE - PDF_ZOOM_STEP, 10)
		expect(pdfStepZoomScale(PDF_MAX_SCALE, 1)).toBe(PDF_MAX_SCALE)
		expect(pdfStepZoomScale(PDF_MIN_SCALE, -1)).toBe(PDF_MIN_SCALE)
	})

	it("steps from a wheel zoom back onto the step grid", () => {
		expect(pdfStepZoomScale(1.6, 1)).toBeCloseTo(1.75, 10)
		expect(pdfStepZoomScale(1.6, -1)).toBeCloseTo(1.5, 10)
	})

	it("zooms in on a wheel up and out on a wheel down, within the range", () => {
		expect(pdfWheelZoomScale(1.5, -100)).toBeGreaterThan(1.5)
		expect(pdfWheelZoomScale(1.5, 100)).toBeLessThan(1.5)
		expect(pdfWheelZoomScale(1.5, -1_000_000)).toBe(PDF_MAX_SCALE)
		expect(pdfWheelZoomScale(1.5, 1_000_000)).toBe(PDF_MIN_SCALE)
	})

	it("shows the base scale as 100 %", () => {
		expect(pdfZoomPercent(PDF_BASE_SCALE)).toBe(100)
		expect(pdfZoomPercent(PDF_MAX_SCALE)).toBe(267)
	})
})

describe("isPdfCommandEnabled", () => {
	const state: PdfViewerState = {
		page: 1,
		pageCount: 3,
		scale: PDF_MIN_SCALE,
		zoom: 33,
		zoomMode: "custom",
		rotation: 0,
		find: { open: true, query: "a", caseSensitive: false, done: true, count: 0, capped: false, active: -1 }
	}

	it("disables what cannot move from where the viewer is", () => {
		expect(isPdfCommandEnabled(state, "page.previous")).toBe(false)
		expect(isPdfCommandEnabled(state, "page.next")).toBe(true)
		expect(isPdfCommandEnabled({ ...state, page: 3 }, "page.next")).toBe(false)
		expect(isPdfCommandEnabled(state, "zoom.out")).toBe(false)
		expect(isPdfCommandEnabled({ ...state, scale: PDF_MAX_SCALE }, "zoom.in")).toBe(false)
		expect(isPdfCommandEnabled(state, "find.next")).toBe(false)
		expect(isPdfCommandEnabled({ ...state, find: { ...state.find, count: 2 } }, "find.previous")).toBe(true)
		expect(isPdfCommandEnabled(state, "find.open")).toBe(true)
		expect(isPdfCommandEnabled(state, "page.first")).toBe(false)
		expect(isPdfCommandEnabled(state, "page.last")).toBe(true)
		expect(isPdfCommandEnabled({ ...state, page: 3 }, "page.last")).toBe(false)
		expect(isPdfCommandEnabled({ ...state, page: 3 }, "page.first")).toBe(true)
	})
})

describe("fit, presets and rotation", () => {
	it("fits a page to the view's width, or whole, within the scale bounds", () => {
		// (432 - 2 × 16) / 200
		expect(pdfFitScale("fitWidth", 200, 400, 432, 300, 1.5)).toBe(2)
		// min(2, (332 - 32) / 400)
		expect(pdfFitScale("fitPage", 200, 400, 432, 332, 1.5)).toBe(0.75)
		expect(pdfFitScale("fitWidth", 10, 10, 2000, 2000, 1.5)).toBe(PDF_MAX_SCALE)
		expect(pdfFitScale("fitPage", 1000, 1000, 200, 200, 1.5)).toBe(PDF_MIN_SCALE)
	})

	it("keeps the scale while the view or the page has no size", () => {
		expect(pdfFitScale("fitWidth", 200, 400, 0, 0, 1.25)).toBe(1.25)
		expect(pdfFitScale("fitPage", 0, 400, 800, 600, 1.25)).toBe(1.25)
		// A view laid out with no height yet fits the width.
		expect(pdfFitScale("fitPage", 200, 400, 432, 0, 1.25)).toBe(2)
	})

	it("turns in 90° steps both ways and adds the page's own rotation", () => {
		expect(pdfRotate(0, 1)).toBe(90)
		expect(pdfRotate(270, 1)).toBe(0)
		expect(pdfRotate(0, -1)).toBe(270)
		expect(pdfPageRotation(90, 270)).toBe(0)
		expect(pdfPageRotation(180, 90)).toBe(270)
	})

	it("reads a menu percent as a scale", () => {
		expect(pdfPercentScale(100)).toBe(PDF_BASE_SCALE)
		expect(pdfPercentScale(50)).toBe(0.75)
		expect(pdfPercentScale(1000)).toBe(PDF_MAX_SCALE)
	})
})
