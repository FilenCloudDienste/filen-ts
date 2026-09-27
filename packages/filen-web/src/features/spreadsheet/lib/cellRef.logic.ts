import type { CellRange } from "@/features/spreadsheet/lib/model"

// "A", "B", … "Z", "AA", … — a column's letters from its 0-based index.
export function columnName(index: number): string {
	let name = ""
	let rest = index + 1

	while (rest > 0) {
		const digit = (rest - 1) % 26

		name = String.fromCharCode(65 + digit) + name
		rest = Math.floor((rest - 1) / 26)
	}

	return name
}

export function cellName(row: number, col: number): string {
	return `${columnName(col)}${String(row + 1)}`
}

export interface CellPosition {
	row: number
	col: number
}

export interface Selection {
	anchor: CellPosition
	focus: CellPosition
}

export function selectionRange(selection: Selection): CellRange {
	return {
		startRow: Math.min(selection.anchor.row, selection.focus.row),
		startCol: Math.min(selection.anchor.col, selection.focus.col),
		endRow: Math.max(selection.anchor.row, selection.focus.row),
		endCol: Math.max(selection.anchor.col, selection.focus.col)
	}
}

// "B2" for one cell, "B2:D7" for a range.
export function rangeName(range: CellRange): string {
	const start = cellName(range.startRow, range.startCol)

	return range.startRow === range.endRow && range.startCol === range.endCol ? start : `${start}:${cellName(range.endRow, range.endCol)}`
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
	return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol
}

// The selection grown to cover every merge it touches, repeatedly (a merge pulled in can reach another).
export function expandToMerges(range: CellRange, merges: readonly CellRange[]): CellRange {
	let current = range
	let grew = true

	while (grew) {
		grew = false

		for (const merge of merges) {
			if (
				rangesIntersect(current, merge) &&
				(merge.startRow < current.startRow ||
					merge.startCol < current.startCol ||
					merge.endRow > current.endRow ||
					merge.endCol > current.endCol)
			) {
				current = {
					startRow: Math.min(current.startRow, merge.startRow),
					startCol: Math.min(current.startCol, merge.startCol),
					endRow: Math.max(current.endRow, merge.endRow),
					endCol: Math.max(current.endCol, merge.endCol)
				}
				grew = true
			}
		}
	}

	return current
}
