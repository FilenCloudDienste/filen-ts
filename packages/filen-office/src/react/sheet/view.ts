import { TILE_COLS, TILE_ROWS, type SheetLayout, type SheetRange } from "../../core/sheet/protocol"
import { shownIndex, shownStep, shownTiles, type GridAxis } from "./axis"
import type { GridAxes } from "./model"

// Where things are on screen for one scroll position: the header bands, the frozen rows and columns, and the
// scrolled body, per axis. Painting, hit-testing, revealing a cell and placing the editor all read this.

export const COL_HEADER_HEIGHT = 20
// Tile rows and columns fetched past the edges of what is on screen, in shown indices.
export const MARGIN_ROWS = 16
export const MARGIN_COLS = 8
// How far left of the drawn columns a cell's text is looked for, as it may run on into view, and how far into a
// hidden run of columns text runs on (the tiles of that much of a hidden run between shown columns are fetched).
export const CARRY_COLUMNS = 64
const ROW_HEADER_MIN = 32
const DIGIT_WIDTH = 7.5
const HEADER_PADDING = 12

export interface AxisView {
	readonly axis: GridAxis
	// The header band (0 when the sheet hides headings).
	readonly header: number
	// The frozen indices: `frozen` of them from `frozenFirst` (to `frozenEnd`, exclusive). Those before
	// `frozenFirst` are not shown (Excel's view of a sheet frozen while scrolled).
	readonly frozen: number
	readonly frozenFirst: number
	readonly frozenEnd: number
	readonly frozenSize: number
	// Where the scrolled part starts on the axis.
	readonly bodyStart: number
	// The scrolled part's virtual offset.
	readonly scroll: number
	// The viewport along this axis, and what of it the scrolled part has.
	readonly view: number
	readonly bodyView: number
	// The scrolled part's first and last index on screen (last < first: none).
	readonly first: number
	readonly last: number
}

export interface GridView {
	readonly rows: AxisView
	readonly cols: AxisView
	readonly width: number
	readonly height: number
}

// The row header fits the largest row number shown.
export function rowHeaderWidth(rows: number, headings: boolean): number {
	return headings ? Math.max(ROW_HEADER_MIN, Math.ceil(String(rows).length * DIGIT_WIDTH + HEADER_PADDING)) : 0
}

// The scrolled part's virtual size: past the last index, so the last row can scroll fully into view.
export function bodyTotal(view: AxisView): number {
	return Math.max(0, view.axis.total - view.bodyStart)
}

function axisView(axis: GridAxis, header: number, frozenFrom: number, frozenCount: number, scroll: number, viewSize: number): AxisView {
	const frozenFirst = frozenCount > 0 ? Math.min(frozenFrom, axis.count) : 0
	const frozenEnd = Math.min(frozenFirst + frozenCount, axis.count)
	const frozen = frozenEnd - frozenFirst
	const bodyStart = axis.offset(frozenEnd)
	const frozenSize = bodyStart - axis.offset(frozenFirst)
	const bodyView = Math.max(0, viewSize - header - frozenSize)
	const maxScroll = Math.max(0, axis.total - bodyStart - bodyView)
	const clamped = Math.max(0, Math.min(scroll, maxScroll))
	const first = frozenEnd >= axis.count ? axis.count : Math.max(frozenEnd, axis.indexAt(bodyStart + clamped))
	const last =
		frozenEnd >= axis.count || bodyView <= 0 ? first - 1 : Math.min(axis.lastShown, axis.indexAt(bodyStart + clamped + bodyView - 1))

	return { axis, header, frozen, frozenFirst, frozenEnd, frozenSize, bodyStart, scroll: clamped, view: viewSize, bodyView, first, last }
}

export function gridView(
	axes: GridAxes,
	layout: SheetLayout,
	scroll: { readonly top: number; readonly left: number },
	width: number,
	height: number
): GridView {
	const headings = layout.headings
	const rowHeader = rowHeaderWidth(axes.rows.count, headings)
	const colHeader = headings ? COL_HEADER_HEIGHT : 0

	return {
		rows: axisView(axes.rows, colHeader, layout.pane?.firstRow ?? 0, layout.pane?.rows ?? 0, scroll.top, height),
		cols: axisView(axes.cols, rowHeader, layout.pane?.firstCol ?? 0, layout.pane?.cols ?? 0, scroll.left, width),
		width,
		height
	}
}

// Where `index` starts on screen (one before the frozen ones is above them, out of view).
export function screenOf(view: AxisView, index: number): number {
	return index < view.frozenEnd
		? view.header + view.axis.offset(index) - view.axis.offset(view.frozenFirst)
		: view.header + view.frozenSize + view.axis.offset(index) - view.bodyStart - view.scroll
}

export type AxisHit = { readonly part: "header" } | { readonly part: "frozen" | "body"; readonly index: number }

export function hitAxis(view: AxisView, at: number): AxisHit | null {
	if (at < 0 || at >= view.view) return null
	if (at < view.header) return { part: "header" }
	if (at < view.header + view.frozenSize)
		return { part: "frozen", index: view.axis.indexAt(at - view.header + view.axis.offset(view.frozenFirst)) }

	return { part: "body", index: view.axis.indexAt(at - view.header - view.frozenSize + view.bodyStart + view.scroll) }
}

