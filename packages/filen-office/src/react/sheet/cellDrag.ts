import type { SheetMoveCommand } from "../../core/sheet/move/plan"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetAxis, type SheetId, type SheetRange } from "../../core/sheet/protocol"
import type { GridRect } from "./layers"
import type { GridPoint } from "./selection"

// Dragging the selection by its border, as Excel (support.microsoft.com, "Move or copy cells, rows, and columns"):
// the pointer over the border shows the move cursor; a drag moves the block, Ctrl (Option on a Mac) copies it, Shift
// inserts it at the gridline nearest the pointer (the cells there shifting down or right). The keys count as they are
// when the pointer lets go, as in Excel. A finger drags after a long press on the selection. The session does the
// edit (cells.move); a move over data asks first.

// How near the selection's outline (px) the pointer grabs the border.
export const BORDER_SLOP = 4

// Whether the pointer at (x, y), laid out as the grid is (layoutX), is on the outline of one of the range's on-screen
// pieces: within `slop` of an edge, and not inside the piece further than that.
export function onBorder(rects: readonly GridRect[], x: number, y: number, slop: number): boolean {
	for (const rect of rects) {
		const outside = x < rect.x - slop || x > rect.x + rect.width + slop || y < rect.y - slop || y > rect.y + rect.height + slop

		if (outside) continue

		const inside = x > rect.x + slop && x < rect.x + rect.width - slop && y > rect.y + slop && y < rect.y + rect.height - slop

		if (!inside) return true
	}

	return false
}

// Whether a selection can be dragged: one range (Excel: "You cannot move or copy nonadjacent rows and columns by using
// the mouse"), not the whole sheet.
export function draggable(ranges: readonly SheetRange[]): SheetRange | null {
	const range = ranges.length === 1 ? ranges[0] : undefined

	if (range === undefined) return null
	if (range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1 && range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1)
		return null

	return range
}

// Whole rows (columns) keep to their axis: they move along it alone.
function wholeRows(range: SheetRange): boolean {
	return range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1
}

function wholeCols(range: SheetRange): boolean {
	return range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1
}

// Where in the cell under it the pointer is: the nearest edge (top and bottom: an insert's cells shift down; start and
// end: right), and which half it is in each way (the gridline whole rows or columns insert at). `box` and the pointer
// are laid out as the grid is.
export type CellEdge = "top" | "bottom" | "start" | "end"

export interface CellSpot {
	readonly edge: CellEdge
	readonly below: boolean
	readonly after: boolean
}

export function cellSpot(box: GridRect, x: number, y: number): CellSpot {
	const top = y - box.y
	const bottom = box.y + box.height - y
	const start = x - box.x
	const end = box.x + box.width - x
	const least = Math.min(top, bottom, start, end)
	const edge: CellEdge = least === top ? "top" : least === bottom ? "bottom" : least === start ? "start" : "end"

	return { edge, below: bottom < top, after: end < start }
}

// Where a drag of `source`, grabbed at its cell `grab`, puts the block with the pointer on `point`: its top-left cell
// (kept on the sheet), and with `spot` (an insert) the axis the cells there shift along, at the gridline of the
// pointer's nearest edge of `cell` (the cell under it, or its merge). Whole rows (columns) move along their axis alone,
// and insert between rows (columns).
export interface DragDrop {
	readonly to: GridPoint
	readonly insert: SheetAxis | null
}

export function dropAt(
	source: SheetRange,
	grab: GridPoint,
	point: GridPoint,
	spot: CellSpot | null,
	cell: SheetRange = { startRow: point.row, startCol: point.col, endRow: point.row, endCol: point.col }
): DragDrop {
	const height = source.endRow - source.startRow + 1
	const width = source.endCol - source.startCol + 1
	const clampRow = (row: number): number => Math.max(0, Math.min(SHEET_MAX_ROWS - height, row))
	const clampCol = (col: number): number => Math.max(0, Math.min(SHEET_MAX_COLS - width, col))
	let row = wholeCols(source) ? 0 : clampRow(point.row - (grab.row - source.startRow))
	let col = wholeRows(source) ? 0 : clampCol(point.col - (grab.col - source.startCol))

	if (spot === null) return { to: { row, col }, insert: null }

	const byRows = wholeRows(source) || (!wholeCols(source) && (spot.edge === "top" || spot.edge === "bottom"))

	if (byRows) row = clampRow(spot.below ? cell.endRow + 1 : cell.startRow)
	else col = clampCol(spot.after ? cell.endCol + 1 : cell.startCol)

	return { to: { row, col }, insert: byRows ? "rows" : "cols" }
}

// The block where it would land, for the preview: at `to`, the source's size.
export function dropRange(source: SheetRange, to: GridPoint): SheetRange {
	return {
		startRow: to.row,
		startCol: to.col,
		endRow: to.row + source.endRow - source.startRow,
		endCol: to.col + source.endCol - source.startCol
	}
}

// Whether a drop changes nothing: a move (or a move-insert) back where it was. A copy onto itself still writes.
export function sameDrop(source: SheetRange, drop: DragDrop, copy: boolean): boolean {
	if (copy) return false
	if (drop.insert === null) return drop.to.row === source.startRow && drop.to.col === source.startCol

	const rows = drop.insert === "rows"
	const at = rows ? drop.to.row : drop.to.col
	const cross = rows ? drop.to.col === source.startCol : drop.to.row === source.startRow
	const lead = rows ? source.startRow : source.startCol
	const tail = rows ? source.endRow : source.endCol

	return cross && at >= lead && at <= tail + 1
}

// Ctrl copies (Option on a Mac), Shift inserts, as Excel's desktop apps read them.
export function dragKeys(
	event: { readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean },
	mac: boolean
): {
	copy: boolean
	insert: boolean
} {
	return { copy: mac ? event.altKey : event.ctrlKey, insert: event.shiftKey }
}

export function moveCommand(sheet: SheetId, source: SheetRange, drop: DragDrop, copy: boolean, active: GridPoint): SheetMoveCommand {
	return {
		type: "cells.move",
		sheet,
		range: source,
		to: drop.to,
		copy,
		active,
		...(drop.insert !== null && { insert: drop.insert })
	}
}
