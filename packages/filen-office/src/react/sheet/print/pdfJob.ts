import type { PdfFontAssets } from "../../../core/pdfwrite/fonts/assets"
import type { Slicing } from "../../../core/slicing"
import type { SheetWorkerJob } from "../../../dom/sheet/worker"
import { exportSheetPdf } from "./pdfExport"
import { SHEET_PDF_JOB, type SheetPdfJobArgs, type SheetPdfJobResult } from "./pdfClient"

// The print-to-PDF job a sheet worker serves (serveSheetWorker(scope, opener, { [SHEET_PDF_JOB]: sheetPdfJob(…) })):
// the PDF made beside the session and handed to the page as one Blob. A password (a protected workbook's, checked
// first) encrypts it; it is used for this export only. Progress is reported at most every PROGRESS_MS, and at the end.

const PROGRESS_MS = 100

// Slices of 8 ms between macrotask turns: an abort from the page is heard between pages and, on a large page drawn in
// slices, between its slices and table rows; the session serves the grid in the same turns.
const WORKER_SLICING: Slicing = {
	sliceMs: 8,
	now: () => performance.now(),
	pause: () =>
		new Promise<void>(resolve => {
			setTimeout(resolve, 0)
		})
}

export function sheetPdfJob(assets: PdfFontAssets, slicing: Slicing = WORKER_SLICING): Readonly<Record<string, SheetWorkerJob>> {
	return {
		[SHEET_PDF_JOB]: async (args, context): Promise<SheetPdfJobResult> => {
			let last = 0
			const { request, password, deterministic } = args as SheetPdfJobArgs
			const result = await exportSheetPdf(request, {
				session: context.session,
				assets,
				slicing,
				signal: context.signal,
				...(password !== undefined && { password }),
				...(deterministic === true && { deterministic: true }),
				progress: (done, total) => {
					const now = slicing.now()

					if (done === total || now - last >= PROGRESS_MS) {
						last = now
						context.progress({ done, total })
					}
				}
			})

			if (!result.ok) return result

			return {
				ok: true,
				blob: new Blob(result.output.parts as ConstructorParameters<typeof Blob>[0], { type: "application/pdf" }),
				pages: result.pages,
				missingImages: result.missingImages,
				missingObjects: result.missingObjects,
				missingGlyphs: result.missingGlyphs,
				unshapedRuns: result.unshapedRuns
			}
		}
	}
}
