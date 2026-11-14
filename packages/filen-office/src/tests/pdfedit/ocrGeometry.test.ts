import { describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import {
	concatMatrix,
	fitOcrWords,
	imageUprightTurns,
	invertMatrix,
	isOcrCandidate,
	OCR_DEFAULT_DPI,
	OCR_MAX_DPI,
	OCR_MIN_DPI,
	ocrOverlayMatrix,
	ocrRenderDpi,
	quarterTurnMatrix,
	transformPoint,
	type OcrPageSummary,
	type QuarterTurns
} from "../../core/pdfedit/ocrGeometry"
import { ocrPageSummary, renderPageForOcr, type OcrRender } from "../../dom/pdfedit/ocr/page"
import { textStrip, rotateGray, type GrayImage } from "../../dom/pdfedit/ocr/pixels"
import { markerPage, scannedPdf, type MarkerPageOptions } from "./ocrFixtures"

// The bounding box of the dark pixels: [x0, y0, x1, y1] in pixel edges.
function darkBox(image: GrayImage): readonly [number, number, number, number] {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			if ((image.pixels[y * image.stride + x] ?? 255) < 128) {
				x0 = Math.min(x0, x)
				y0 = Math.min(y0, y)
				x1 = Math.max(x1, x + 1)
				y1 = Math.max(y1, y + 1)
			}
		}
	}

	return [x0, y0, x1, y1]
}

// A pixel box mapped through `matrix`, as a normalised rect.
function mapped(matrix: Parameters<typeof transformPoint>[0], box: readonly [number, number, number, number]): number[] {
	const a = transformPoint(matrix, box[0], box[1])
	const b = transformPoint(matrix, box[2], box[3])

	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
}

function render(options: MarkerPageOptions, dpi = 144): OcrRender {
	const document = markerPage(options)

	try {
		return renderPageForOcr(mupdf, document, 0, dpi)
	} finally {
		document.destroy()
	}
}

// A marker in user space must come back to the same user-space rect, within a pixel.
function expectMarker(options: MarkerPageOptions, unit = options.userUnit ?? 1): void {
	const drawn = render(options)
	const tolerance = (72 / drawn.dpi / unit) * 1.01

	const pixelBox = darkBox(drawn)
	const back = mapped(drawn.pixelToPage, pixelBox)

	for (let index = 0; index < 4; index++)
		expect(Math.abs((back[index] ?? 0) - (options.marker[index] ?? 0))).toBeLessThanOrEqual(tolerance)

	// Through the recogniser's overlay space, for every quarter turn of the image it reads.
	for (const turns of [0, 1, 2, 3] as const) {
		const turned = rotateGray(drawn, turns)
		const box = darkBox(turned)
		const scale = 72 / drawn.dpi
		// Overlay space: points, y up, page = the turned image.
		const overlayBox: [number, number, number, number] = [
			box[0] * scale,
			(turned.height - box[3]) * scale,
			box[2] * scale,
			(turned.height - box[1]) * scale
		]
		const page = mapped(ocrOverlayMatrix(drawn.pixelToPage, drawn.width, drawn.height, drawn.dpi, turns), overlayBox)

		for (let index = 0; index < 4; index++)
			expect(Math.abs((page[index] ?? 0) - (options.marker[index] ?? 0))).toBeLessThanOrEqual(tolerance)
	}
}

