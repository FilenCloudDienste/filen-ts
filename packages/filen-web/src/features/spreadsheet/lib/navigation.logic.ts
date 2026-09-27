import { createAxis, type Axis } from "@/features/spreadsheet/lib/axis.logic"
import { rangeContains, type CellPosition, type Selection } from "@/features/spreadsheet/lib/cellRef.logic"
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, type CellRange } from "@/features/spreadsheet/lib/model"

// Blank rows and columns past the used area, as a spreadsheet shows.
const EXTRA_ROWS = 100
const EXTRA_COLS = 20
const MIN_COLS = 26
// Browsers cap an element's height (Firefox near 17.9 million pixels): rows past it cannot be scrolled to,
// so the grid stops there and says so.
const MAX_GRID_PIXELS = 15_000_000

export interface GridBounds {
	rowCount: number
	colCount: number
	// The last row and column holding anything: where mod+arrow and mod+End stop.
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

// The merge covering a cell. Linear, for single lookups (a key, a click); the grid indexes what it draws.
export function mergeAt(merges: readonly CellRange[], row: number, col: number): CellRange | undefined {
	return merges.find(merge => rangeContains(merge, row, col))
}

// A position inside a merge stands for the merge's anchor, the one cell of it that holds anything.
export function snapToMerge(position: CellPosition, merges: readonly CellRange[]): CellPosition {
	const merge = mergeAt(merges, position.row, position.col)

	return merge === undefined || (merge.startRow === position.row && merge.startCol === position.col)
		? position
		: { row: merge.startRow, col: merge.startCol }
}

export interface NavigableSheet {
	rowCount: number
	colCount: number
	hiddenRows: readonly number[]
	hiddenCols: readonly number[]
	rowHeights: ReadonlyMap<number, number>
	colWidths: ReadonlyMap<number, number>
	merges: readonly CellRange[]
}

interface AxisMemo<T> {
	hidden: readonly number[]
	count: number
	value: T
}

// Axes by the size map they were built from: a cell edit keeps a sheet's sizes and hidden lists, so it
// reuses the axes rather than sorting every custom size again.
const rowAxes = new WeakMap<ReadonlyMap<number, number>, AxisMemo<{ axis: Axis; truncated: boolean }>>()
const colAxes = new WeakMap<ReadonlyMap<number, number>, AxisMemo<Axis>>()

function memo<T>(
	cache: WeakMap<ReadonlyMap<number, number>, AxisMemo<T>>,
	sizes: ReadonlyMap<number, number>,
	hidden: readonly number[],
	count: number,
	build: () => T
): T {
	const hit = cache.get(sizes)

	if (hit?.hidden === hidden && hit.count === count) {
		return hit.value
	}

	const value = build()

	cache.set(sizes, { hidden, count, value })

	return value
}

// A sheet's rows as the grid shows them, cut off at MAX_GRID_PIXELS (`truncated`).
export function sheetRows(sheet: NavigableSheet): { axis: Axis; truncated: boolean } {
	return memo(rowAxes, sheet.rowHeights, sheet.hiddenRows, sheet.rowCount, () => {
		const full = createAxis(sheet.rowCount + EXTRA_ROWS, DEFAULT_ROW_HEIGHT, sheet.rowHeights, sheet.hiddenRows)

		if (full.total <= MAX_GRID_PIXELS) {
			return { axis: full, truncated: false }
		}

		const shown = full.indexAt(MAX_GRID_PIXELS)

		return { axis: createAxis(shown, DEFAULT_ROW_HEIGHT, sheet.rowHeights, sheet.hiddenRows), truncated: sheet.rowCount > shown }
	})
}

export function sheetCols(sheet: NavigableSheet): Axis {
	return memo(colAxes, sheet.colWidths, sheet.hiddenCols, sheet.colCount, () =>
		createAxis(Math.max(sheet.colCount + EXTRA_COLS, MIN_COLS), DEFAULT_COL_WIDTH, sheet.colWidths, sheet.hiddenCols)
	)
}

// The bounds a sheet's grid moves within, bar the page size, which depends on the viewport.
export function sheetBounds(sheet: NavigableSheet, rows: Axis, cols: Axis): Omit<GridBounds, "pageRows"> {
	return {
		rowCount: rows.count,
		colCount: cols.count,
		lastUsedRow: Math.max(0, sheet.rowCount - 1),
		lastUsedCol: Math.max(0, sheet.colCount - 1),
		hiddenRow: row => rows.size(row) === 0,
		hiddenCol: col => cols.size(col) === 0,
		mergeAt: (row, col) => mergeAt(sheet.merges, row, col)
	}
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
// from the anchor; mod+arrow jumps to the edge of the used area (then to the sheet's); Tab and Enter step
// right and down (backwards with Shift) and collapse the selection; Home and End go to the row's start and
// the used area's end column (mod: the sheet's first and last used cell); PageUp and PageDown move a
// screen; mod+A selects the used area. Hidden rows and columns are passed over, and a merge is one cell.
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

	switch (event.key) {
		case "ArrowUp":
			row = mod ? settle(0, rowCount, hiddenRow, 1) : up()
			break
		case "ArrowDown":
			row = mod ? settle(focus.row < bounds.lastUsedRow ? bounds.lastUsedRow : rowCount - 1, rowCount, hiddenRow, -1) : down()
			break
		case "ArrowLeft":
			col = mod ? settle(0, colCount, hiddenCol, 1) : left()
			break
		case "ArrowRight":
			col = mod ? settle(focus.col < bounds.lastUsedCol ? bounds.lastUsedCol : colCount - 1, colCount, hiddenCol, -1) : right()
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

// A keydown that belongs to an input method rather than to the page: during a composition, or (Safari)
// the one confirming it, which only its legacy keyCode 229 tells apart from a plain Enter.
export function isImeKeydown(event: { key: string; isComposing: boolean; keyCode: number }): boolean {
	return event.isComposing || event.key === "Process" || event.keyCode === 229
}
