import { parseUserAgent } from "@filen/shared"
import { isAppleMobile } from "@/lib/appleMobile"

// Memory limits of the PDF viewer and editor. A phone's tab is killed far sooner than a desktop's, so every limit has a
// mobile value; one module, so the viewer, printing and the editor use the same figures.

const MIB = 1024 * 1024

// A phone or tablet: iOS/iPadOS WebKit and Android.
export function pdfMemoryConstrained(): boolean {
	return isAppleMobile() || parseUserAgent(navigator.userAgent).os === "Android"
}

export interface PdfViewerLimits {
	// Largest image pdf.js decodes, in pixels; larger ones are skipped.
	readonly maxImageSize: number
	// Largest canvas pdf.js allocates itself (patterns, masks), in bytes.
	readonly canvasMaxAreaInBytes: number
}

// pdf.js's own viewer caps a mobile canvas at 5,242,880 pixels (4 bytes each); the desktop value is the page canvas cap
// of @filen/office's viewer (64 MiB).
const DESKTOP: PdfViewerLimits = { maxImageSize: 64 * 1024 * 1024, canvasMaxAreaInBytes: 64 * MIB }
const MOBILE: PdfViewerLimits = { maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: 5_242_880 * 4 }

export function pdfViewerLimits(): PdfViewerLimits {
	return pdfMemoryConstrained() ? MOBILE : DESKTOP
}

// Searching or printing every page of a larger file first says how much will be read.
export const PDF_FULL_READ_WARN_BYTES = 256 * MIB
