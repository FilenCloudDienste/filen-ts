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
	// Largest image pdf.js decodes, in pixels. pdf.js removes a larger image from the page (it does not scale it down),
	// so this is a guard against a decode the tab could not survive, set well above real content.
	readonly maxImageSize: number
	// Largest canvas pdf.js allocates itself, in bytes; an image with more pixels (a quarter of this) is decoded and then
	// scaled down to fit it.
	readonly canvasMaxAreaInBytes: number
}

// An image pdf.js decodes takes about 11 bytes a pixel at its peak: its samples, an RGBA copy and the bitmap scaled down
// from it. The desktop guard (160 Mpx, at most about 1.8 GB for a moment) passes an A0 poster at 300 dpi (140 Mpx) and an
// A3 scan at 600 dpi (70 Mpx); the mobile one (48 Mpx, about 530 MB) an A4 or Letter scan at 600 dpi (35 Mpx) and an A2
// poster at 300 dpi (35 Mpx). A dropped image cannot be told to the user: pdf.js reports it only as a console warning in
// its worker, which the viewer silences (verbosity ERRORS: warnings quote document content), and its API says nothing.
// pdf.js's own viewer caps a mobile canvas at 5,242,880 pixels (4 bytes each); the desktop value is the page canvas cap
// of @filen/office's viewer (64 MiB).
const MPX = 1_000_000
const DESKTOP: PdfViewerLimits = { maxImageSize: 160 * MPX, canvasMaxAreaInBytes: 64 * MIB }
const MOBILE: PdfViewerLimits = { maxImageSize: 48 * MPX, canvasMaxAreaInBytes: 5_242_880 * 4 }

export function pdfViewerLimits(): PdfViewerLimits {
	return pdfMemoryConstrained() ? MOBILE : DESKTOP
}

// Searching or printing every page of a larger file first says how much will be read.
export const PDF_FULL_READ_WARN_BYTES = 256 * MIB

// No largest viewable file: pdf.js allocates one zeroed buffer of the file's whole length for a ranged document, but
// the pages a zeroed allocation never writes are not resident. Measured in WebKit, Chromium and Firefox on sparse files
// of 4 MiB to 8 GiB: page 1 painted in each, and the tab's resident memory stayed within a few MiB of the 4 MiB file's.
// What costs memory is what is read, which the full-read guard above asks about.
