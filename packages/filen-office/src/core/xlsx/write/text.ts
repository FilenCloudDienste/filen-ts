import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../../sheet/protocol"
import { columnIndex, columnName } from "../../sheet/refs/cellRef"
import { XlsxWriteError } from "./failure"

// Numbers and cell references as SpreadsheetML writes them. Text is kept as written (ST_Xstring escapes
// included) by the model, so it needs only XML escaping.

export const MAX_ROWS = SHEET_MAX_ROWS
export const MAX_COLS = SHEET_MAX_COLS

// xsd:double as the shortest text that reads back as the same number; NaN and the infinities refuse, `subject`
// (a constant: nothing is built on the way to a number written) naming what holds one.
export function formatNumber(value: number, subject: string = "A number"): string {
	if (!Number.isFinite(value)) throw new XlsxWriteError("write", `${subject} is ${String(value)}`)

	return Object.is(value, -0) ? "0" : String(value)
}

export { columnIndex, columnName }

export function cellRef(row: number, col: number): string {
	return `${columnName(col)}${row + 1}`
}

export function rangeRef(range: SheetRange): string {
	const start = cellRef(range.startRow, range.startCol)

	return range.startRow === range.endRow && range.startCol === range.endCol ? start : `${start}:${cellRef(range.endRow, range.endCol)}`
}

// A1 (absolute markers allowed) as 0-based row and column, or undefined.
export function parseCellRef(text: string): { readonly row: number; readonly col: number } | undefined {
	const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text)

	if (match === null) return undefined

	const row = Number(match[2])

	return row >= 1 ? { row: row - 1, col: columnIndex(match[1] as string) } : undefined
}

// "A1" or "A1:B2" as a range, or undefined (whole rows or columns are not cell ranges).
export function parseRangeRef(text: string): SheetRange | undefined {
	const colon = text.indexOf(":")
	const start = parseCellRef(colon < 0 ? text : text.slice(0, colon))
	const end = colon < 0 ? start : parseCellRef(text.slice(colon + 1))

	if (start === undefined || end === undefined) return undefined

	return {
		startRow: Math.min(start.row, end.row),
		startCol: Math.min(start.col, end.col),
		endRow: Math.max(start.row, end.row),
		endCol: Math.max(start.col, end.col)
	}
}

export function inSheet(range: SheetRange): boolean {
	return range.startRow >= 0 && range.startCol >= 0 && range.endRow < MAX_ROWS && range.endCol < MAX_COLS
}

// An optional boolean attribute as xsd:boolean reads it.
export function readBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback

	return value === "1" || value === "true"
}
