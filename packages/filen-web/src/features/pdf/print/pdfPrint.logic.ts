import { parsePageRanges, type PageRange } from "@filen/office/core/pdfedit/pageRanges"
import { PDF_MAX_PAGE_CANVAS_BYTES } from "@filen/office/react/pdf"

// What a PDF print is made of, as pure functions: which pages, at what resolution, how much memory the pages take
// once the browser decoded them, and how each page is encoded into the print root.

export type PdfPrintPages = "all" | "current" | "range"

export type PdfPrintQuality = "standard" | "high"

export interface PdfPrintForm {
	readonly pages: PdfPrintPages
	// The range field's text (pages "range").
	readonly range: string
	readonly quality: PdfPrintQuality
	readonly annotations: boolean
}

export const PDF_PRINT_DPI: Readonly<Record<PdfPrintQuality, number>> = { standard: 150, high: 300 }

// pdf.js's own viewer caps a phone's canvas at this many pixels; a desktop's page canvas is capped as on screen.
export const PDF_PRINT_MOBILE_MAX_PIXELS = 5_242_880
export const PDF_PRINT_DESKTOP_MAX_PIXELS = PDF_MAX_PAGE_CANVAS_BYTES / 4

// Above this many decoded bytes the dialog warns that printing may fail; it never refuses.
export const PDF_PRINT_MEMORY_WARN_BYTES = 500 * 1024 * 1024

// pdf.js PermissionFlag.
const PERMISSION_PRINT = 0x04
const PERMISSION_PRINT_HIGH_QUALITY = 0x800

export interface PdfPrintPermissions {
	readonly print: boolean
	readonly highQuality: boolean
}

// What the document's author allows (pdf.js getPermissions: null when the document sets no restrictions).
export function pdfPrintPermissions(flags: ReadonlySet<number> | null): PdfPrintPermissions {
	if (flags === null) return { print: true, highQuality: true }

	return { print: flags.has(PERMISSION_PRINT), highQuality: flags.has(PERMISSION_PRINT) && flags.has(PERMISSION_PRINT_HIGH_QUALITY) }
}

export function defaultPdfPrintForm(): PdfPrintForm {
	return { pages: "all", range: "", quality: "standard", annotations: true }
}

// The qualities offered: Standard alone on a phone or where the author allows only low-quality printing.
export function pdfPrintQualities(constrained: boolean, permissions: PdfPrintPermissions): readonly PdfPrintQuality[] {
	return constrained || !permissions.highQuality ? ["standard"] : ["standard", "high"]
}

// The pages the form prints (1-based ranges), or null while the range field cannot be read.
export function pdfPrintRanges(form: PdfPrintForm, pageCount: number, current: number): readonly PageRange[] | null {
	if (form.pages === "all") return pageCount > 0 ? [{ first: 1, last: pageCount }] : null
	if (form.pages === "current") return current >= 1 && current <= pageCount ? [{ first: current, last: current }] : null

	const parsed = parsePageRanges(form.range, pageCount)

	return parsed.ok ? parsed.ranges : null
}

export interface PdfPrintCanvas {
	// Device pixels.
	readonly width: number
	readonly height: number
	// pdf.js viewport scale: CSS pixels (points at scale 1) to device pixels.
	readonly scale: number
}

// The canvas a page of `widthPt` × `heightPt` prints on at `dpi`, scaled down to at most `maxPixels`.
export function pdfPrintCanvas(widthPt: number, heightPt: number, dpi: number, maxPixels: number): PdfPrintCanvas {
	const wanted = dpi / 72
	const area = widthPt * heightPt * wanted * wanted
	const scale = area > maxPixels ? Math.sqrt(maxPixels / (widthPt * heightPt)) : wanted

	return { width: Math.max(1, Math.floor(widthPt * scale)), height: Math.max(1, Math.floor(heightPt * scale)), scale }
}

// The bytes `count` pages of the given size take decoded (4 per pixel), as the browser holds them while printing. The
// pages are estimated from one page's size: reading every page's size first would read the whole document.
export function pdfPrintMemoryBytes(count: number, widthPt: number, heightPt: number, dpi: number, maxPixels: number): number {
	const canvas = pdfPrintCanvas(widthPt, heightPt, dpi, maxPixels)

	return count * canvas.width * canvas.height * 4
}

// Distinct colours (5 bits a channel) a sample needs to be a picture rather than text and drawings.
const PHOTO_COLOURS = 256

// How a printed page is encoded: JPEG (quality 0.9) for a picture-like page (a scan, a photo), lossless PNG for text and
// drawings, judged from a small downscaled sample of the rendered page (RGBA) by how many colours it holds. Pages of
// text and line art hold few colours (paper, ink, anti-aliasing between them); scans and photos hold many. The page's
// operator list would tell its content exactly, but pdf.js builds that list apart from the one a render uses, so asking
// for it would parse the page and decode its images a second time.
export function pdfPrintEncoding(sample: Uint8ClampedArray): "image/jpeg" | "image/png" {
	const seen = new Set<number>()

	for (let at = 0; at + 3 < sample.length; at += 4) {
		seen.add((((sample[at] ?? 0) >> 3) << 10) | (((sample[at + 1] ?? 0) >> 3) << 5) | ((sample[at + 2] ?? 0) >> 3))

		if (seen.size > PHOTO_COLOURS) return "image/jpeg"
	}

	return "image/png"
}
