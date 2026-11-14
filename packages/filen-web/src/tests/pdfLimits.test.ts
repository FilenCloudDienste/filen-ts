import { describe, expect, it, vi } from "vitest"
import { pdfViewerLimits } from "@/features/preview/lib/pdfLimits"

// pdf.js removes an image above maxImageSize from the page rather than scaling it down: the guard must pass real
// documents' images (scans, posters) and stop only a decode the tab could not survive.

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

// Pixels of a page of `widthMm` x `heightMm` scanned at `dpi`.
function scan(widthMm: number, heightMm: number, dpi: number): number {
	return Math.round((widthMm / 25.4) * dpi) * Math.round((heightMm / 25.4) * dpi)
}

// Bytes pdf.js holds at the peak of decoding an image: samples, an RGBA copy and the scaled-down bitmap.
const PEAK_BYTES_PER_PIXEL = 11
const GIB = 1024 * 1024 * 1024

function limitsOn(userAgent: string): ReturnType<typeof pdfViewerLimits> {
	vi.stubGlobal("navigator", { userAgent, maxTouchPoints: userAgent === IPHONE ? 5 : 0 })

	return pdfViewerLimits()
}

describe("the PDF viewer's image guard", () => {
	it("draws an A0 poster at 300 dpi and an A3 scan at 600 dpi on a desktop", () => {
		const { maxImageSize } = limitsOn(DESKTOP)

		expect(maxImageSize).toBeGreaterThanOrEqual(scan(841, 1189, 300))
		expect(maxImageSize).toBeGreaterThanOrEqual(scan(297, 420, 600))
		expect(maxImageSize * PEAK_BYTES_PER_PIXEL).toBeLessThanOrEqual(2 * GIB)
	})

	it("draws A4 and Letter scans at 600 dpi and an A2 poster at 300 dpi on a phone", () => {
		const { maxImageSize } = limitsOn(IPHONE)

		expect(maxImageSize).toBeGreaterThanOrEqual(scan(210, 297, 600))
		expect(maxImageSize).toBeGreaterThanOrEqual(scan(215.9, 279.4, 600))
		expect(maxImageSize).toBeGreaterThanOrEqual(scan(420, 594, 300))
		expect(maxImageSize * PEAK_BYTES_PER_PIXEL).toBeLessThanOrEqual(0.6 * GIB)
	})

	it("scales larger images down to pdf.js's canvas cap rather than holding them whole", () => {
		expect(limitsOn(DESKTOP).canvasMaxAreaInBytes).toBe(64 * 1024 * 1024)
		expect(limitsOn(IPHONE).canvasMaxAreaInBytes).toBe(5_242_880 * 4)
	})
})
