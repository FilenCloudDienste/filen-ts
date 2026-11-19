import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../protocol"

// What a spreadsheet worker hands the grid: a view of a workbook, never the workbook itself, which stays
// in its worker (the app's workbook worker, or its text worker for CSV) so a save can write it back with
// everything the view leaves out. Plain, structured-cloneable data only.

export type SpreadsheetKind = "xlsx" | "xls" | "csv"

// Excel's own grid size (protocol.ts). Cell keys pack row and column into one number (cellKey).
export const MAX_ROWS = SHEET_MAX_ROWS
export const MAX_COLUMNS = SHEET_MAX_COLS

export function cellKey(row: number, col: number): number {
	return row * MAX_COLUMNS + col
}

// The row and the column a cellKey packs.
export function cellKeyRow(key: number): number {
	return Math.floor(key / MAX_COLUMNS)
}

export function cellKeyCol(key: number): number {
	return key % MAX_COLUMNS
}

export interface CellView {
	// What the cell shows: its value through its number format, a formula's result.
	text: string
	// What editing it starts from, when that differs from `text`: "=SUM(A1:A3)", or 1234.5 shown as
	// "$1,234.50".
	input?: string
	// A number, date or boolean: right-aligned unless its format says otherwise.
	numeric?: boolean
	error?: boolean
}

export interface CellRange {
	startRow: number
	startCol: number
	endRow: number
	endCol: number
}

export const DEFAULT_COL_WIDTH = 96
export const DEFAULT_ROW_HEIGHT = 24
