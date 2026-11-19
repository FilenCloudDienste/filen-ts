import type { SheetStore } from "../../xlsx/model/store"
import { CellKind, SLOT_BLOCK, type XlsxSheetModel } from "../../xlsx/model/types"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { localizedInput } from "../input/locale"
import { defineSheetFeature } from "../registry"
import { columnEntries, type AutoCompleteCells } from "./autoComplete"

// AutoComplete's entries over an xlsx sheet's store: a typed string (shared or inline) is an entry, a formula's text
// result is not.

function cellsOf(document: XlsxDocument, model: XlsxSheetModel): AutoCompleteCells {
	const store = model.store as SheetStore

	return {
		entry: (row, col) => {
			const slot = store.locate(row, col)
			const block = slot < 0 ? undefined : store.blocks[Math.floor(slot / SLOT_BLOCK)]

			if (block === undefined) return undefined

			const k = slot % SLOT_BLOCK
			const kind = block.kinds[k] ?? CellKind.EMPTY
			const formula = (block.formulas?.[k] ?? -1) >= 0

			if (kind === CellKind.EMPTY && !formula) return undefined

			return formula || (kind !== CellKind.SHARED_STRING && kind !== CellKind.INLINE_STRING)
				? null
				: document.stringOf(model, kind as CellKind, block.values[k] ?? 0)
		}
	}
}

export const xlsxAutoCompleteFeature = defineSheetFeature<XlsxDocument>({
	id: "autoComplete",
	queries: {
		"autoComplete.entries": {
			run: async (context, cell) => {
				const document = context.doc
				const model = await document.ready(cell.sheet, context.slicing, context.signal)
				const found = columnEntries(cellsOf(document, model), cell.row, cell.col, model.store.rowExtent)
				const locale = context.settings.locale

				// What choosing an entry enters is typed as the cell shows it for editing (a quote before text that
				// would read as a number), in the session's locale: read here, for the bounded entries kept, as the
				// Alt+Down list enters it on a pick without asking again.
				return {
					more: found.more,
					entries: found.entries.map(entry => {
						const input = document.cellView(cell.sheet, entry.row, cell.col).input

						return { text: entry.text, input: localizedInput(input ?? entry.text, locale) }
					})
				}
			}
		}
	}
})
