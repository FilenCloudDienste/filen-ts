import type { RowBlock, SheetStore } from "../../xlsx/model/store"
import { CellKind, ColFlag, RowFlag, SLOT_BLOCK, type XlsxSheetModel } from "../../xlsx/model/types"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../protocol"
import { defineSheetFeature } from "../registry"
import { dataRegion, navigate, type SheetOccupancy } from "./navigate"

// Ctrl+arrow and the data region over an xlsx sheet's store: rows are walked as the store holds them, so a jump
// over empty rows costs nothing for them.

function holds(block: RowBlock, k: number): boolean {
	return block.kinds[k] !== CellKind.EMPTY || (block.formulas?.[k] ?? -1) >= 0
}

class XlsxOccupancy implements SheetOccupancy {
	private readonly store: SheetStore
	// Hidden column ranges: first, last pairs.
	private readonly hiddenCols: number[] = []

	constructor(model: XlsxSheetModel) {
		this.store = model.store as SheetStore

		for (const range of model.cols) if ((range.flags & ColFlag.HIDDEN) !== 0) this.hiddenCols.push(range.first, range.last)
	}

	filled(row: number, col: number): boolean {
		const slot = this.store.locate(row, col)

		if (slot < 0) return false

		const block = this.store.blocks[Math.floor(slot / SLOT_BLOCK)]

		return block !== undefined && holds(block, slot % SLOT_BLOCK)
	}

	nextInCol(col: number, row: number, step: 1 | -1, until = step === 1 ? SHEET_MAX_ROWS - 1 : 0): number {
		const blocks = this.store.blocks
		const from = this.store.blockOf(row)

		for (let b = step === 1 ? Math.max(0, from) : from; b >= 0 && b < blocks.length; b += step) {
			const block = blocks[b]

			if (block === undefined) continue
			if (step === 1 ? block.firstRow > until : block.lastRow < until) break

			for (let i = step === 1 ? 0 : block.rowCount - 1; i >= 0 && i < block.rowCount; i += step) {
				const at = block.firstRow + (block.rows[i] ?? 0)

				if (step === 1 ? at < row : at > row) continue
				if (step === 1 ? at > until : at < until) return -1

				const k = block.cellIndex(i, col)

				if (k >= 0 && holds(block, k)) return at
			}
		}

		return -1
	}

	nextInRow(row: number, col: number, step: 1 | -1, until = step === 1 ? SHEET_MAX_COLS - 1 : 0): number {
		const b = this.store.blockOf(row)
		const block = this.store.blocks[b]

		if (block === undefined) return -1

		const i = block.rowIndex(row)

		if (i < 0) return -1

		const first = block.rowStarts[i] ?? 0
		const end = block.rowStarts[i + 1] ?? 0

		for (let k = step === 1 ? first : end - 1; k >= first && k < end; k += step) {
			const at = block.cols[k] ?? 0

			if (step === 1 ? at < col : at > col) continue
			if (step === 1 ? at > until : at < until) return -1
			if (holds(block, k)) return at
		}

		return -1
	}

	hiddenRow(row: number): boolean {
		const block = this.store.blocks[this.store.blockOf(row)]

		if (block === undefined) return false

		const i = block.rowIndex(row)

		return i >= 0 && ((block.rowFlags[i] ?? 0) & RowFlag.HIDDEN) !== 0
	}

	hiddenCol(col: number): boolean {
		for (let i = 0; i + 1 < this.hiddenCols.length; i += 2)
			if (col >= (this.hiddenCols[i] ?? 0) && col <= (this.hiddenCols[i + 1] ?? 0)) return true

		return false
	}
}

export const xlsxNavigateFeature = defineSheetFeature<XlsxDocument>({
	id: "navigate",
	queries: {
		navigate: {
			run: async (context, request) =>
				navigate(new XlsxOccupancy(await context.doc.ready(request.sheet, context.slicing, context.signal)), request)
		},
		dataRegion: {
			run: async (context, request) =>
				dataRegion(
					new XlsxOccupancy(await context.doc.ready(request.sheet, context.slicing, context.signal)),
					request.row,
					request.col
				)
		}
	}
})
