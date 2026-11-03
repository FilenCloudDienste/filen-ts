import type { AxisEdit } from "../../sheet/model/edits"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../../sheet/protocol"
import { shiftSpan } from "../../sheet/refs/formulaRefs"

// Rows or columns inserted or deleted on one sheet, as positions see them. Excel's rules (support.microsoft.com,
// "Insert or delete rows and columns"; ECMA-376 Part 1 §18.17.2.4 for references): an insert at an index moves
// everything at and after it; a range that the insert falls strictly inside grows, one starting at the index
// moves whole. A delete removes what it covers; a range it cuts into shrinks; one it covers whole is gone.
//
// Cells inserted or deleted (Excel's Insert and Delete of cells, shifting cells down, right, up or left) are the
// same edit within a band: the columns (an edit of rows) or rows (of columns) the cells span. Only what lies in the
// band moves: a range across the band moves as the edit says, one reaching outside it stays as it is (LibreOffice's
// rule, which Microsoft's documentation leaves open).

export type Axis = "rows" | "cols"

// An inclusive span of the other axis.
export interface AxisBand {
	readonly start: number
	readonly end: number
}

export interface AxisShift extends AxisEdit {
	readonly axis: Axis
	// Cells only of these columns (an edit of rows) or rows (of columns) move.
	readonly band?: AxisBand
}

export function axisLimit(axis: Axis): number {
	return axis === "rows" ? SHEET_MAX_ROWS : SHEET_MAX_COLS
}

// The new index of `index` on the shifted axis, or -1 when it was deleted or pushed off the sheet.
export function shiftIndex(index: number, shift: AxisShift): number {
	if (index < shift.at) return index

	if (shift.type === "insert") {
		const moved = index + shift.count

		return moved < axisLimit(shift.axis) ? moved : -1
	}

	return index < shift.at + shift.count ? -1 : index - shift.count
}

// The index before the shift of a cell now at `index`, or -1 for an inserted one.
export function preimage(index: number, shift: AxisShift): number {
	if (index < shift.at) return index
	if (shift.type === "delete") return index + shift.count

	return index < shift.at + shift.count ? -1 : index - shift.count
}

// An inclusive span on the shifted axis: null when the delete took all of it (or the insert pushed it off). A span
// reaching the sheet's last row (column) still does after either edit, as the rows a delete brings in at the end
// fall inside it.
export function shiftAxisSpan(start: number, end: number, shift: AxisShift): [number, number] | null {
	const limit = axisLimit(shift.axis)
	const span = shiftSpan(start, end, shift, limit, true)

	if (span !== null && end === limit - 1) span[1] = limit - 1

	return span
}

export function shiftRange(range: SheetRange, shift: AxisShift): SheetRange | null {
	if (!inBand(range, shift)) return range

	const rows = shift.axis === "rows"
	const span = shiftAxisSpan(rows ? range.startRow : range.startCol, rows ? range.endRow : range.endCol, shift)

	if (span === null) return null
	if (rows) return span[0] === range.startRow && span[1] === range.endRow ? range : { ...range, startRow: span[0], endRow: span[1] }

	return span[0] === range.startCol && span[1] === range.endCol ? range : { ...range, startCol: span[0], endCol: span[1] }
}

// A cell (a range of one) moved: null when it was deleted.
export function shiftCell(row: number, col: number, shift: AxisShift): { row: number; col: number } | null {
	if (!crossInBand(shift.axis === "rows" ? col : row, shift)) return { row, col }

	if (shift.axis === "rows") {
		const next = shiftIndex(row, shift)

		return next < 0 ? null : { row: next, col }
	}

	const next = shiftIndex(col, shift)

	return next < 0 ? null : { row, col: next }
}

// Whether a delete cuts a range without taking all of it, or an insert falls strictly inside it: what an array
// formula or a pivot table cannot take.
export function splits(start: number, end: number, shift: AxisShift): boolean {
	if (shift.type === "insert") return shift.at > start && shift.at <= end

	const last = shift.at + shift.count - 1

	return shift.at <= end && last >= start && (shift.at > start || last < end)
}

// Whether the edit moves or removes anything of a span ending at `end`.
export function reaches(end: number, shift: AxisShift): boolean {
	return shift.at <= end
}

// Whether an index of the other axis is in the edit's band (always, for whole rows or columns).
export function crossInBand(index: number, shift: AxisShift): boolean {
	return shift.band === undefined || (index >= shift.band.start && index <= shift.band.end)
}

// Whether a range lies across the band alone, so it moves as the edit says (always, for whole rows or columns).
export function inBand(range: SheetRange, shift: AxisShift): boolean {
	const band = shift.band

	if (band === undefined) return true

	return shift.axis === "rows"
		? range.startCol >= band.start && range.endCol <= band.end
		: range.startRow >= band.start && range.endRow <= band.end
}

// Whether a range meets the cells the edit moves or deletes: those of the band at and after `at`.
export function meetsMoved(range: SheetRange, shift: AxisShift): boolean {
	const band = shift.band
	const rows = shift.axis === "rows"
	const low = rows ? range.startCol : range.startRow
	const high = rows ? range.endCol : range.endRow

	return (band === undefined || (low <= band.end && high >= band.start)) && (rows ? range.endRow : range.endCol) >= shift.at
}

// Whether a range is only partly in the band and meets what moves: what a merge, a table, an array formula or an
// autofilter cannot take.
export function straddles(range: SheetRange, shift: AxisShift): boolean {
	return !inBand(range, shift) && meetsMoved(range, shift)
}

// The cells the edit deletes (null for an insert): a run of whole rows or columns, or the band's part of it.
export function deletedCells(shift: AxisShift): SheetRange | null {
	if (shift.type !== "delete") return null

	const last = shift.at + shift.count - 1
	const band = shift.band ?? { start: 0, end: (shift.axis === "rows" ? SHEET_MAX_COLS : SHEET_MAX_ROWS) - 1 }

	return shift.axis === "rows"
		? { startRow: shift.at, startCol: band.start, endRow: last, endCol: band.end }
		: { startRow: band.start, startCol: shift.at, endRow: band.end, endCol: last }
}

// The cell that was at (row, col) before the edit, for one now there; -1 for an inserted one.
export function preimageCell(row: number, col: number, shift: AxisShift): { row: number; col: number } {
	if (shift.axis === "rows") return { row: crossInBand(col, shift) ? preimage(row, shift) : row, col }

	return { row, col: crossInBand(row, shift) ? preimage(col, shift) : col }
}
