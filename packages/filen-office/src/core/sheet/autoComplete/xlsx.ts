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
	const at = (row: number, col: number): { kind: number; value: number; formula: boolean } | null => {
		const slot = store.locate(row, col)

		if (slot < 0) return null

		const block = store.blocks[Math.floor(slot / SLOT_BLOCK)]
		const k = slot % SLOT_BLOCK

		return block === undefined
			? null
			: { kind: block.kinds[k] ?? CellKind.EMPTY, value: block.values[k] ?? 0, formula: (block.formulas?.[k] ?? -1) >= 0 }
	}

	return {
		filled: (row, col) => {
			const cell = at(row, col)

			return cell !== null && (cell.kind !== CellKind.EMPTY || cell.formula)
		},
		text: (row, col) => {
			const cell = at(row, col)

			return cell === null || cell.formula || (cell.kind !== CellKind.SHARED_STRING && cell.kind !== CellKind.INLINE_STRING)
				? null
				: document.stringOf(model, cell.kind as CellKind, cell.value)
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
				// would read as a number), in the session's locale.
				return {
					entries: found.map(entry => {
						const input = document.cellView(cell.sheet, entry.row, cell.col).input

						return { text: entry.text, input: localizedInput(input ?? entry.text, locale) }
					})
				}
			}
		}
	}
})
