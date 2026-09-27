import type { CellPosition, Selection } from "@/features/spreadsheet/lib/cellRef.logic"

export interface GridBounds {
	rowCount: number
	colCount: number
	// The last row and column holding anything: where mod+arrow and mod+End stop.
	lastUsedRow: number
	lastUsedCol: number
	pageRows: number
}

interface KeyLike {
	key: string
	shiftKey: boolean
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
}

function clamp(position: CellPosition, bounds: GridBounds): CellPosition {
	return {
		row: Math.max(0, Math.min(position.row, bounds.rowCount - 1)),
		col: Math.max(0, Math.min(position.col, bounds.colCount - 1))
	}
}

// The selection after a navigation key, or null for any other key. Arrows move, and with Shift extend
// from the anchor; mod+arrow jumps to the edge of the used area (then to the sheet's); Tab and Enter step right and down
// (backwards with Shift) and collapse the selection; Home and End go to the row's start and the used
// area's end column (mod: the sheet's first and last used cell); PageUp and PageDown move a screen;
// mod+A selects the used area.
export function gridMove(event: KeyLike, selection: Selection, bounds: GridBounds): Selection | null {
	const mod = event.ctrlKey || event.metaKey
	const { focus } = selection
	let next: CellPosition
	let extend = event.shiftKey

	switch (event.key) {
		case "ArrowUp":
			next = { row: mod ? 0 : focus.row - 1, col: focus.col }
			break
		case "ArrowDown":
			next = {
				row: mod ? (focus.row < bounds.lastUsedRow ? bounds.lastUsedRow : bounds.rowCount - 1) : focus.row + 1,
				col: focus.col
			}
			break
		case "ArrowLeft":
			next = { row: focus.row, col: mod ? 0 : focus.col - 1 }
			break
		case "ArrowRight":
			next = {
				row: focus.row,
				col: mod ? (focus.col < bounds.lastUsedCol ? bounds.lastUsedCol : bounds.colCount - 1) : focus.col + 1
			}
			break
		case "Tab":
			if (mod || event.altKey) {
				return null
			}

			next = { row: focus.row, col: focus.col + (event.shiftKey ? -1 : 1) }
			extend = false
			break
		case "Enter":
			if (mod || event.altKey) {
				return null
			}

			next = { row: focus.row + (event.shiftKey ? -1 : 1), col: focus.col }
			extend = false
			break
		case "Home":
			next = mod ? { row: 0, col: 0 } : { row: focus.row, col: 0 }
			break
		case "End":
			next = mod ? { row: bounds.lastUsedRow, col: bounds.lastUsedCol } : { row: focus.row, col: bounds.lastUsedCol }
			break
		case "PageUp":
			next = { row: focus.row - bounds.pageRows, col: focus.col }
			break
		case "PageDown":
			next = { row: focus.row + bounds.pageRows, col: focus.col }
			break
		case "a":
		case "A":
			if (!mod || event.shiftKey || event.altKey) {
				return null
			}

			return { anchor: { row: 0, col: 0 }, focus: { row: bounds.lastUsedRow, col: bounds.lastUsedCol } }
		default:
			return null
	}

	const clamped = clamp(next, bounds)

	return { anchor: extend ? selection.anchor : clamped, focus: clamped }
}
