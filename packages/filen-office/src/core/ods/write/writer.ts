import type { InflateHook } from "../../opc/zipReader"
import type { SheetViewOnlyReason } from "../../sheet/protocol"
import type { XlsxFormatWriter } from "../../xlsx/edit/document"
import type { XlsxWorkbookModel } from "../../xlsx/model/types"
import { odsSource, type OdsSource } from "../source"
import { ContentRefused, missingDeclarations } from "./content"
import { saveOds } from "./save"
import { odsEditBegins, odsEditRefusal } from "./check"
import { misbound, reboundBelowRoot } from "../read/scan"

// Why an OpenDocument workbook can never be saved here, known at open: content past what is materialised (a repeat
// beyond the caps), tables inside cells, or a namespace the writer names by its conventional prefix bound otherwise
// (under another prefix, as the default namespace, or that prefix to another namespace; at the root or below it):
// the writer would pass its elements by unseen.
export function viewOnly(source: OdsSource | undefined): SheetViewOnlyReason | null {
	if (source === undefined) return "legacyFormat"
	if (source.tables.some(table => table.truncated)) return "tooLarge"
	if (source.subTables) return "lossy"
	if (reboundBelowRoot(source.prefixes)) return "lossy"

	for (const [prefix, uri] of source.prefixes) if (misbound(prefix, uri)) return "lossy"

	try {
		missingDeclarations(source.prefixes)
	} catch (error) {
		if (error instanceof ContentRefused) return "lossy"

		throw error
	}

	return null
}

export function odsWriter(workbook: XlsxWorkbookModel, inflate: InflateHook | undefined): XlsxFormatWriter {
	return {
		viewOnly: viewOnly(odsSource(workbook)),
		begin: document => {
			document.workbook.changes.beginJournal?.()
			odsEditBegins(document)
		},
		refused: document => document.workbook.changes.forgetJournal?.(),
		check: (document, touched, command) => odsEditRefusal(document, touched, command),
		save: (document, options) =>
			saveOds(document, {
				untouched: options.untouched,
				...(options.slicing !== undefined && { slicing: options.slicing }),
				...(options.signal !== undefined && { signal: options.signal }),
				...(inflate !== undefined && { inflate })
			})
	}
}