// The scroll offset that brings `index` fully into view (unchanged when it is, when it is frozen, or before the
// frozen ones, where nothing scrolls it into view).
export function revealOffset(view: AxisView, index: number): number {
	if (index < view.frozenEnd) return view.scroll

	const start = view.axis.offset(index) - view.bodyStart
	const end = start + view.axis.size(index)

	if (start < view.scroll) return start
	if (end > view.scroll + view.bodyView) return Math.min(start, end - view.bodyView)

	return view.scroll
}

// The index nearest `at` whose trailing edge lies within `slop` of it, for resizing from a header: the edge just
// left of (above) the pointer belongs to the index before it.
export function edgeAt(view: AxisView, at: number, slop: number): number | null {
	const hit = hitAxis(view, at)

	if (hit === null || hit.part === "header") return null

	const index = hit.index
	const start = screenOf(view, index)
	const end = start + view.axis.size(index)

	if (end - at <= slop) return index
	if (at - start <= slop) {
		const lowest = index < view.frozenEnd ? view.frozenFirst : 0

		for (let before = index - 1; before >= lowest; before--) if (view.axis.size(before) > 0) return before
	}

	return null
}

// The tiles a frame draws, as tile row and column pairs: those under the view (frozen panes included) plus a margin
// that holds a shown row and column. A filtered or collapsed sheet's hidden runs inside the span are never fetched,
// and the margin counts shown indices, so a scroll past a hidden run finds its tiles held.
export function frameTiles(view: GridView, merges: readonly SheetRange[]): number[] {
	return spanTiles(view, tileSpans(view.rows, MARGIN_ROWS), tileSpans(view.cols, MARGIN_COLS), merges)
}

// One axis's spans of indices to fetch: the frozen ones, and the scrolled ones with `margin` shown indices each side.
export function tileSpans(view: AxisView, margin: number): [number, number][] {
	const spans: [number, number][] = []

	if (view.frozen > 0) spans.push([view.frozenFirst, view.frozenEnd - 1])
	if (view.last >= view.first)
		spans.push([Math.max(view.frozenEnd, shownStep(view.axis, view.first, margin, -1)), shownStep(view.axis, view.last, margin, 1)])

	return spans
}

export function spanTiles(
	view: GridView,
	rowSpans: readonly [number, number][],
	colSpans: readonly [number, number][],
	merges: readonly SheetRange[]
): number[] {
	const tileRows = new Set<number>()
	const tileCols = new Set<number>()

	for (const [first, last] of rowSpans) for (const tile of shownTiles(view.rows.axis, first, last, TILE_ROWS)) tileRows.add(tile)
	for (const [first, last] of colSpans) {
		for (const tile of shownTiles(view.cols.axis, first, last, TILE_COLS)) tileCols.add(tile)

		hiddenRunTiles(view.cols.axis, first, last, tileCols)
	}

	const coordinates: number[] = []

	for (const tileRow of tileRows) for (const tileCol of tileCols) coordinates.push(tileRow, tileCol)

	// A merge partly shown in the spans reads its text and style from its first cell, which may sit in a hidden row
	// or column (or before the margin): its tile is kept too. A merge wholly in a hidden run adds nothing.
	for (const merge of merges)
		if (
			shownIn(view.rows.axis, rowSpans, merge.startRow, merge.endRow) &&
			shownIn(view.cols.axis, colSpans, merge.startCol, merge.endCol)
		)
			coordinates.push(Math.floor(merge.startRow / TILE_ROWS), Math.floor(merge.startCol / TILE_COLS))

	return coordinates
}

// Text runs on across a hidden run of columns, stopping at hidden content, for up to CARRY_COLUMNS columns from
// either shown side (runOn): the tile columns of that much of every hidden run before a shown column of
// `first..last` are added (from its left end only when a shown column lies there), so content there stops it
// whatever the cache holds. One step per shown column.
function hiddenRunTiles(axis: GridAxis, first: number, last: number, tiles: Set<number>): void {
	const start = shownIndex(axis, first, 1)

	if (start < 0 || start > last) return

	for (let before = start > 0 ? shownIndex(axis, start - 1, -1) : -1, shown = start; ;) {
		if (shown > before + 1) {
			if (before >= 0) addTiles(tiles, before + 1, Math.min(shown - 1, before + CARRY_COLUMNS))

			addTiles(tiles, Math.max(before + 1, shown - CARRY_COLUMNS), shown - 1)
		}

		const next = shown + 1 < axis.count ? shownIndex(axis, shown + 1, 1) : -1

		if (next < 0 || next > last) return

		before = shown
		shown = next
	}
}

function addTiles(tiles: Set<number>, first: number, last: number): void {
	for (let tile = Math.floor(first / TILE_COLS); tile <= Math.floor(last / TILE_COLS); tile++) tiles.add(tile)
}

// Whether a shown index of `first..last` lies inside one of the spans.
function shownIn(axis: GridAxis, spans: readonly (readonly [number, number])[], first: number, last: number): boolean {
	return spans.some(([from, to]) => {
		if (first > to || last < from) return false

		const shown = shownIndex(axis, Math.max(first, from), 1)

		return shown >= 0 && shown <= Math.min(last, to)
	})
}
