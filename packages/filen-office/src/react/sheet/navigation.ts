import { gridMove } from "../../core/sheet/grid/navigation"
import type { SheetLayout, SheetRange } from "../../core/sheet/protocol"
import type { GridAxes } from "./model"
import { cellSelection, extendSelection, singleCell, type GridPoint, type GridSelection } from "./selection"

// Keyboard moves on the grid. Arrows, Home/End, PageUp/PageDown, Tab and Enter move the active cell (Shift extends
// the last range from its anchor); Tab and Enter inside a multi-cell selection cycle through it, as Excel does.
// Ctrl+arrows go to the edge of the data region, which the session knows: they answer a navigate request.

export interface GridKey {
	readonly key: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
}

export type GridKeyMove =
	| { readonly kind: "select"; readonly selection: GridSelection; readonly reveal: GridPoint }
	| { readonly kind: "navigate"; readonly direction: "up" | "down" | "left" | "right"; readonly extend: boolean }

const ARROWS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const

// In a right-to-left sheet the grid is mirrored and Left and Right move the way they point on screen: Right goes to
// the column before (as Excel does in a right-to-left sheet when the sheet is not protected; learn.microsoft.com
// Q&A 1378177 "Keyboard arrow-keys move cursor in opposite direction in protected Right-to-Left Excel Worksheet").
// Tab and Shift+Tab keep going to the next and previous column.
export function visualKey(key: string, layout: Pick<SheetLayout, "rightToLeft">): string {
	if (!layout.rightToLeft) return key

	return key === "ArrowLeft" ? "ArrowRight" : key === "ArrowRight" ? "ArrowLeft" : key
}

function mergeAt(merges: readonly SheetRange[], row: number, col: number): SheetRange | undefined {
	return merges.find(merge => row >= merge.startRow && row <= merge.endRow && col >= merge.startCol && col <= merge.endCol)
}

// Tab (across) or Enter (down) inside the last range: the next cell of it, wrapping round.
function cycle(selection: GridSelection, across: boolean, back: boolean, merges: readonly SheetRange[]): GridSelection {
	const range = selection.ranges[selection.ranges.length - 1] as SheetRange
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1
	const total = rows * cols
	let { row, col } = selection.active

	for (let step = 0; step < total; step++) {
		let k = across ? (row - range.startRow) * cols + (col - range.startCol) : (col - range.startCol) * rows + (row - range.startRow)

		k = (k + (back ? total - 1 : 1)) % total
		row = range.startRow + (across ? Math.floor(k / cols) : k % rows)
		col = range.startCol + (across ? k % cols : Math.floor(k / rows))

		const merge = mergeAt(merges, row, col)

		// A merge is one stop, at its anchor.
		if (merge === undefined || (merge.startRow === row && merge.startCol === col)) break
	}

	return { ...selection, active: { row, col } }
}

// `tabOrigin`: where the run of Tabs that reached the active cell began (SheetGridModel.tabOrigin), for Enter.
export function keyMove(
	pressed: GridKey,
	selection: GridSelection,
	axes: GridAxes,
	layout: SheetLayout,
	merges: readonly SheetRange[],
	pageRows: number,
	tabOrigin: GridPoint | null = null
): GridKeyMove | null {
	const key = visualKey(pressed.key, layout)
	const event = key === pressed.key ? pressed : { ...pressed, key }

	const mod = event.ctrlKey || event.metaKey
	const arrow = ARROWS[event.key as keyof typeof ARROWS] as (typeof ARROWS)[keyof typeof ARROWS] | undefined

	if (arrow !== undefined && mod && !event.altKey) return { kind: "navigate", direction: arrow, extend: event.shiftKey }

	if ((event.key === "Tab" || event.key === "Enter") && !mod && !event.altKey && !singleCell(selection)) {
		const next = cycle(selection, event.key === "Tab", event.shiftKey, merges)

		return { kind: "select", selection: next, reveal: next.active }
	}

	const extend = event.shiftKey && event.key !== "Tab" && event.key !== "Enter"
	const from = extend ? selection.focus : selection.active
	const moved = gridMove(
		event,
		{ anchor: extend ? selection.anchor : from, focus: from },
		{
			rowCount: axes.rows.count,
			colCount: axes.cols.count,
			lastUsedRow: Math.max(0, layout.rowCount - 1),
			lastUsedCol: Math.max(0, layout.colCount - 1),
			pageRows,
			hiddenRow: row => axes.rows.hidden(row),
			hiddenCol: col => axes.cols.hidden(col),
			mergeAt: (row, col) => mergeAt(merges, row, col)
		}
	)

	if (moved === null) return null

	// Enter at the end of a run of Tabs: the next row, in the column the run began in (a merge there: its first cell).
	if (
		tabOrigin !== null &&
		event.key === "Enter" &&
		!event.shiftKey &&
		tabOrigin.row === selection.active.row &&
		moved.focus.row !== selection.active.row &&
		!axes.cols.hidden(tabOrigin.col)
	) {
		const merge = mergeAt(merges, moved.focus.row, tabOrigin.col)
		const point = merge === undefined ? { row: moved.focus.row, col: tabOrigin.col } : { row: merge.startRow, col: merge.startCol }

		return { kind: "select", selection: cellSelection(point, merges), reveal: point }
	}

	if (moved.anchor.row !== moved.focus.row || moved.anchor.col !== moved.focus.col || extend) {
		// Mod+A (the used area) moves the anchor too.
		const base = extend ? selection : cellSelection(moved.anchor, merges)

		return { kind: "select", selection: extendSelection(base, moved.focus, merges), reveal: moved.focus }
	}

	return { kind: "select", selection: cellSelection(moved.focus, merges), reveal: moved.focus }
}

// Where Enter and Tab leave a committed entry: one step that way from the edited cell.
export function stepFrom(
	point: GridPoint,
	direction: "up" | "down" | "left" | "right",
	axes: GridAxes,
	layout: SheetLayout,
	merges: readonly SheetRange[]
): GridSelection {
	const key = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[direction]
	const moved = keyMove(
		{ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false },
		cellSelection(point, merges),
		axes,
		layout,
		merges,
		1
	)

	return moved?.kind === "select" ? moved.selection : cellSelection(point, merges)
}
