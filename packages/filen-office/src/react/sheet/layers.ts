import type { ReactNode } from "react"
import { TILE_COLS, TILE_ROWS, tileKey, type SheetId, type SheetLayout, type SheetRange } from "../../core/sheet/protocol"
import { shownTiles } from "./axis"
import type { SheetGridModel } from "./model"
import type { GridCanvas } from "./paint/canvas"
import type { GridPoint } from "./selection"
import type { SheetGridTheme } from "./theme"
import type { GridTile } from "./tiles"
import { screenOf, type AxisView, type GridView } from "./view"

// How features add to the grid without editing it: paint layers (a canvas pass of their own), cell decorators (a
// mark on every cell whose tile entry carries a flag), and a pointer hook on cells. An app hands them to SheetGrid as
// `extensions`; overlays (DOM over the grid) are SheetGrid's children, placed with SheetGridHandle.cellRect and
// re-placed on SheetGridHandle.onFrame. Each extension is drawn or asked in list order.

// A rectangle as the grid lays it out: left to right, in CSS pixels from the grid's top left. A right-to-left
// sheet is drawn mirrored by the canvas transform, so painters draw laid-out rectangles as they are.
export interface GridRect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

// One axis's part on screen: the frozen indices, or the scrolled ones; `first` to `last` drawn from `start` to `end`.
export interface GridSegment {
	readonly first: number
	readonly last: number
	readonly start: number
	readonly end: number
}

// One pane: a pair of segments, and the rectangle it is clipped to.
export interface GridPane {
	readonly rows: GridSegment
	readonly cols: GridSegment
	readonly clip: GridRect
}

export interface GridPaintScene {
	readonly model: SheetGridModel
	readonly sheet: SheetId
	readonly layout: SheetLayout
	readonly view: GridView
	readonly theme: SheetGridTheme
	// The sheet's zoom: a file's sizes (fonts, line widths) times this.
	readonly scale: number
	readonly pixelRatio: number
	readonly rightToLeft: boolean
	readonly panes: readonly GridPane[]
	// A cell's box, or its merge's when it is in one; null when it is hidden (a zero-size row or column). Unclipped.
	cellBox(row: number, col: number): GridRect | null
	// A range's rectangles, one per pane it shows in, clipped to the pane.
	rangeRects(range: SheetRange): readonly GridRect[]
}

// A whole pass on one canvas. "cells": over the cells and their decorations, under the selection; "chrome": over
// the selection, under the headers. Called with the laid-out transform set (mirrored for a right-to-left sheet) and
// the canvas state saved around it.
export interface SheetGridLayer {
	readonly id: string
	readonly stage: "cells" | "chrome"
	// A "cells" layer that reads only the scene's layout, view, theme, scale and pixel ratio (cellBox and panes come
	// from them): a frame that changes none of those (a selection move, an entry's keystroke) keeps the cells canvas.
	// Without it a cells layer may read anything, and the cells canvas is drawn again on every frame.
	readonly pure?: boolean | undefined
	paint(canvas: GridCanvas, scene: GridPaintScene): void
}

// A cell a decorator marks: its tile entry and its box (the merge's for a merge's first cell).
export interface GridDecoration {
	readonly row: number
	readonly col: number
	readonly flags: number
	readonly tile: GridTile
	readonly entry: number
	readonly box: GridRect
}

// A mark on every cell on screen whose tile entry has a flag of `mask` (CellFlag bits): "under" after the fills, under
// the borders and text (a data bar); "over" after the text (a note's corner). Cells a merge covers but its first are
// skipped. Called per pane, clipped to it, with the laid-out transform set and the canvas state saved per cell pass.
export interface SheetCellDecorator {
	readonly id: string
	readonly mask: number
	readonly phase: "under" | "over"
	// Pixels at 100 % the mark takes at the leading edge of each cell it marks: the cell's text lays out after it
	// (a conditional format's icon).
	readonly inset?: number
	paint(canvas: GridCanvas, cell: GridDecoration, scene: GridPaintScene): void
}

