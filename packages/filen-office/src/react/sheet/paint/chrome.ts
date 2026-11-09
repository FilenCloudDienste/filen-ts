import { columnName } from "../../../core/sheet/refs/cellRef"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../../../core/sheet/protocol"
import type { GridSelection } from "../selection"
import type { SheetGridTheme } from "../theme"
import { rangeRects, segments, type GridRect } from "../layers"
import { screenOf, type GridView } from "../view"
import type { GridCanvas } from "./canvas"

// The chrome layer over the cells: column and row headers (the selection's tinted), the frozen panes' dividers,
// the selection's tint and outline, and a resize's guide. Cheap to draw again on every selection move, so the
// cells layer is left alone then. A right-to-left sheet's chrome is mirrored as its cells are (row headers on the
// right), its labels drawn unmirrored.

export interface ChromeScene {
	// Drawn over the selection, under the headers (layers.ts "chrome" layers).
	readonly overSelection?: (() => void) | undefined
	readonly view: GridView
	readonly theme: SheetGridTheme
	readonly pixelRatio: number
	// Null on a sheet with no cells (a chartsheet): nothing selected is drawn.
	readonly selection: GridSelection | null
	readonly merges: readonly SheetRange[]
	// A resize being dragged: the edge's position on screen.
	readonly guide: { readonly axis: "rows" | "cols"; readonly at: number } | null
	// A fill-handle drag: the range it would fill, outlined dashed.
	readonly fill?: SheetRange | null
	// The latest copy or cut on the sheet shown: a moving border round it, its dashes `offset` px along.
	readonly clip?: { readonly range: SheetRange; readonly offset: number } | null
	// The sheet is shown right to left (SheetLayout.rightToLeft): positions are laid out left to right and mirrored.
	readonly rightToLeft?: boolean
}

function layOut(canvas: GridCanvas, scene: ChromeScene): void {
	const { pixelRatio, view } = scene

	if (scene.rightToLeft === true) canvas.setTransform(-pixelRatio, 0, 0, pixelRatio, view.width * pixelRatio, 0)
	else canvas.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
}

// A label centred at x, y as laid out.
function label(canvas: GridCanvas, scene: ChromeScene, text: string, x: number, y: number): void {
	if (scene.rightToLeft !== true) {
		canvas.fillText(text, x, y)

		return
	}

	canvas.setTransform(scene.pixelRatio, 0, 0, scene.pixelRatio, 0, 0)
	canvas.fillText(text, scene.view.width - x, y)
	layOut(canvas, scene)
}

// How the selection covers a header's line: not at all, in part, or whole (a range of whole rows for a row header,
// whole columns for a column one), which Excel's headers show more strongly.
type Cover = "none" | "part" | "whole"

function coverOf(ranges: readonly SheetRange[], axis: "rows" | "cols", index: number): Cover {
	let cover: Cover = "none"

	for (const range of ranges) {
		if (axis === "rows" ? index < range.startRow || index > range.endRow : index < range.startCol || index > range.endCol) continue

		if (
			axis === "rows"
				? range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1
				: range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1
		)
			return "whole"

		cover = "part"
	}

	return cover
}

function headers(canvas: GridCanvas, scene: ChromeScene, axis: "rows" | "cols"): void {
	const { view, theme, selection } = scene
	const own = axis === "cols" ? view.cols : view.rows
	const other = axis === "cols" ? view.rows : view.cols

	if (other.header === 0) return

	const band = other.header

	canvas.fillStyle = theme.headerBackground

	if (axis === "cols") canvas.fillRect(own.header, 0, view.width - own.header, band)
	else canvas.fillRect(0, own.header, band, view.height - own.header)

	for (const part of segments(own)) {
		canvas.save()
		canvas.beginPath()

		if (axis === "cols") canvas.rect(part.start, 0, part.end - part.start, band)
		else canvas.rect(0, part.start, band, part.end - part.start)

		canvas.clip()

		for (let index = part.first; index <= part.last; index++) {
			const size = own.axis.size(index)

			if (size === 0) continue

			const start = screenOf(own, index)
			const cover = selection === null ? "none" : coverOf(selection.ranges, axis, index)

			if (cover !== "none") {
				canvas.fillStyle = cover === "whole" ? theme.headerSelectedBackground : theme.headerActiveBackground

				if (axis === "cols") canvas.fillRect(start, 0, size, band)
				else canvas.fillRect(0, start, band, size)
			}

			canvas.fillStyle = theme.headerLine

			if (axis === "cols") canvas.fillRect(start + size - 1, 0, 1, band)
			else canvas.fillRect(0, start + size - 1, band, 1)

			// Hidden lines just before: a second line a pixel past the boundary, so the run shows as Excel's double line.
			if (index > 0 && size >= 3 && own.axis.size(index - 1) === 0) {
				if (axis === "cols") canvas.fillRect(start + 1, 0, 1, band)
				else canvas.fillRect(0, start + 1, band, 1)
			}

			if (size >= 6) {
				canvas.fillStyle =
					cover === "whole" ? theme.headerSelectedText : cover === "part" ? theme.headerActiveText : theme.headerText

				if (axis === "cols") label(canvas, scene, columnName(index), start + size / 2, band / 2)
				else label(canvas, scene, String(index + 1), band / 2, start + size / 2)
			}
		}

		canvas.restore()
	}

	canvas.fillStyle = theme.headerLine

	if (axis === "cols") canvas.fillRect(0, band - 1, view.width, 1)
	else canvas.fillRect(band - 1, 0, 1, view.height)
}

