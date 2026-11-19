import { toast } from "sonner"
import type { SheetSessionApi } from "@filen/office/core/sheet"
import { MAX_PRINT_PAGES } from "@filen/office/core/sheet/print"
import { sheetPdf, type SheetPdfRequest } from "@filen/office/react/sheet/print"
import { fileStem } from "@/features/spreadsheet/save/sheetSave.logic"
import { downloadBlob } from "@/lib/downloadBlob"
import { PDF_DETERMINISTIC } from "@/features/office/lib/pdfTestMode"
import { i18n, type PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// Download as PDF for a spreadsheet: the print made in the sheet worker beside the session (cells, objects and
// charts never cross to the page), with a toast that counts the pages and can cancel. A local download: the file in
// the drive is unchanged.

let exports = 0

export function pdfDownloadName(fileName: string): string {
	return `${fileStem(fileName)}.pdf`
}

type SheetPdfOutcome = Awaited<ReturnType<typeof sheetPdf>>

// The print made in the worker (see sheetPdf); `password` (a protected workbook's, checked first) encrypts the PDF
// and goes with this export only.
export function makeSheetPdf(
	session: SheetSessionApi,
	request: SheetPdfRequest,
	options: {
		readonly signal: AbortSignal
		readonly onProgress: (done: number, total: number) => void
		readonly password?: string | undefined
	}
): Promise<SheetPdfOutcome> {
	return sheetPdf(session, request, {
		signal: options.signal,
		onProgress: options.onProgress,
		...(options.password !== undefined && { password: options.password }),
		...(PDF_DETERMINISTIC && { deterministic: true })
	})
}

export interface SheetPdfMessage {
	readonly key: PreviewKey
	readonly values: Readonly<Record<string, number>>
}

// What an export tells the user (logged): beside a made PDF, what it simplified; a refused or failed one, why. A
// session closed while the PDF was made (the user left) tells nothing.
export function sheetPdfMessages(result: SheetPdfOutcome): {
	readonly warnings: SheetPdfMessage[]
	readonly error: SheetPdfMessage | null
} {
	if (result.ok) {
		const warnings: SheetPdfMessage[] = []

		if (result.missingGlyphs > 0 || result.missingImages > 0 || result.missingObjects > 0) {
			log.warn("preview", "spreadsheet pdf simplified", {
				glyphs: result.missingGlyphs,
				images: result.missingImages,
				objects: result.missingObjects
			})
			warnings.push({ key: "previewSheetPdfSimplified", values: {} })
		}

		if (result.unshapedRuns > 0) {
			log.warn("preview", "spreadsheet pdf unshaped", { runs: result.unshapedRuns })
			warnings.push({ key: "previewSheetPdfUnshaped", values: {} })
		}

		return { warnings, error: null }
	}

	switch (result.reason) {
		case "closed":
			return { warnings: [], error: null }
		case "nothing":
			return { warnings: [], error: { key: "previewSheetPdfNothing", values: {} } }
		case "tooManyPages":
			return { warnings: [], error: { key: "previewSheetPdfTooMany", values: { pages: MAX_PRINT_PAGES } } }
		case "passwordUnsupported":
			return { warnings: [], error: { key: "previewSheetPdfPasswordUnsupported", values: {} } }
		case "pageTooLarge":
			return { warnings: [], error: { key: "previewSheetPdfPageTooLarge", values: { page: result.pages ?? 1 } } }
		default:
			return { warnings: [], error: { key: "previewSheetPdfFailed", values: {} } }
	}
}

function messageText(message: SheetPdfMessage): string {
	return Object.keys(message.values).length === 0 ? i18n.t(`preview:${message.key}`) : i18n.t(`preview:${message.key}`, message.values)
}

// `password` (a protected workbook's, checked first) encrypts the PDF; it goes with this export only.
export async function downloadSheetPdf(
	session: SheetSessionApi,
	request: SheetPdfRequest,
	fileName: string,
	password?: string
): Promise<void> {
	const id = `sheet-pdf-${String(++exports)}`
	const controller = new AbortController()
	const action = {
		label: i18n.t("preview:previewSheetPdfCancel"),
		onClick: () => {
			controller.abort()
		}
	}
	const show = (done: number | null, total: number): void => {
		toast.loading(
			done === null ? i18n.t("preview:previewSheetPdfPreparing") : i18n.t("preview:previewSheetPdfProgress", { done, total }),
			{ id, action, duration: Number.POSITIVE_INFINITY }
		)
	}

	show(null, 0)

	try {
		const result = await makeSheetPdf(session, request, { signal: controller.signal, onProgress: show, password })

		toast.dismiss(id)

		if (result.ok) {
			downloadBlob(pdfDownloadName(fileName), result.blob)
		}

		const { warnings, error } = sheetPdfMessages(result)

		for (const warning of warnings) {
			toast.warning(messageText(warning))
		}

		if (error !== null) {
			toast.error(messageText(error))
		}
	} catch (error) {
		toast.dismiss(id)

		// The user's own Cancel says nothing.
		if (controller.signal.aborted) {
			return
		}

		log.error("preview", "spreadsheet pdf failed", error)
		toast.error(i18n.t("preview:previewSheetPdfFailed"))
	}
}
