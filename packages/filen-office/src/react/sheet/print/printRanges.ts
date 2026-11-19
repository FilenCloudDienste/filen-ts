import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetAxisLayout, type SheetLayout, type SheetRange } from "../../../core/sheet/protocol"
import type { SheetPrintNote } from "../../../core/sheet/print/xlsx"
import type { SheetDrawingObject } from "../../../core/xlsx/drawings/feature"
import type { GridAxis } from "../axis"
import { anchorBox, type SheetBox } from "../drawings/geometry"
import { clampRanges, printAxis } from "./printPage"

// What a sheet prints over its cells and how far: its objects and shown notes by their anchors, the used range grown
// over them (Excel prints them past the last cell with content).

// The box of a shown note without an anchor: right of its cell, as Excel first places one.
const NOTE_BOX = { width: 144, height: 79 }

const wholeBuilt = new WeakMap<SheetAxisLayout, GridAxis>()

function whole(sizes: SheetAxisLayout, count: number): GridAxis {
	let axis = wholeBuilt.get(sizes)

	if (axis === undefined) {
		axis = printAxis(sizes, count)
		wholeBuilt.set(sizes, axis)
	}

	return axis
}

// The sheet's whole axes at 100 % (built once per layout: every page's objects are placed on them). `rows`: the sizes
// the pages were cut by, when they are not the layout's.
export function wholeAxes(layout: SheetLayout, rows: SheetAxisLayout = layout.rows): { rows: GridAxis; cols: GridAxis; scale: number } {
	return { rows: whole(rows, SHEET_MAX_ROWS), cols: whole(layout.cols, SHEET_MAX_COLS), scale: 1 }
}

export // Where a note shown all the time stands: its legacy drawing's anchor (columns and rows, offsets in px).
function noteBox(note: SheetPrintNote, axes: { rows: GridAxis; cols: GridAxis }): SheetBox {
	const { rows, cols } = axes
	const anchor = note.anchor

	if (anchor === null) return { x: cols.offset(note.col + 1) + 12, y: rows.offset(Math.max(0, note.row - 1)) + 4, ...NOTE_BOX }

	const [leftCol = 0, leftOff = 0, topRow = 0, topOff = 0, rightCol = 0, rightOff = 0, bottomRow = 0, bottomOff = 0] = anchor
	const x = cols.offset(leftCol) + leftOff
	const y = rows.offset(topRow) + topOff

	return { x, y, width: Math.max(8, cols.offset(rightCol) + rightOff - x), height: Math.max(8, rows.offset(bottomRow) + bottomOff - y) }
}

// The used range grown over the sheet's objects and shown notes (Excel prints them past the last cell with content).
export function withObjects(
	used: SheetRange | null,
	objects: readonly SheetDrawingObject[],
	notes: readonly SheetPrintNote[],
	layout: SheetLayout
): SheetRange | null {
	if (objects.length === 0 && notes.length === 0) return used

	const axes = wholeAxes(layout)
	let out = used

	for (const box of [...objects.map(object => anchorBox(object.anchor, axes)), ...notes.map(note => noteBox(note, axes))]) {
		const endRow = axes.rows.indexAt(Math.max(0, box.y + box.height - 1))
		const endCol = axes.cols.indexAt(Math.max(0, box.x + box.width - 1))

		out =
			out === null
				? { startRow: 0, startCol: 0, endRow, endCol }
				: { ...out, endRow: Math.max(out.endRow, endRow), endCol: Math.max(out.endCol, endCol) }
	}

	return out
}

function sameRange(a: SheetRange | undefined, b: SheetRange | null): boolean {
	return (
		a !== undefined &&
		b !== null &&
		a.startRow === b.startRow &&
		a.startCol === b.startCol &&
		a.endRow === b.endRow &&
		a.endCol === b.endCol
	)
}

// What prints of a sheet: the requested ranges, the used range grown over the objects and shown notes when the request
// is the used range (a print area or a selection prints as it is), clamped where they reach the grid's end.
export function printRanges(
	ranges: readonly SheetRange[],
	used: SheetRange | null,
	objects: readonly SheetDrawingObject[],
	notes: readonly SheetPrintNote[],
	layout: SheetLayout
): SheetRange[] {
	const grown = withObjects(used, objects, notes, layout)
	const grows = ranges.length === 1 && sameRange(ranges[0], used)

	return clampRanges(grows && grown !== null ? [grown] : ranges, grown)
}
