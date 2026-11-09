import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetRange, type SheetSessionApi } from "../../core/sheet/protocol"
import { shownIndex, type GridAxis } from "./axis"
import type { GridPoint } from "./selection"

// The fill handle: the small square at the selection's bottom-right corner (bottom-left in a right-to-left sheet).
// Dragged out it fills (fill.auto) the way the pointer went furthest past the selection; dragged back inside, the
// cells it leaves are cleared of their contents (formats kept), as Excel does; double-clicked, it fills down as far
// as the data next to the selection runs.

// Whether the handle shows for a selection: one range, neither whole rows nor whole columns.
export function fillHandleShown(ranges: readonly SheetRange[]): SheetRange | null {
	const range = ranges.length === 1 ? ranges[0] : undefined

	if (range === undefined) return null
	if (range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1) return null
	if (range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1) return null

	return range
}

// The range a drag from `source` to the cell `to` fills: the source grown down, up, right or left, whichever way the
// pointer is furthest past it; inside the source, the source cut back to the pointer's row or column.
export function fillTarget(source: SheetRange, to: GridPoint): SheetRange {
	const down = to.row > source.endRow ? to.row - source.endRow : 0
	const up = to.row < source.startRow ? source.startRow - to.row : 0
	const right = to.col > source.endCol ? to.col - source.endCol : 0
	const left = to.col < source.startCol ? source.startCol - to.col : 0
	const rows = Math.max(down, up)
	const cols = Math.max(right, left)

	if (rows === 0 && cols === 0) {
		const rowsBack = source.endRow - to.row
		const colsBack = source.endCol - to.col

		if (rowsBack >= colsBack && rowsBack > 0) return { ...source, endRow: to.row }
		if (colsBack > 0) return { ...source, endCol: to.col }

		return source
	}

	if (rows >= cols) return down > 0 ? { ...source, endRow: to.row } : { ...source, startRow: to.row }

	return right > 0 ? { ...source, endCol: to.col } : { ...source, startCol: to.col }
}

export function sameRange(a: SheetRange, b: SheetRange): boolean {
	return a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol
}

// The cells a drag back inside the source leaves (to clear), or null when the target is not inside it.
export function fillLeft(source: SheetRange, target: SheetRange): SheetRange | null {
	if (target.endRow < source.endRow && target.endCol === source.endCol) return { ...source, startRow: target.endRow + 1 }
	if (target.endCol < source.endCol && target.endRow === source.endRow) return { ...source, startCol: target.endCol + 1 }

	return null
}

// Where a double-click on the handle fills down to: the last row of the run of data in the column left of the
// selection (else right of it) that starts on the row below the selection; null when there is none. A lone filled
// cell there is the run: Ctrl+Down from it would go past the blank cells under it to the next block.
export async function fillDownTo(session: SheetSessionApi, sheet: SheetId, source: SheetRange, rows: GridAxis): Promise<number | null> {
	if (source.endRow >= SHEET_MAX_ROWS - 1) return null

	const below = source.endRow + 1

	for (const col of [source.startCol - 1, source.endCol + 1]) {
		if (col < 0 || col >= SHEET_MAX_COLS) continue

		const first = await session.query("cell", { sheet, row: below, col })

		if (first.input === "") continue

		const next = below + 1 < rows.count ? shownIndex(rows, below + 1, 1) : -1

		if (next < 0 || (await session.query("cell", { sheet, row: next, col })).input === "") return below

		const edge = await session.query("navigate", { sheet, row: below, col, direction: "down", to: "dataEdge" })

		return edge.row > source.endRow ? edge.row : null
	}

	return null
}