describe("OCR geometry", () => {
	it("composes and inverts matrices in PDF order", () => {
		const m = concatMatrix([2, 0, 0, 3, 5, 7], [0, 1, -1, 0, 10, 0])

		expect(transformPoint(m, 1, 1)).toEqual([0, 7])
		expect(transformPoint(concatMatrix(m, invertMatrix(m)), 4, -9).map(v => Math.round(v * 1e9) / 1e9)).toEqual([4, -9])
		expect(() => invertMatrix([0, 0, 0, 0, 1, 1])).toThrow(RangeError)
	})

	it("turns pixels the way the quarter-turn matrices say", () => {
		const image: GrayImage = { pixels: new Uint8Array([1, 2, 3, 4, 5, 6, 0, 0]), width: 3, height: 2, stride: 4 }

		expect([...rotateGray(image, 1).pixels]).toEqual([5, 1, 6, 2, 0, 3])
		expect([...rotateGray(image, 2).pixels]).toEqual([0, 6, 5, 3, 2, 1])
		expect([...rotateGray(image, 3).pixels]).toEqual([3, 0, 2, 6, 1, 5])

		for (const turns of [1, 2, 3] as const) {
			const m = quarterTurnMatrix(turns, 3, 2)
			const turned = rotateGray(image, turns)
			const [x, y] = transformPoint(m, 0.5, 1.5)

			expect(turned.pixels[Math.floor(y) * turned.stride + Math.floor(x)]).toBe(5)
		}
	})

	it("shrinks the middle third into a strip", () => {
		const pixels = new Uint8Array(4 * 6).fill(200)

		pixels.fill(0, 2 * 4, 4 * 4)

		const strip = textStrip({ pixels, width: 4, height: 6, stride: 4 }, 2)

		expect([strip.width, strip.height]).toEqual([2, 1])
		expect([...strip.pixels]).toEqual([0, 0])

		// Ink only in the bottom third: that band.
		const low = new Uint8Array(4 * 6).fill(255)

		low.fill(0, 4 * 4, 6 * 4)
		expect([...textStrip({ pixels: low, width: 4, height: 6, stride: 4 }, 2).pixels]).toEqual([0, 0])
	})

	it("stretches recognised words so their letters fill the word's box", () => {
		const content = "82.364 Tz [ <0054006800650020> ] TJ 43.2 0 Td 93.454 Tz [ <00310032> ] TJ 50 Tz [ <0020> ] TJ"

		expect(fitOcrWords(content)).toBe("109.819 Tz [ <0054006800650020> ] TJ 43.2 0 Td 93.454 Tz [ <00310032> ] TJ 50 Tz [ <0020> ] TJ")
	})

	it("maps pixels back to user space", () => {
		expectMarker({ marker: [100, 200, 180, 260] })
	})

	it("honours a CropBox offset", () => {
		expectMarker({ mediaBox: [0, 0, 612, 792], cropBox: [50, 70, 500, 700], marker: [100, 200, 180, 260] })
		expectMarker({ mediaBox: [-100, -50, 512, 742], cropBox: [-80, -20, 400, 600], marker: [-60, 0, 20, 90] })
	})

	it.each([90, 180, 270] as const)("honours /Rotate %i", rotate => {
		expectMarker({ rotate, cropBox: [30, 40, 580, 760], marker: [100, 200, 180, 260] })
	})

	it("honours /UserUnit", () => {
		const drawn = render({ userUnit: 2, marker: [100, 200, 180, 260] }, 72)

		// Twice as many pixels per user unit.
		expect(drawn.width).toBe(1224)
		expectMarker({ userUnit: 2, rotate: 90, marker: [100, 200, 180, 260] })
	})

	it("reads a scan's image and characters", () => {
		const document = new mupdf.PDFDocument(scannedPdf({ lines: ["Hello"], dpi: 150, footer: "12" }))

		const page = document.loadPage(0)
		const summary = ocrPageSummary(mupdf, page)

		expect(summary.chars).toBe(2)
		expect(summary.images).toHaveLength(1)
		expect(summary.images[0]?.dpi).toBeCloseTo(150, 5)
		expect(summary.images[0]?.area).toBeCloseTo(612 * 792, 0)
		expect(isOcrCandidate(summary)).toBe(true)
		expect(ocrRenderDpi(summary)).toBe(OCR_MIN_DPI)
		page.destroy()
		document.destroy()
	})

	it.each([1, 2, 3] as const)("renders a scan placed with %i quarter turn(s) upright", turns => {
		const document = new mupdf.PDFDocument(scannedPdf({ lines: ["Hello"], dpi: 200, imageTurns: turns }))

		const page = document.loadPage(0)
		const summary = ocrPageSummary(mupdf, page)

		page.destroy()

		expect(summary.images[0]?.upright).toBe((4 - turns) % 4)

		const drawn = renderPageForOcr(mupdf, document, 0)

		// Portrait again, and the text near the top.
		expect(drawn.height).toBeGreaterThan(drawn.width)
		expect(darkBox(drawn)[1]).toBeLessThan(drawn.height / 4)
		document.destroy()
	})
})

describe("OCR page rules", () => {
	const page = (chars: number, images: OcrPageSummary["images"]): OcrPageSummary => ({ width: 600, height: 800, chars, images })

	it("picks pages with (near) no characters and one image over half the page", () => {
		expect(isOcrCandidate(page(0, [{ area: 240_000, dpi: 300, upright: 0 }]))).toBe(true)
		expect(isOcrCandidate(page(20, [{ area: 480_000, dpi: 300, upright: 0 }]))).toBe(true)
		expect(isOcrCandidate(page(21, [{ area: 480_000, dpi: 300, upright: 0 }]))).toBe(false)
		expect(isOcrCandidate(page(0, [{ area: 239_999, dpi: 300, upright: 0 }]))).toBe(false)
		expect(
			isOcrCandidate(
				page(0, [
					{ area: 200_000, dpi: 300, upright: 0 },
					{ area: 200_000, dpi: 300, upright: 0 }
				])
			)
		).toBe(false)
		expect(isOcrCandidate(page(0, []))).toBe(false)
	})

	it("renders at the largest image's resolution within bounds", () => {
		const one = (dpi: number): OcrPageSummary =>
			page(0, [
				{ area: 10, dpi: 72, upright: 0 },
				{ area: 400_000, dpi, upright: 0 }
			])

		expect(ocrRenderDpi(page(0, []))).toBe(OCR_DEFAULT_DPI)
		expect(ocrRenderDpi(one(300))).toBe(300)
		expect(ocrRenderDpi(one(240.4))).toBe(240)
		expect(ocrRenderDpi(one(600))).toBe(OCR_MAX_DPI)
		expect(ocrRenderDpi(one(96))).toBe(OCR_MIN_DPI)
	})

	it("tells how an image is turned", () => {
		const turns = (m: readonly [number, number, number, number, number, number]): QuarterTurns => imageUprightTurns(m)

		expect(turns([100, 0, 0, 200, 5, 5])).toBe(0)
		expect(turns([0, 100, -200, 0, 300, 0])).toBe(3)
		expect(turns([-100, 0, 0, -200, 100, 200])).toBe(2)
		expect(turns([0, -100, 200, 0, 0, 100])).toBe(1)
		// Mirrored or sheared: left alone.
		expect(turns([-100, 0, 0, 200, 0, 0])).toBe(0)
		expect(turns([100, 30, 0, 200, 0, 0])).toBe(0)
	})
})
