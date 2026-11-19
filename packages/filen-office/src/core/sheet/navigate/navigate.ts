import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetQueryRequest, type SheetQueryResult, type SheetRange } from "../protocol"

// Ctrl+arrow and the data region (Ctrl+A, Ctrl+Shift+*) as Excel's "Keyboard shortcuts in Excel" describes them
// (support.microsoft.com): Ctrl+arrow goes to the edge of the data region the active cell is in; from its edge, or
// from a blank cell, it goes to the next cell holding something that way, and to the sheet's last row or column
// when there is none. Hidden rows and columns are passed over. The data region is the range round a cell bounded by
// blank rows and columns (Excel's current region), diagonal neighbours included.

// One sheet's cells as navigation reads them: which hold a value or a formula, and which rows and columns are
// hidden.
export interface SheetOccupancy {
	filled(row: number, col: number): boolean
	// The nearest filled row of `col` from `row` going `step`, both inclusive (`until`: the sheet's edge when absent),
	// or -1.
	nextInCol(col: number, row: number, step: 1 | -1, until?: number): number
	// The nearest filled column of `row` from `col` going `step`, as nextInCol.
	nextInRow(row: number, col: number, step: 1 | -1, until?: number): number
	hiddenRow(row: number): boolean
	hiddenCol(col: number): boolean
}

type Direction = SheetQueryRequest<"navigate">["direction"]

// The next shown index from `from` going `step`, or -1.
function shown(from: number, step: 1 | -1, count: number, hidden: (index: number) => boolean): number {
	for (let index = from + step; index >= 0 && index < count; index += step) if (!hidden(index)) return index

	return -1
}

// The last shown index at or before `from` going back from the end `step` points to.
function edge(step: 1 | -1, count: number, hidden: (index: number) => boolean): number {
	const start = step === 1 ? count - 1 : 0

	if (!hidden(start)) return start

	const found = shown(start, step === 1 ? -1 : 1, count, hidden)

	return found < 0 ? start : found
}

// Where Ctrl+arrow lands along one line of cells.
function jump(
	from: number,
	step: 1 | -1,
	count: number,
	filled: (index: number) => boolean,
	next: (index: number) => number,
	hidden: (index: number) => boolean
): number {
	const first = shown(from, step, count, hidden)

	if (first < 0) return from

	// Inside a run of filled cells: to its last one.
	if (filled(from) && filled(first)) {
		let last = first

		for (;;) {
			const after = shown(last, step, count, hidden)

			if (after < 0 || !filled(after)) return last

			last = after
		}
	}

	// To the next filled cell that way, past hidden ones; the sheet's end when there is none.
	for (let at = next(first); at >= 0; at = next(at + step)) if (!hidden(at)) return at

	return edge(step, count, hidden)
}

export function navigate(occupancy: SheetOccupancy, request: SheetQueryRequest<"navigate">): SheetQueryResult<"navigate"> {
	const { row, col } = request
	const direction: Direction = request.direction
	const step: 1 | -1 = direction === "down" || direction === "right" ? 1 : -1
	const vertical = direction === "up" || direction === "down"

	if (vertical) {
		const hidden = (index: number): boolean => occupancy.hiddenRow(index)

		return {
			row: jump(
				row,
				step,
				SHEET_MAX_ROWS,
				index => occupancy.filled(index, col),
				index => occupancy.nextInCol(col, index, step),
				hidden
			),
			col
		}
	}

	const hidden = (index: number): boolean => occupancy.hiddenCol(index)

	return {
		row,
		col: jump(
			col,
			step,
			SHEET_MAX_COLS,
			index => occupancy.filled(row, index),
			index => occupancy.nextInRow(row, index, step),
			hidden
		)
	}
}

// Whether a filled cell lies in a row's columns `startCol`..`endCol`.
function rowHolds(occupancy: SheetOccupancy, row: number, startCol: number, endCol: number): boolean {
	if (row < 0 || row >= SHEET_MAX_ROWS) return false

	return occupancy.nextInRow(row, Math.max(0, startCol), 1, endCol) >= 0
}

function colHolds(occupancy: SheetOccupancy, col: number, startRow: number, endRow: number): boolean {
	if (col < 0 || col >= SHEET_MAX_COLS) return false

	return occupancy.nextInCol(col, Math.max(0, startRow), 1, endRow) >= 0
}

// The data region round a cell: grown a row or column at a time while the ring round it holds a filled cell.
export function dataRegion(occupancy: SheetOccupancy, row: number, col: number): SheetRange {
	let startRow = row
	let startCol = col
	let endRow = row
	let endCol = col

	for (let grown = true; grown;) {
		grown = false

		const left = Math.max(0, startCol - 1)
		const right = Math.min(SHEET_MAX_COLS - 1, endCol + 1)

		while (endRow + 1 < SHEET_MAX_ROWS && rowHolds(occupancy, endRow + 1, left, right)) {
			endRow++
			grown = true
		}

		while (startRow > 0 && rowHolds(occupancy, startRow - 1, left, right)) {
			startRow--
			grown = true
		}

		const top = Math.max(0, startRow - 1)
		const bottom = Math.min(SHEET_MAX_ROWS - 1, endRow + 1)

		while (endCol + 1 < SHEET_MAX_COLS && colHolds(occupancy, endCol + 1, top, bottom)) {
			endCol++
			grown = true
		}

		while (startCol > 0 && colHolds(occupancy, startCol - 1, top, bottom)) {
			startCol--
			grown = true
		}
	}

	return { startRow, startCol, endRow, endCol }
}
