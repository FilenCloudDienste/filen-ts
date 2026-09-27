import type { CellRange, CellStyleView, CellView, SheetView } from "@/features/spreadsheet/lib/model"

// What the grid asks the worker to change, and what comes back. Sheet indices are the grid's (worksheets
// only, in order).
export type FormatPatch = Partial<{
	bold: boolean
	italic: boolean
	underline: boolean
	strike: boolean
	// CSS hex, or null to clear.
	color: string | null
	fill: string | null
	align: "left" | "center" | "right" | null
	// An Excel number format, "General" to clear.
	numFmt: string
}>

export type EditOp =
	| { type: "setCells"; sheet: number; cells: readonly { row: number; col: number; input: string }[] }
	| { type: "insert"; sheet: number; axis: "rows" | "cols"; at: number; count: number }
	| { type: "delete"; sheet: number; axis: "rows" | "cols"; at: number; count: number }
	| { type: "addSheet"; name: string }
	| { type: "renameSheet"; sheet: number; name: string }
	| { type: "format"; sheet: number; range: CellRange; patch: FormatPatch }

export interface DocState {
	// Differs from what was opened or last saved.
	dirty: boolean
	canUndo: boolean
	canRedo: boolean
}

// The cells of one sheet an edit changed, recalculated ones included (null: the cell is now empty), and
// the sheet's extent after it.
export interface CellPatch {
	sheet: number
	cells: [number, CellView | null][]
	rowCount: number
	colCount: number
}

export type EditResult =
	// Cells changed, on the edited sheet and on any sheet whose formulas read it. `styles` is the whole
	// style table when it grew, empty otherwise.
	| { type: "cells"; patches: CellPatch[]; styles: CellStyleView[]; state: DocState }
	| { type: "sheets"; sheets: SheetView[]; styles: CellStyleView[]; state: DocState }
	// The edit could not be made: the sheet's structure is locked, a sheet name is taken or invalid, or it
	// would reach past a sheet's limits.
	| { type: "refused"; reason: "structureLocked" | "sheetName" | "tooLarge"; state: DocState }
	// Nothing to undo or redo.
	| { type: "none"; state: DocState }

export const MAX_EDIT_CELLS = 200_000

// Excel's own grid size.
export const MAX_ROWS = 1_048_576
export const MAX_COLS = 16_384

// The largest sheet opened or grown by an edit. A workbook sheet holds its values as a dense rectangle,
// so this bounds its rows times its columns, whatever is filled.
export const MAX_SHEET_CELLS = 5_000_000