// What the pointer does on cells, for an extension. "hover" when a mouse or pen (no button down) moves onto another
// cell, "leave" when it leaves the cells; "down" for a primary press (a tap, for touch) on a cell before the grid
// selects anything, while an entry is open too (`editing`).
export type SheetCellPointer =
	| { readonly kind: "hover"; readonly row: number; readonly col: number; readonly clientX: number; readonly clientY: number }
	| { readonly kind: "leave" }
	| {
			readonly kind: "down"
			readonly row: number
			readonly col: number
			readonly clientX: number
			readonly clientY: number
			readonly pointerType: string
			readonly ctrlKey: boolean
			readonly metaKey: boolean
			readonly shiftKey: boolean
			readonly altKey: boolean
			readonly editing: boolean
	  }

// A press an extension took and follows: the cell under the pointer as it moves (on a change of cell), then the end
// (`commit` false when the press was cancelled).
export interface SheetCellDrag {
	move(point: GridPoint): void
	end(commit: boolean): void
}

// true (or a drag) takes a "down": the grid neither selects nor focuses (an open entry keeps focus) and the press's
// default is prevented. Hover and leave answers are ignored.
export type SheetCellPointerResult = boolean | SheetCellDrag | undefined

// An entry typed into a cell (committed from the editor, or Ctrl+Enter's entry for its active cell) before it is
// written.
export interface SheetEntryCheck {
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
	readonly text: string
}

// What an extension says of an entry: "commit" lets it through, { text } lets through that text instead (the next
// extension sees it), "edit" reopens the entry with its text on its cell, "discard" drops it (the cell keeps what it
// held). The first answer other than "commit" or a new text ends the checks.
export type SheetEntryVerdict = "commit" | "edit" | "discard" | { readonly text: string }

export type SheetEntryHook = (entry: SheetEntryCheck) => SheetEntryVerdict | Promise<SheetEntryVerdict>

export interface SheetGridExtension {
	readonly id: string
	readonly layers?: readonly SheetGridLayer[]
	readonly decorators?: readonly SheetCellDecorator[]
	readonly pointer?: (event: SheetCellPointer) => SheetCellPointerResult
	// Asked, in extension order, before an entry is written (data validation's alert).
	readonly entry?: SheetEntryHook
	// The in-cell editor's text to draw under it, glyph for glyph, while its own is clear (a formula's references in
	// the colours they are outlined in); null leaves it plain. The first extension answering other than null has it.
	// Kept as one text run it lands exactly on the editor's glyphs: elements inside it round their edges and drift.
	readonly editorText?: (text: string) => ReactNode | null
}

// The entry `hooks` let through ("commit" with its final text), or what stops it.
export async function checkEntry(
	hooks: readonly SheetEntryHook[],
	entry: SheetEntryCheck
): Promise<{ readonly verdict: "commit"; readonly text: string } | { readonly verdict: "edit" | "discard" }> {
	let text = entry.text

	for (const hook of hooks) {
		const verdict = await hook({ ...entry, text })

		if (verdict === "edit" || verdict === "discard") return { verdict }
		if (verdict !== "commit") text = verdict.text
	}

	return { verdict: "commit", text }
}

// An axis's parts on screen: the frozen indices, then the scrolled ones.
export function segments(view: AxisView): GridSegment[] {
	const parts: GridSegment[] = []

	if (view.frozen > 0)
		parts.push({ first: view.frozenFirst, last: view.frozenEnd - 1, start: view.header, end: view.header + view.frozenSize })
	if (view.last >= view.first) parts.push({ first: view.first, last: view.last, start: view.header + view.frozenSize, end: view.view })

	return parts
}

export function gridPanes(view: GridView): GridPane[] {
	const panes: GridPane[] = []

	for (const rows of segments(view.rows))
		for (const cols of segments(view.cols))
			panes.push({ rows, cols, clip: { x: cols.start, y: rows.start, width: cols.end - cols.start, height: rows.end - rows.start } })

	return panes
}

function spanIn(view: AxisView, first: number, last: number, segment: GridSegment): [number, number] | null {
	const from = Math.max(first, segment.first)
	const to = Math.min(last, segment.last)

	if (from > to) return null

	return [screenOf(view, from), screenOf(view, to) + view.axis.size(to)]
}

// A range's on-screen rectangles, one per pane it shows in, clipped to the pane.
export function rangeRects(view: GridView, range: SheetRange): GridRect[] {
	const rects: GridRect[] = []

	for (const rows of segments(view.rows)) {
		const ys = spanIn(view.rows, range.startRow, range.endRow, rows)

		if (ys === null) continue

		for (const cols of segments(view.cols)) {
			const xs = spanIn(view.cols, range.startCol, range.endCol, cols)

			if (xs === null) continue

			const x = Math.max(xs[0], cols.start)
			const y = Math.max(ys[0], rows.start)

			rects.push({ x, y, width: Math.min(xs[1], cols.end) - x, height: Math.min(ys[1], rows.end) - y })
		}
	}

	return rects
}

