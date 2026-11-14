import { describe, expect, it } from "vitest"
import {
	defaultPdfPrintForm,
	pdfPrintCanvas,
	pdfPrintEncoding,
	pdfPrintMemoryBytes,
	pdfPrintPermissions,
	pdfPrintQualities,
	pdfPrintRanges,
	PDF_PRINT_DESKTOP_MAX_PIXELS,
	PDF_PRINT_MOBILE_MAX_PIXELS
} from "@/features/pdf/print/pdfPrint.logic"

// A PDF print's pages, resolution, memory estimate and page encoding.

const A4 = { width: 595.28, height: 841.89 }

describe("PDF print pages", () => {
	it("prints all pages, the one in view, or typed ranges", () => {
		const form = defaultPdfPrintForm()

		expect(pdfPrintRanges(form, 12, 4)).toEqual([{ first: 1, last: 12 }])
		expect(pdfPrintRanges({ ...form, pages: "current" }, 12, 4)).toEqual([{ first: 4, last: 4 }])
		expect(pdfPrintRanges({ ...form, pages: "range", range: "10-, 1-2" }, 12, 4)).toEqual([
			{ first: 1, last: 2 },
			{ first: 10, last: 12 }
		])
	})

	it("prints nothing for a range it cannot read", () => {
		const form = { ...defaultPdfPrintForm(), pages: "range" as const }

		expect(pdfPrintRanges({ ...form, range: "" }, 12, 1)).toBeNull()
		expect(pdfPrintRanges({ ...form, range: "13" }, 12, 1)).toBeNull()
		expect(pdfPrintRanges(defaultPdfPrintForm(), 0, 1)).toBeNull()
	})
})

describe("PDF print quality and permissions", () => {
	it("offers High on a desktop where the author allows it", () => {
		const all = pdfPrintPermissions(null)

		expect(pdfPrintQualities(false, all)).toEqual(["standard", "high"])
		expect(pdfPrintQualities(true, all)).toEqual(["standard"])
	})

	it("reads the author's print flags", () => {
		expect(pdfPrintPermissions(new Set([0x04, 0x800]))).toEqual({ print: true, highQuality: true })
		expect(pdfPrintPermissions(new Set([0x04]))).toEqual({ print: true, highQuality: false })
		expect(pdfPrintPermissions(new Set([0x800]))).toEqual({ print: false, highQuality: false })
		expect(pdfPrintQualities(false, pdfPrintPermissions(new Set([0x04])))).toEqual(["standard"])
	})
})

describe("PDF print canvases", () => {
	it("draws at the chosen resolution", () => {
		expect(pdfPrintCanvas(A4.width, A4.height, 150, PDF_PRINT_DESKTOP_MAX_PIXELS)).toEqual({
			width: 1240,
			height: 1753,
			scale: 150 / 72
		})
	})

	it("stays under a phone's canvas cap", () => {
		const canvas = pdfPrintCanvas(A4.width * 2, A4.height * 2, 150, PDF_PRINT_MOBILE_MAX_PIXELS)

		expect(canvas.width * canvas.height).toBeLessThanOrEqual(PDF_PRINT_MOBILE_MAX_PIXELS)
		expect(canvas.width / canvas.height).toBeCloseTo(A4.width / A4.height, 2)
	})

	it("estimates the decoded bytes of the pages", () => {
		expect(pdfPrintMemoryBytes(100, A4.width, A4.height, 300, PDF_PRINT_DESKTOP_MAX_PIXELS)).toBe(100 * 2480 * 3507 * 4)
	})
})

describe("PDF print page encoding", () => {
	function sample(colour: (index: number) => readonly [number, number, number]): Uint8ClampedArray {
		const out = new Uint8ClampedArray(64 * 64 * 4)

		for (let index = 0; index < 64 * 64; index++) {
			const [r, g, b] = colour(index)

			out.set([r, g, b, 255], index * 4)
		}

		return out
	}

	it("keeps text and drawings lossless", () => {
		expect(
			pdfPrintEncoding(sample(index => (index % 7 === 0 ? [0, 0, 0] : index % 11 === 0 ? [128, 128, 128] : [255, 255, 255])))
		).toBe("image/png")
	})

	it("encodes a picture-like page as JPEG", () => {
		expect(pdfPrintEncoding(sample(index => [(index % 64) * 4, (index >> 6) * 4, (index * 37) % 256]))).toBe("image/jpeg")
	})
})
