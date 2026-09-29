// What the spreadsheet worker hands the grid: a view of a workbook, never the workbook itself, which stays
// in the worker (workers/spreadsheet.worker.ts) so a save can write it back with everything the view
// leaves out. Plain, structured-cloneable data only.

export type SpreadsheetKind = "xlsx" | "xls" | "csv"

// Excel's own grid size. Cell keys pack row and column into one number (cellKey).
export const MAX_ROWS = 1_048_576
export const MAX_COLUMNS = 16_384

export function cellKey(row: number, col: number): number {
	return row * MAX_COLUMNS + col
}

export function keyRow(key: number): number {
	return Math.floor(key / MAX_COLUMNS)
}

export function keyCol(key: number): number {
	return key % MAX_COLUMNS
}

export type HorizontalAlign = "left" | "center" | "right"
export type VerticalAlign = "top" | "middle" | "bottom"

// The part of a cell's format the grid draws. Colours are CSS hex ("#1f4e79").
export interface CellStyleView {
	bold?: boolean
	italic?: boolean
	underline?: boolean
	strike?: boolean
	color?: string
	fill?: string
	align?: HorizontalAlign
	valign?: VerticalAlign
	wrap?: boolean
	// Font size in points, when not the default.
	size?: number
	numFmt?: string
}

export interface CellView {
	// What the cell shows: its value through its number format, a formula's result.
	text: string
	// What editing it starts from, when that differs from `text`: "=SUM(A1:A3)", or 1234.5 shown as
	// "$1,234.50".
	input?: string
	// Index into SpreadsheetDoc.styles.
	style?: number
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

export interface SheetView {
	name: string
	// The used area: at least as large as the last cell with content, merge or format.
	rowCount: number
	colCount: number
	cells: Map<number, CellView>
	merges: CellRange[]
	// Pixel sizes of the rows and columns that are not the default.
	colWidths: Map<number, number>
	rowHeights: Map<number, number>
	hiddenCols: number[]
	hiddenRows: number[]
	frozenRows: number
	frozenCols: number
	// Rows and columns cannot be inserted or deleted here: something in the sheet refers to cell ranges
	// the workbook model cannot shift (tables, conditional formats, validations, charts, named ranges).
	structureLocked: boolean
}

export interface SpreadsheetDoc {
	kind: SpreadsheetKind
	sheets: SheetView[]
	activeSheet: number
	styles: CellStyleView[]
	// Whether this format can be saved back as it is (.xls cannot; it saves as an .xlsx copy).
	writable: boolean
}

export const DEFAULT_COL_WIDTH = 96
export const DEFAULT_ROW_HEIGHT = 24
