import type { Selection } from "../refs/cellRef"
import type { CellRange } from "../model/model"

export interface GridBounds {
	rowCount: number
	colCount: number
	// The last row and column holding anything: where End, mod+End and mod+A stop.
	lastUsedRow: number
	lastUsedCol: number
	pageRows: number
	// Hidden rows and columns, which moves pass over.
	hiddenRow?: (row: number) => boolean
	hiddenCol?: (col: number) => boolean
	// The merge covering a cell: a move leaves one from its far edge, and lands in one on its anchor.
	mergeAt?: (row: number, col: number) => CellRange | undefined
}

interface KeyLike {
	key: string
	shiftKey: boolean
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
}

// One step from `from` towards `delta`, past hidden indices; null when nothing shown lies that way.
function step(from: number, delta: number, count: number, hidden: ((index: number) => boolean) | undefined): number | null {
	let index = from + delta

	while (index >= 0 && index < count && hidden?.(index) === true) {
		index += delta
	}

	return index >= 0 && index < count ? index : null
}

// `index` clamped to the axis, then moved off a hidden index: towards `prefer` first, then back.
function settle(index: number, count: number, hidden: ((index: number) => boolean) | undefined, prefer: 1 | -1): number {
	const clamped = Math.max(0, Math.min(index, count - 1))

	if (hidden?.(clamped) !== true) {
		return clamped
	}

	return step(clamped, prefer, count, hidden) ?? step(clamped, -prefer, count, hidden) ?? clamped
}

// The selection after a navigation key, or null for any other key. Arrows move, and with Shift extend
// from the anchor; mod+arrow is not one (Ctrl+arrow goes to the data region's edge, the session's navigate
// query; AltGr, arriving as Ctrl+Alt, moves nothing); Tab and Enter step right and down (backwards with
// Shift) and collapse the selection; Home and End go to the row's start and the used area's end column (mod:
// the sheet's first and last used cell); PageUp and PageDown move a screen; mod+A selects the used area.
// Hidden rows and columns are passed over, and a merge is one cell.
export function gridMove(event: KeyLike, selection: Selection, bounds: GridBounds): Selection | null {
	const mod = event.ctrlKey || event.metaKey
	const { focus } = selection
	const { rowCount, colCount, hiddenRow, hiddenCol } = bounds
	const merge = bounds.mergeAt?.(focus.row, focus.col)
	const down = (): number => step(merge?.endRow ?? focus.row, 1, rowCount, hiddenRow) ?? focus.row
	const up = (): number => step(merge?.startRow ?? focus.row, -1, rowCount, hiddenRow) ?? focus.row
	const right = (): number => step(merge?.endCol ?? focus.col, 1, colCount, hiddenCol) ?? focus.col
	const left = (): number => step(merge?.startCol ?? focus.col, -1, colCount, hiddenCol) ?? focus.col
	let row = focus.row
	let col = focus.col
	let extend = event.shiftKey

	if (mod && event.key.startsWith("Arrow")) {
		return null
	}

	switch (event.key) {
		case "ArrowUp":
			row = up()
			break
		case "ArrowDown":
			row = down()
			break
		case "ArrowLeft":
			col = left()
			break
		case "ArrowRight":
			col = right()
			break
		case "Tab":
			if (mod || event.altKey) {
				return null
			}

			col = event.shiftKey ? left() : right()
			extend = false
			break
		case "Enter":
			if (mod || event.altKey) {
				return null
			}

			row = event.shiftKey ? up() : down()
			extend = false
			break
		case "Home":
			row = mod ? settle(0, rowCount, hiddenRow, 1) : row
			col = settle(0, colCount, hiddenCol, 1)
			break
		case "End":
			row = mod ? settle(bounds.lastUsedRow, rowCount, hiddenRow, -1) : row
			col = settle(bounds.lastUsedCol, colCount, hiddenCol, -1)
			break
		case "PageUp":
			row = settle(focus.row - bounds.pageRows, rowCount, hiddenRow, -1)
			break
		case "PageDown":
			row = settle(focus.row + bounds.pageRows, rowCount, hiddenRow, 1)
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

	row = Math.max(0, Math.min(row, rowCount - 1))
	col = Math.max(0, Math.min(col, colCount - 1))

	const landing = bounds.mergeAt?.(row, col)
	const next = landing === undefined ? { row, col } : { row: landing.startRow, col: landing.startCol }

	return { anchor: extend ? selection.anchor : next, focus: next }
}

interface TypedKey {
	key: string
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
}

// A key that types a character rather than running a shortcut. AltGr arrives as Ctrl+Alt on Windows and
// Option as Alt on macOS: both type characters.
export function isTypedCharacter(event: TypedKey): boolean {
	if (event.metaKey || (event.ctrlKey && !event.altKey)) {
		return false
	}

	// One character, which may be a surrogate pair.
	return event.key.length === 1 || (event.key.length === 2 && event.key.codePointAt(0) !== event.key.charCodeAt(0))
}
