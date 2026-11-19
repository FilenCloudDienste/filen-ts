import type { DocxPdfErrorReason, DocxPdfExportReport, DocxPdfProgress } from "@filen/office/dom/docx/pdfClient"
import { fileStem } from "@filen/shared"
import type { PreviewKey } from "@/lib/i18n"

// Download as PDF, the parts without a DOM: the file name, what the progress toast says, and what the outcome
// tells the user.

// "Report.docx" → "Report.pdf"; the title of a document without one of its own is its stem.
export function pdfDownloadName(fileName: string): string {
	return `${fileStem(fileName)}.pdf`
}

export function pdfTitle(fileName: string): string {
	return fileStem(fileName)
}

export type PdfProgressText =
	{ readonly key: "previewDocxPdfPreparing" } | { readonly key: "previewDocxPdfProgress"; readonly done: number; readonly total: number }

// Pages are counted once the painter runs; laying the document out comes before and shows as preparing.
export function pdfProgressText(progress: DocxPdfProgress | null): PdfProgressText {
	if (progress?.phase !== "pages" || progress.total <= 0) {
		return { key: "previewDocxPdfPreparing" }
	}

	return { key: "previewDocxPdfProgress", done: Math.min(progress.done + 1, progress.total), total: progress.total }
}

// What a finished export tells the user beside the download: characters no font had, then content of the file
// its pages lack (shapes, equations, objects: which pictures left out are part of), then pictures that could not be
// read, then text drawn without its font's shaping. Links a policy refused say nothing: their text is there, as on
// screen where they do not open either.
export function pdfReportKey(report: DocxPdfExportReport): PreviewKey | null {
	if (report.missing.some(([, count]) => count > 0)) {
		return "previewDocxPdfMissingGlyphs"
	}

	if (report.refused.some(([kind, count]) => kind === "untranslated" && count > 0)) {
		return "previewDocxPdfContentLeftOut"
	}

	if (report.refused.some(([kind, count]) => kind !== "link" && kind !== "shaping" && count > 0)) {
		return "previewDocxPdfSimplified"
	}

	if (report.refused.some(([kind, count]) => kind === "shaping" && count > 0)) {
		return "previewDocxPdfUnshaped"
	}

	return null
}

// A failure the user is told about; an abort (their own Cancel) says nothing.
export function pdfErrorKey(reason: DocxPdfErrorReason): PreviewKey | null {
	if (reason === "aborted") {
		return null
	}

	return reason === "passwordUnsupported" ? "previewDocxPdfPasswordUnsupported" : "previewDocxPdfFailed"
}
