import type { PdfOpenOptions } from "@filen/office/dom/pdf"
import type { PdfDocumentOptions } from "@filen/office/react/pdf"
import { PDFJS_ASSETS } from "virtual:pdfjs-assets"
import { pdfViewerLimits, type PdfViewerLimits } from "@/features/preview/lib/pdfLimits"

// Vite rewrites `new URL(specifier, import.meta.url)` to a same-origin, content-hashed asset URL, which
// worker-src 'self' covers. pdf.js has no eval path, so the CSP needs nothing more.
export const PDF_WORKER_SRC = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href

export interface PdfViewerSetup {
	readonly limits: PdfViewerLimits
	// What every document opens with, a preview's or a thumbnail's: pdf.js's data files (character maps, standard
	// fonts, image decoders, ICC profile) from this origin (vite/pdfjs-assets-plugin.ts), and decoded images and pdf.js's
	// own canvases capped for the device.
	readonly shared: Pick<PdfOpenOptions, "assets" | "maxImageSize" | "canvasMaxAreaInBytes">
	// The viewer's: a worker script, so every document gets its own worker, destroyed with it (pdf.js tears down the
	// worker of the task it destroys), and the resident limit of a ranged document.
	readonly options: PdfDocumentOptions
}

let built: PdfViewerSetup | null = null

// Built once: the device's limits do not change while the page lives.
export function pdfViewerSetup(): PdfViewerSetup {
	if (built === null) {
		const limits = pdfViewerLimits()
		const shared = {
			assets: { kind: "urls", ...PDFJS_ASSETS },
			maxImageSize: limits.maxImageSize,
			canvasMaxAreaInBytes: limits.canvasMaxAreaInBytes
		} as const

		built = {
			limits,
			shared,
			options: { worker: { kind: "script", src: PDF_WORKER_SRC }, ...shared, residentLimit: limits.residentReopenBytes }
		}
	}

	return built
}