function within(merge: SheetRange, row: number, col: number): boolean {
	return row >= merge.startRow && row <= merge.endRow && col >= merge.startCol && col <= merge.endCol
}

export function paintScene(base: Omit<GridPaintScene, "panes" | "cellBox" | "rangeRects">): GridPaintScene {
	const { view, model, layout } = base
	const merges = model.merges(layout)

	return {
		...base,
		panes: gridPanes(view),
		cellBox: (row, col) => {
			const merge = merges.length === 0 ? undefined : merges.find(found => within(found, row, col))
			const startRow = merge?.startRow ?? row
			const startCol = merge?.startCol ?? col
			const endRow = merge?.endRow ?? row
			const endCol = merge?.endCol ?? col
			const width = view.cols.axis.offset(endCol + 1) - view.cols.axis.offset(startCol)
			const height = view.rows.axis.offset(endRow + 1) - view.rows.axis.offset(startRow)

			if (width <= 0 || height <= 0) return null

			return { x: screenOf(view.cols, startCol), y: screenOf(view.rows, startRow), width, height }
		},
		rangeRects: range => rangeRects(view, range)
	}
}

// The decorators of `phase` over one pane's cells: each held tile under the pane is walked once, its entries
// matched against the decorators' masks.
export function decoratePane(
	canvas: GridCanvas,
	scene: GridPaintScene,
	decorators: readonly SheetCellDecorator[],
	phase: "under" | "over",
	rows: GridSegment,
	cols: GridSegment
): void {
	const own = decorators.filter(decorator => decorator.phase === phase)

	if (own.length === 0 || rows.last < rows.first || cols.last < cols.first) return

	let mask = 0

	for (const decorator of own) mask |= decorator.mask

	const { model, sheet, layout } = scene
	const merges = model
		.merges(layout)
		.filter(
			merge => merge.startRow <= rows.last && merge.endRow >= rows.first && merge.startCol <= cols.last && merge.endCol >= cols.first
		)

	canvas.save()
	canvas.beginPath()
	canvas.rect(cols.start, rows.start, cols.end - cols.start, rows.end - rows.start)
	canvas.clip()

	// Only tiles holding a shown row and column: a filtered sheet's hidden runs are stepped over.
	const tileRows = shownTiles(scene.view.rows.axis, rows.first, rows.last, TILE_ROWS)
	const tileCols = shownTiles(scene.view.cols.axis, cols.first, cols.last, TILE_COLS)

	for (const tileRow of tileRows) {
		for (const tileCol of tileCols) {
			const tile = model.tiles.peek(tileKey(sheet, tileRow, tileCol))

			if (tile === undefined) continue

			for (let entry = 0; entry < tile.count; entry++) {
				const flags = tile.flags[entry] ?? 0

				if ((flags & mask) === 0) continue

				const position = tile.positions[entry] ?? 0
				const row = tileRow * TILE_ROWS + Math.floor(position / TILE_COLS)
				const col = tileCol * TILE_COLS + (position % TILE_COLS)

				if (row < rows.first || row > rows.last || col < cols.first || col > cols.last) continue

				const merge = merges.length === 0 ? undefined : merges.find(found => within(found, row, col))

				if (merge !== undefined && (merge.startRow !== row || merge.startCol !== col)) continue

				const box = scene.cellBox(row, col)

				if (box === null) continue

				const cell: GridDecoration = { row, col, flags, tile, entry, box }

				for (const decorator of own) {
					if ((flags & decorator.mask) === 0) continue

					canvas.save()
					decorator.paint(canvas, cell, scene)
					canvas.restore()
				}
			}
		}
	}

	canvas.restore()

	// Merges whose first cell the walk above did not reach still show in the pane: the first cell is above or left of
	// it, or sits in a tile with no shown row or column (a partly shown merge anchored in a hidden run).
	for (const merge of merges) {
		if (
			merge.startRow >= rows.first &&
			merge.startCol >= cols.first &&
			tileRows.includes(Math.floor(merge.startRow / TILE_ROWS)) &&
			tileCols.includes(Math.floor(merge.startCol / TILE_COLS))
		)
			continue

		const found = model.entry(sheet, merge.startRow, merge.startCol)

		if (found === null) continue

		const flags = found.tile.flags[found.entry] ?? 0
		const box = scene.cellBox(merge.startRow, merge.startCol)

		if ((flags & mask) === 0 || box === null) continue

		canvas.save()
		canvas.beginPath()
		canvas.rect(cols.start, rows.start, cols.end - cols.start, rows.end - rows.start)
		canvas.clip()

		for (const decorator of own) {
			if ((flags & decorator.mask) === 0) continue

			canvas.save()
			decorator.paint(canvas, { row: merge.startRow, col: merge.startCol, flags, tile: found.tile, entry: found.entry, box }, scene)
			canvas.restore()
		}

		canvas.restore()
	}
}