function drawSelection(canvas: GridCanvas, scene: ChromeScene, selection: GridSelection): void {
	const { view, theme } = scene

	// The selection: a tint over every range (the active cell left clear), then outlines: 2 px round the last range,
	// 1 px round the others and round the active cell when more than it is selected. Each has a 1 px halo inside it,
	// drawn first, so a line never loses to another outline's halo.
	canvas.fillStyle = theme.selectionFill

	for (const range of selection.ranges)
		for (const rect of rangeRects(view, range)) canvas.fillRect(rect.x, rect.y, rect.width, rect.height)

	const activeRange = scene.merges.find(
		merge =>
			selection.active.row >= merge.startRow &&
			selection.active.row <= merge.endRow &&
			selection.active.col >= merge.startCol &&
			selection.active.col <= merge.endCol
	) ?? { startRow: selection.active.row, startCol: selection.active.col, endRow: selection.active.row, endCol: selection.active.col }
	const activeRects = rangeRects(view, activeRange)

	for (const rect of activeRects) canvas.clearRect(rect.x, rect.y, rect.width, rect.height)

	const last = selection.ranges.length - 1
	const outlines: { rect: GridRect; width: number }[] = []

	selection.ranges.forEach((range, k) => {
		for (const rect of rangeRects(view, range)) outlines.push({ rect, width: k === last ? 2 : 1 })
	})

	if (last > 0 || !sameRange(selection.ranges[0], activeRange)) for (const rect of activeRects) outlines.push({ rect, width: 1 })

	canvas.fillStyle = theme.selectionHalo

	for (const { rect, width } of outlines) ring(canvas, rect, width, 1)

	canvas.fillStyle = theme.selectionLine

	for (const { rect, width } of outlines) ring(canvas, rect, 0, width)
}

export function paintChrome(canvas: GridCanvas, scene: ChromeScene): void {
	const { view, theme, selection } = scene

	layOut(canvas, scene)
	canvas.clearRect(0, 0, view.width, view.height)

	if (selection !== null) drawSelection(canvas, scene, selection)

	// The copy's moving border, as Excel's: dashes of the line over the halo, so it shows on any fill.
	if (scene.clip !== undefined && scene.clip !== null) {
		canvas.lineWidth = 1
		canvas.strokeStyle = theme.selectionHalo
		dashedRing(canvas, view, scene.clip.range, [])
		canvas.strokeStyle = theme.selectionLine
		canvas.lineDashOffset = -scene.clip.offset
		dashedRing(canvas, view, scene.clip.range, CLIP_DASH)
		canvas.lineDashOffset = 0
	}

	if (scene.fill !== undefined && scene.fill !== null) {
		canvas.strokeStyle = theme.selectionLine
		canvas.lineWidth = 1
		dashedRing(canvas, view, scene.fill, [3, 2])
	}

	if (scene.overSelection !== undefined) {
		scene.overSelection()
		layOut(canvas, scene)
	}

	// Frozen panes' dividers.
	canvas.fillStyle = theme.frozenLine

	if (view.rows.frozen > 0) canvas.fillRect(0, view.rows.header + view.rows.frozenSize - 1, view.width, 1)
	if (view.cols.frozen > 0) canvas.fillRect(view.cols.header + view.cols.frozenSize - 1, 0, 1, view.height)

	canvas.font = theme.headerFont
	canvas.textAlign = "center"
	canvas.textBaseline = "middle"
	headers(canvas, scene, "cols")
	headers(canvas, scene, "rows")

	// The corner.
	if (view.cols.header > 0 && view.rows.header > 0) {
		canvas.fillStyle = theme.headerBackground
		canvas.fillRect(0, 0, view.cols.header, view.rows.header)
		canvas.fillStyle = theme.headerLine
		canvas.fillRect(view.cols.header - 1, 0, 1, view.rows.header)
		canvas.fillRect(0, view.rows.header - 1, view.cols.header, 1)
	}

	if (scene.guide !== null) {
		canvas.fillStyle = theme.resizeLine

		if (scene.guide.axis === "cols") canvas.fillRect(scene.guide.at - 1, 0, 2, view.height)
		else canvas.fillRect(0, scene.guide.at - 1, view.width, 2)
	}
}

// The copy's dashes: a step of the moving border moves them one pixel, round a period of CLIP_DASH_PERIOD.
const CLIP_DASH = [4, 4]
export const CLIP_DASH_PERIOD = 8

// A 1 px line on a range's left and top gridlines and its right and bottom ones, dashed `dash`.
function dashedRing(canvas: GridCanvas, view: GridView, range: SheetRange, dash: number[]): void {
	canvas.setLineDash(dash)

	for (const rect of rangeRects(view, range)) {
		canvas.beginPath()
		canvas.rect(rect.x - 0.5, rect.y - 0.5, rect.width, rect.height)
		canvas.stroke()
	}

	canvas.setLineDash([])
}

// A ring `width` wide, `inset` inside the rectangle's edges (its left and top gridlines included), so it never
// covers the neighbouring cells' text.
function ring(canvas: GridCanvas, rect: GridRect, inset: number, width: number): void {
	const x = rect.x - 1 + inset
	const y = rect.y - 1 + inset
	const w = rect.width + 1 - 2 * inset
	const h = rect.height + 1 - 2 * inset

	if (w <= 0 || h <= 0) return

	canvas.fillRect(x, y, w, width)
	canvas.fillRect(x, y + h - width, w, width)
	canvas.fillRect(x, y, width, h)
	canvas.fillRect(x + w - width, y, width, h)
}

function sameRange(a: SheetRange | undefined, b: SheetRange): boolean {
	return a !== undefined && a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol
}
