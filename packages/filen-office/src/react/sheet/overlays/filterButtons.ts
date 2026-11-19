import { FilterButton, type SheetFilterRange } from "../../../core/sheet/filter/types"
import type { SheetLayout } from "../../../core/sheet/protocol"
import type { GridPaintScene, GridRect, SheetGridLayer } from "../layers"
import type { GridCanvas } from "../paint/canvas"

// The autofilter buttons Excel draws in a filter's header row: one at the trailing edge of each column's header
// cell (unless the file hides it), showing a down arrow, a funnel once the column is filtered, and the sort
// direction once the filter's sort state names the column. Drawn on the cells canvas (a layer), so a sheet with
// hundreds of filtered columns costs no DOM; the app finds a press on one with filterButtonAt and inFilterButton.

// The button's side at 100 %, in CSS px (Excel's is 16 at 96 dpi).
export const FILTER_BUTTON_SIZE = 16

export interface FilterButtonTarget {
	readonly range: SheetFilterRange
	// The header cell.
	readonly row: number
	readonly col: number
	// FilterButton bits.
	readonly bits: number
}

function filtersOf(layout: SheetLayout | null): readonly SheetFilterRange[] {
	return layout?.extensions?.filters?.ranges ?? []
}

// The button in the cell, or null: the cell is a filter's header cell whose column shows one.
export function filterButtonAt(layout: SheetLayout | null, row: number, col: number): FilterButtonTarget | null {
	for (const range of filtersOf(layout)) {
		const { startRow, startCol, endCol } = range.range

		if (row !== startRow || col < startCol || col > endCol) continue

		const bits = range.buttons[col - startCol] ?? 0

		return (bits & FilterButton.SHOWN) === 0 ? null : { range, row, col, bits }
	}

	return null
}

// The filter range holding a cell (its header or data rows), or null.
export function filterRangeAt(layout: SheetLayout | null, row: number, col: number): SheetFilterRange | null {
	for (const range of filtersOf(layout)) {
		const { startRow, endRow, startCol, endCol } = range.range

		if (row >= startRow && row <= endRow && col >= startCol && col <= endCol) return range
	}

	return null
}

// The button's box in a cell's box (laid out: at its right edge, at the bottom as Excel puts it), never wider or
// taller than the cell leaves inside its gridlines.
export function filterButtonRect(cell: GridRect, scale: number): GridRect {
	const side = Math.max(6, Math.min(Math.round(FILTER_BUTTON_SIZE * scale), cell.width - 2, cell.height - 2))

	return { x: cell.x + cell.width - side - 1, y: cell.y + cell.height - side - 1, width: side, height: side }
}

// Whether a pointer at (x, y) is on the button of the cell shown at `cell` (client or grid coordinates alike; a
// right-to-left sheet shows the button at the cell's left edge).
export function inFilterButton(cell: GridRect, x: number, y: number, scale: number, rightToLeft: boolean): boolean {
	const button = filterButtonRect(cell, scale)
	const left = rightToLeft ? cell.x + (cell.x + cell.width - (button.x + button.width)) : button.x

	return x >= left && x < left + button.width && y >= button.y && y < button.y + button.height
}

// A down-pointing triangle of rows of rectangles (the canvas draws no paths) centred on (cx, cy).
function triangle(canvas: GridCanvas, cx: number, cy: number, half: number, down: boolean): void {
	for (let k = 0; k <= half; k++) {
		const width = (down ? half - k : k) * 2 + 1

		canvas.fillRect(Math.round(cx - (width - 1) / 2), Math.round(cy - half / 2 + k), width, 1)
	}
}

function paintButton(canvas: GridCanvas, box: GridRect, bits: number, scene: GridPaintScene): void {
	const theme = scene.theme
	const { x, y, width, height } = box
	const unit = Math.max(1, Math.round(scene.scale))

	canvas.fillStyle = theme.headerBackground
	canvas.fillRect(x, y, width, height)
	canvas.strokeStyle = theme.headerLine
	canvas.lineWidth = 1
	canvas.beginPath()
	canvas.rect(x + 0.5, y + 0.5, width - 1, height - 1)
	canvas.stroke()

	const filtered = (bits & FilterButton.FILTERED) !== 0
	const sorted = (bits & (FilterButton.ASCENDING | FilterButton.DESCENDING)) !== 0
	const color = filtered ? theme.selectionLine : theme.headerText
	const half = Math.max(2, Math.round(width / 6))

	canvas.fillStyle = color

	if (filtered) {
		// A funnel: its cone, then its stem.
		const cx = x + width / 2 - (sorted ? width / 6 : 0)
		const top = y + Math.round(height / 4)

		for (let k = 0; k <= half; k++) {
			const span = (half - k) * 2 + 1

			canvas.fillRect(Math.round(cx - (span - 1) / 2), top + k, span, 1)
		}

		canvas.fillRect(Math.round(cx), top + half, unit, Math.max(2, Math.round(height / 4)))
	} else {
		triangle(canvas, x + width / 2 - (sorted ? width / 6 : 0), y + height / 2, half, true)
	}

	if (sorted) {
		// The sort direction: an arrow at the button's trailing side.
		const ax = Math.round(x + width - width / 4)
		const top = y + Math.round(height / 5)
		const length = height - Math.round((height * 2) / 5)
		const down = (bits & FilterButton.DESCENDING) !== 0

		canvas.fillRect(ax, top, unit, length)
		triangle(canvas, ax, down ? top + length - 1 : top + 1, Math.max(1, Math.round(half / 2)), down)
	}
}

// Every filter header's buttons, per pane, clipped to it.
export const FILTER_BUTTONS_LAYER: SheetGridLayer = {
	id: "filterButtons",
	stage: "cells",
	pure: true,
	paint: (canvas, scene) => {
		const ranges = filtersOf(scene.layout)

		if (ranges.length === 0) return

		for (const pane of scene.panes) {
			for (const filter of ranges) {
				const { startRow, startCol, endCol } = filter.range

				if (startRow < pane.rows.first || startRow > pane.rows.last) continue

				canvas.save()
				canvas.beginPath()
				canvas.rect(pane.clip.x, pane.clip.y, pane.clip.width, pane.clip.height)
				canvas.clip()

				let previous: GridRect | null = null

				for (let col = Math.max(startCol, pane.cols.first); col <= Math.min(endCol, pane.cols.last); col++) {
					const bits = filter.buttons[col - startCol] ?? 0

					if ((bits & FilterButton.SHOWN) === 0) continue

					const box = scene.cellBox(startRow, col)

					// A merged header shows one button, its first column's.
					if (box === null || (previous !== null && previous.x === box.x && previous.width === box.width)) continue

					previous = box
					paintButton(canvas, filterButtonRect(box, scene.scale), bits, scene)
				}

				canvas.restore()
			}
		}
	}
}
