import { toast } from "sonner"
import type { DocxPdfExportReport } from "@filen/office/dom/docx/pdfClient"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import {
	makePresentationPdf,
	PresentationJobRefused,
	presentationPdfRequest,
	type PresentationPdfChoice
} from "@/features/presentation/lib/presentationJobs"
import { pdfReportKey } from "@/features/preview/lib/docxPdf.logic"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { fileStem } from "@/features/spreadsheet/save/sheetSave.logic"
import { downloadBlob } from "@/lib/downloadBlob"
import { i18n, type PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// File ▸ Export as PDF: slides, notes pages or handouts of the open deck as it is now (unsaved edits included), made
// in a jobs worker and downloaded as "<name>.pdf". A protected deck's PDF is encrypted under its password, which the
// presentation worker holds and never hands out. Offered only where the file may be downloaded (never for a link
// that disallows downloads).

export interface PresentationExportTarget {
	readonly session: PresentationSessionApi
	readonly fileName: string
	// The deck opened with a password: its PDF is protected with it.
	readonly encrypted: boolean
}

let exports = 0

// The toast of one export (progress, Cancel), and what its failure says.
export function exportToast(progressKey: PreviewKey): {
	readonly id: string
	readonly controller: AbortController
	readonly progress: (done: number, total: number) => void
	readonly fail: (error: unknown) => void
} {
	const id = `pptx-export-${String(++exports)}`
	const controller = new AbortController()
	const action = {
		label: i18n.t("preview:previewPptxExportCancel"),
		onClick: () => {
			controller.abort()
		}
	}
	const show = (text: string): void => {
		toast.loading(text, { id, action, duration: Number.POSITIVE_INFINITY })
	}

	show(i18n.t("preview:previewPptxExportPreparing"))

	return {
		id,
		controller,
		progress: (done, total) => {
			show(i18n.t(`preview:${progressKey}`, { done: Math.min(done + 1, total), total }))
		},
		fail: error => {
			toast.dismiss(id)

			if (controller.signal.aborted) return

			const refused = error instanceof PresentationJobRefused ? error.outcome : undefined

			if (refused?.reason === "aborted") return

			if (refused === undefined || refused.reason === "failed") log.error("presentation", "export failed", error)

			toast.error(
				i18n.t(
					refused?.reason === "unsupported" && refused.detail?.includes("password") === true
						? "preview:previewPptxExportPasswordUnsupported"
						: "preview:previewPptxExportFailed"
				)
			)
		}
	}
}

// What a made PDF tells the user beside its download, as a Word document's does: what it left out or simplified.
export function reportPdf(report: DocxPdfExportReport | undefined): void {
	const key = report === undefined ? null : pdfReportKey(report)

	if (report === undefined || key === null) return

	log.warn("presentation", "pdf export simplified", { missing: report.missing, refused: report.refused })
	toast.warning(i18n.t(`preview:${key}`))
}

async function exportPdf(target: PresentationExportTarget, choice: PresentationPdfChoice): Promise<void> {
	const run = exportToast("previewPptxExportPdfProgress")

	try {
		const made = await makePresentationPdf(target.session, presentationPdfRequest(target.fileName, target.encrypted, choice), {
			signal: run.controller.signal,
			onProgress: run.progress
		})

		downloadBlob(`${fileStem(target.fileName)}.pdf`, made.blob)
		toast.dismiss(run.id)
		reportPdf(made.report)
	} catch (error) {
		run.fail(error)
	}
}

// The export, or undefined where it is not offered (downloads disallowed, no open session).
export function usePresentationPdfExport(target: PresentationExportTarget | null): ((choice: PresentationPdfChoice) => void) | undefined {
	const downloadable = usePreviewDownloadable()

	if (target === null || !downloadable) return undefined

	return choice => {
		void exportPdf(target, choice)
	}
}
