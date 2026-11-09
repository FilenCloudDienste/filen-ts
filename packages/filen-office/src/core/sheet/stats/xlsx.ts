import type { SheetStore } from "../../xlsx/model/store"
import { CellKind, ColFlag, RowFlag, type XlsxSheetModel } from "../../xlsx/model/types"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { formatGeneral } from "../numfmt"
import type { SheetRange } from "../protocol"
import { defineSheetFeature } from "../registry"
import { SelectionStatsTally, type SheetSelectionStats } from "./stats"

// The status bar's summary over an xlsx sheet's store: each range's stored cells, as they show.

function hiddenColsOf(model: XlsxSheetModel): number[] {
	const hidden: number[] = []

	for (const range of model.cols) if ((range.flags & ColFlag.HIDDEN) !== 0) hidden.push(range.first, range.last)

	return hidden
}

function colHidden(hidden: readonly number[], col: number): boolean {
	for (let i = 0; i + 1 < hidden.length; i += 2) if (col >= (hidden[i] ?? 0) && col <= (hidden[i + 1] ?? 0)) return true

	return false
}

export function xlsxSelectionStats(
	document: XlsxDocument,
	model: XlsxSheetModel,
	ranges: readonly SheetRange[],
	version: number
): SheetSelectionStats {
	const store = model.store as SheetStore
	const blocks = store.blocks
	const hiddenCols = hiddenColsOf(model)
	const protectedSheet = model.protection !== null
	const tally = new SelectionStatsTally<number>()

	for (const range of ranges) {
		for (let b = Math.max(0, store.blockOf(range.startRow)); b < blocks.length; b++) {
			const block = blocks[b]

			if (block === undefined) continue
			if (block.firstRow > range.endRow) break

			const formulas = block.formulas

			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				if (row < range.startRow) continue
				if (row > range.endRow) break
				if (((block.rowFlags[i] ?? 0) & RowFlag.HIDDEN) !== 0) continue

				const end = block.rowStarts[i + 1] ?? 0

				for (let k = block.rowStarts[i] ?? 0; k < end; k++) {
					const col = block.cols[k] ?? 0

					if (col < range.startCol) continue
					if (col > range.endCol) break

					const kind = (block.kinds[k] ?? CellKind.EMPTY) as CellKind
					const formula = formulas?.[k] ?? -1

					// A cell kept only for its format holds nothing.
					if (kind === CellKind.EMPTY && formula < 0) continue
					if (hiddenCols.length > 0 && colHidden(hiddenCols, col)) continue

					const xf = block.styles[k] ?? 0

					// Protection that hides the whole cell shows nothing there.
					if (protectedSheet && document.styles.protection(xf)?.hideAll === true) continue

					const value = document.shownValue(model, row, col, kind, block.values[k] ?? 0, formula)

					if (typeof value === "number") tally.number(value, xf)
					else if (typeof value === "string" && !value.startsWith("'")) tally.fail()
					else tally.text()
				}
			}
		}
	}

	return tally.result((xf, value) => (xf === undefined ? formatGeneral(value) : document.formatNumber(xf, value)), version)
}

export const xlsxSelectionStatsFeature = defineSheetFeature<XlsxDocument>({
	id: "selectionStats",
	queries: {
		selectionStats: {
			run: async (context, request) =>
				xlsxSelectionStats(
					context.doc,
					await context.doc.ready(request.sheet, context.slicing, context.signal),
					request.ranges,
					context.version
				)
		}
	}
})