// The text inset the decorators ask for a cell with `flags`, or undefined when none asks for any.
export function decoratorInset(decorators: readonly SheetCellDecorator[]): ((flags: number) => number) | undefined {
	const insets = decorators.filter(decorator => (decorator.inset ?? 0) > 0)

	if (insets.length === 0) return undefined

	return flags => {
		let total = 0

		for (const decorator of insets) if ((flags & decorator.mask) !== 0) total += decorator.inset ?? 0

		return total
	}
}

// The extensions' parts, flattened once per change of the list.
export interface GridExtensionParts {
	readonly cellLayers: readonly SheetGridLayer[]
	readonly chromeLayers: readonly SheetGridLayer[]
	readonly decorators: readonly SheetCellDecorator[]
	readonly pointers: readonly ((event: SheetCellPointer) => SheetCellPointerResult)[]
	readonly entries: readonly SheetEntryHook[]
}

export const NO_EXTENSIONS: GridExtensionParts = { cellLayers: [], chromeLayers: [], decorators: [], pointers: [], entries: [] }

export function extensionParts(extensions: readonly SheetGridExtension[] | undefined): GridExtensionParts {
	if (extensions === undefined || extensions.length === 0) return NO_EXTENSIONS

	const ids = new Set<string>()
	const cellLayers: SheetGridLayer[] = []
	const chromeLayers: SheetGridLayer[] = []
	const decorators: SheetCellDecorator[] = []
	const pointers: ((event: SheetCellPointer) => SheetCellPointerResult)[] = []
	const entries: SheetEntryHook[] = []

	for (const extension of extensions) {
		if (ids.has(extension.id)) throw new Error(`Sheet grid extension "${extension.id}" is given twice`)

		ids.add(extension.id)

		for (const layer of extension.layers ?? []) (layer.stage === "cells" ? cellLayers : chromeLayers).push(layer)

		decorators.push(...(extension.decorators ?? []))

		if (extension.pointer !== undefined) pointers.push(extension.pointer)
		if (extension.entry !== undefined) entries.push(extension.entry)
	}

	return { cellLayers, chromeLayers, decorators, pointers, entries }
}

// What the first extension with an answer draws under the in-cell editor's `text`, or null.
export function editorBackdrop(extensions: readonly SheetGridExtension[] | undefined, text: string): ReactNode | null {
	for (const extension of extensions ?? []) {
		const drawn = extension.editorText?.(text) ?? null

		if (drawn !== null) return drawn
	}

	return null
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, i) => item === b[i])
}

export function sameParts(a: GridExtensionParts, b: GridExtensionParts): boolean {
	return (
		a === b ||
		(sameList(a.cellLayers, b.cellLayers) &&
			sameList(a.chromeLayers, b.chromeLayers) &&
			sameList(a.decorators, b.decorators) &&
			sameList(a.pointers, b.pointers) &&
			sameList(a.entries, b.entries))
	)
}

// Runs each layer with its own saved canvas state, the laid-out transform set.
export function paintLayers(canvas: GridCanvas, scene: GridPaintScene, layers: readonly SheetGridLayer[]): void {
	for (const layer of layers) {
		canvas.save()

		if (scene.rightToLeft) canvas.setTransform(-scene.pixelRatio, 0, 0, scene.pixelRatio, scene.view.width * scene.pixelRatio, 0)
		else canvas.setTransform(scene.pixelRatio, 0, 0, scene.pixelRatio, 0, 0)

		layer.paint(canvas, scene)
		canvas.restore()
	}
}
