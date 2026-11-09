import type { SheetId } from "../../sheet/protocol"
import type { RowBlock, SheetStore } from "../model/store"
import { CellKind, ROW_MARKS, SLOT_BLOCK, type XlsxSheetStore } from "../model/types"

// What an xlsx edit keeps to be undone and redone: the cells it wrote as they were before and after, the row
// properties it set, and for a structure edit the store's blocks as they were. Records in the workbook (styles,
// shared strings, formulas) are append-only, so ids recorded here never go stale.

// What one cell held: its slot fields, or nothing (absent), and a result shown for a formula the file keeps
// none for (the overlay; NaN-free number or text, undefined for none).
export interface CellState {
	readonly present: boolean
	readonly kind: CellKind
	readonly value: number
	readonly style: number
	readonly formula: number
	readonly shown: ShownResult | undefined
	// The source cell it is (XlsxSheetStore.origin), for putting it back as it was.
	readonly origin?: number
}

// A formula's result the session shows without storing it in the cell (the file keeps no result for it), or the
// mark that the result a cell keeps is stale.
export interface ShownResult {
	readonly value: number | string | boolean | null
	readonly error: boolean
	// An edit's result the engine could not calculate (not one the file lacked at open), or a stored result an edit
	// made stale: Excel recalculates on load.
	readonly edited?: true
	// Calculated once the engine was built over the result the cell stores (a volatile formula, what reads one, every
	// formula under fullCalcOnLoad): shown in its place, the file's own kept until an edit stores the engine's.
	readonly recalculated?: true
}

export const ABSENT: CellState = { present: false, kind: CellKind.EMPTY, value: 0, style: 0, formula: -1, shown: undefined }

// A cell's key in a sheet: exact as a double for any cell of the grid.
export function cellKeyOf(row: number, col: number): number {
	return row * 16_384 + col
}

export function cellState(store: XlsxSheetStore, row: number, col: number, shown: ShownResult | undefined): CellState {
	const slot = store.locate(row, col)

	if (slot < 0) return shown === undefined ? ABSENT : { ...ABSENT, shown }

	const block = store.blocks[Math.floor(slot / SLOT_BLOCK)] as RowBlock
	const at = slot % SLOT_BLOCK

	return {
		present: true,
		kind: (block.kinds[at] ?? 0) as CellKind,
		value: block.values[at] ?? 0,
		style: block.styles[at] ?? 0,
		formula: block.formulas?.[at] ?? -1,
		shown,
		origin: store.origin(slot)
	}
}

// Writes a cell back as it was (the document's own writer, which keeps shared string counts and change marks).
export type CellWriter = (sheet: SheetId, row: number, col: number, state: CellState) => void

const ENTRY_BYTES = 120

// The cells an edit touched, each once, with what it held before the edit and (once sealed) after it. `direct`
// cells were written by the edit itself; the rest are results the formula engine recalculated.
export class CellLog {
	private readonly keys = new Map<number, number>()
	readonly sheets: SheetId[] = []
	readonly rows: number[] = []
	readonly cols: number[] = []
	readonly direct: boolean[] = []
	readonly before: CellState[] = []
	readonly after: CellState[] = []

	get size(): number {
		return this.rows.length
	}

	get bytes(): number {
		return this.rows.length * ENTRY_BYTES
	}

	// Records a cell before it is first written. Sheet ids stay below 2^18 in a session: the key stays exact.
	touch(sheet: SheetId, row: number, col: number, state: () => CellState, direct: boolean): void {
		const key = sheet * 17_179_869_184 + cellKeyOf(row, col)
		const index = this.keys.get(key)

		if (index !== undefined) {
			if (direct) this.direct[index] = true

			return
		}

		this.keys.set(key, this.rows.length)
		this.sheets.push(sheet)
		this.rows.push(row)
		this.cols.push(col)
		this.direct.push(direct)
		this.before.push(state())
	}

	// Records what every touched cell holds once the edit is done; `from` and `to` seal a part of them at a time,
	// in order (a sliced edit).
	seal(state: (sheet: SheetId, row: number, col: number) => CellState, from = 0, to = this.rows.length): void {
		if (from === 0) this.after.length = 0

		for (let i = from; i < to; i++) this.after.push(state(this.sheets[i] ?? 0, this.rows[i] ?? 0, this.cols[i] ?? 0))
	}

	// Writes every cell back as it was before (undo) or after (redo) the edit, the latest touched first.
	restore(write: CellWriter, which: "before" | "after"): void {
		const states = which === "before" ? this.before : this.after

		for (let i = this.rows.length - 1; i >= 0; i--) {
			const state = states[i]

			if (state !== undefined) write(this.sheets[i] ?? 0, this.rows[i] ?? 0, this.cols[i] ?? 0, state)
		}
	}
}

// One row's properties as the store keeps them (height NaN and style -1 for none).
export interface RowState {
	readonly height: number
	readonly style: number
	readonly flags: number
}

export const NO_ROW: RowState = { height: Number.NaN, style: -1, flags: 0 }

const OWN_ROW_FLAGS = ~ROW_MARKS & 0xffff

export function rowState(store: SheetStore, row: number): RowState {
	const block = store.blocks[store.blockOf(row)]
	const index = block === undefined ? -1 : block.rowIndex(row)

	if (block === undefined || index < 0) {
		// A row an OpenDocument run gives properties without a store row of its own.
		const base = store.rowBase?.(row)

		return base === undefined ? NO_ROW : { height: base.heightPt, style: -1, flags: base.flags & OWN_ROW_FLAGS }
	}

	return {
		height: block.rowHeights[index] ?? Number.NaN,
		style: block.rowStyles[index] ?? -1,
		flags: (block.rowFlags[index] ?? 0) & OWN_ROW_FLAGS
	}
}

// The store's blocks as they were before a structure edit: restoring them (after every later edit was undone)
// gives back the rows with their source spans, so an undone deletion saves as the source did. Blocks are
// replaced, never changed in shape, by later edits; only their firstRow moves, and a column shift without a cell
// removed shifts a block's columns in place, so those are kept too when `columns` is set.
export class StoreSnapshot {
	private readonly blocks: RowBlock[]
	private readonly firstRows: Int32Array
	private readonly cols: (Uint16Array | null)[] | null

	constructor(store: SheetStore, columns: boolean) {
		this.blocks = store.blocks.slice()

		for (const block of this.blocks) store.held.add(block)

		this.firstRows = Int32Array.from(this.blocks, block => block.firstRow)
		this.cols = columns ? this.blocks.map(block => (block.cellCount > 0 ? block.cols.slice() : null)) : null
	}

	get bytes(): number {
		let bytes = this.blocks.length * 16

		for (const cols of this.cols ?? []) bytes += cols?.byteLength ?? 0

		return bytes
	}

	restore(store: SheetStore): void {
		let cells = 0
		let rows = 0
		let cols = 0

		this.blocks.forEach((block, index) => {
			block.firstRow = this.firstRows[index] ?? block.firstRow

			const kept = this.cols?.[index]

			if (kept !== undefined && kept !== null) {
				block.cols.set(kept)
				block.measureCols()
			}

			cells += block.cellCount
			cols = Math.max(cols, block.colExtent)

			if (block.rowCount > 0) rows = Math.max(rows, block.lastRow + 1)
		})

		store.blocks = this.blocks.slice()
		store.cellCount = cells
		store.rowExtent = rows
		store.colExtent = cols
		store.version++
	}
}
