import {
	AxisFlag,
	CellFlag,
	SHEET_MAX_COLS,
	type SheetBorderLine,
	type SheetId,
	type SheetLayout,
	type SheetRange,
	type SheetPatternType,
	type SheetRenderStyle,
	type SheetTile
} from "../../../core/sheet/protocol"
import { fitGeneral } from "../../../core/sheet/numfmt/general"
import { axisEntry, shownIndex, shownIndices } from "../axis"
import { segments, type GridSegment } from "../layers"
import type { SheetGridModel } from "../model"
import type { SheetGridTheme } from "../theme"
import { entryInput, entryRepeat, entryRuns, entryText } from "../tiles"
import { CARRY_COLUMNS, screenOf, type GridView } from "../view"
import { BorderPainter, strongerLine } from "./borders"
import { rgb, type GridCanvas } from "./canvas"
import type { PatternCache } from "./patterns"
import { layoutText, textFont, type TextLine, type TextMeasurer, type TextRun } from "./text"

// The cells layer: per pane (frozen corner, frozen rows, frozen columns, body), gridlines, fills (a cell's own
// style, else its row's or column's), merged blocks, borders and text. Only cells on screen are visited, so a
// frame costs what the viewport holds, never what the sheet holds.
//
// A right-to-left sheet (sheetView rightToLeft, §18.3.1.87) is drawn mirrored: column A on the right, as Excel and
// LibreOffice show it. The grid is laid out as for left to right and drawn through a mirroring transform; text is
// drawn unmirrored at its mirrored place. A cell's left and right borders are its leading and trailing edges
// (Part 4 §15.5.1/§15.5.2, equivalent to start and end, Part 1 §18.8.37/§18.8.16), so they mirror with the grid.
// Explicit left and right alignment stays on that side of the screen ("even in Right-to-Left mode", §18.18.40), as
// do diagonals and patterns. General alignment does not follow the sheet (§18.18.40 is silent; LibreOffice measured):
// numbers at the right, text at the side its own direction starts from.

// Text inset from the cell's edges at 100 %, as Excel draws it.
export const TEXT_PADDING = 3
const LINE_HEIGHT = 1.2
const DESCENT = 0.22
// Text drawn on a fill the file chose: dark unless the cell says otherwise (the file drew it for paper).
const PAPER_TEXT = "#000000"
// Black, the file's automatic and dark-1 text and line colour.
const AUTOMATIC = 0x000000

// A text colour as drawn. On a cell without a fill, automatic (black) text takes the theme's text colour, as Excel's
// dark mode draws unformatted cells; any other colour, and everything on a fill, is the file's.
function ink(color: number | undefined, onFill: boolean, theme: SheetGridTheme): string {
	if (onFill) return color === undefined ? PAPER_TEXT : rgb(color)

	return color === undefined || color === AUTOMATIC ? theme.text : rgb(color)
}

export interface CellScene {
	// Pixels at 100 % a cell's text leaves free at its leading edge, by its tile flags (a decorator's icon there).
	readonly inset?: ((flags: number) => number) | undefined
	readonly model: SheetGridModel
	readonly sheet: SheetId
	readonly layout: SheetLayout
	readonly view: GridView
	readonly theme: SheetGridTheme
	readonly scale: number
	readonly pixelRatio: number
}

export interface CellPainters {
	readonly canvas: GridCanvas
	readonly measurer: TextMeasurer
	readonly borders: BorderPainter
	readonly patterns: PatternCache
	// Told which cell the text drawn next belongs to, and (-1, -1) once it is drawn (a tagged PDF's table cells).
	readonly textCell?: (row: number, col: number) => void
}

// Look-ups one frame repeats: a row's or column's own style, whether a row's style wins.
class Lookup {
	private readonly rowStyles = new Map<number, number>()
	private readonly colStyles = new Map<number, number>()

	private readonly scene: CellScene
	readonly merges: readonly SheetRange[]
	// The merges by row, for the rows drawn and the shown one each side (the rest search them all).
	private readonly byRow: Map<number, SheetRange[]> | null

	// `rows`: the shown rows asked about, in order.
	constructor(scene: CellScene, merges: readonly SheetRange[], rows: readonly number[]) {
		this.scene = scene
		this.merges = merges

		if (merges.length === 0) {
			this.byRow = null

			return
		}

		const byRow = new Map<number, SheetRange[]>()

		for (const row of rows) byRow.set(row, [])

		for (const merge of merges)
			for (let i = firstAtLeast(rows, merge.startRow); i < rows.length && (rows[i] ?? 0) <= merge.endRow; i++)
				byRow.get(rows[i] ?? 0)?.push(merge)

		this.byRow = byRow
	}

	private rowStyle(row: number): number {
		let style = this.rowStyles.get(row)

		if (style === undefined) {
			const entry = axisEntry(this.scene.layout.rows, row)

			style = entry !== null && (entry.flags & AxisFlag.STYLED) !== 0 ? entry.style : -1
			this.rowStyles.set(row, style)
		}

		return style
	}

	private colStyle(col: number): number {
		let style = this.colStyles.get(col)

		if (style === undefined) {
			style = axisEntry(this.scene.layout.cols, col)?.style ?? 0
			this.colStyles.set(col, style)
		}

		return style
	}

	// The render style index a cell draws with.
	styleIndex(row: number, col: number): number {
		const found = this.scene.model.entry(this.scene.sheet, row, col)

		if (found !== null) return found.tile.styles[found.entry] ?? 0

		const rowStyle = this.rowStyle(row)

		return rowStyle >= 0 ? rowStyle : this.colStyle(col)
	}

	text(row: number, col: number): string {
		const pending = this.scene.model.pendingText(this.scene.sheet, row, col)

		if (pending !== undefined) return pending

		const found = this.scene.model.entry(this.scene.sheet, row, col)

		return found === null ? "" : shownText(this.scene, found.tile, found.entry)
	}

	merge(row: number, col: number): SheetRange | null {
		if (this.merges.length === 0) return null

		for (const merge of this.byRow?.get(row) ?? this.merges)
			if (row >= merge.startRow && row <= merge.endRow && col >= merge.startCol && col <= merge.endCol) return merge

		return null
	}

	// Something to show, or part of a merge: text running on from a neighbour stops here.
	occupied(row: number, col: number): boolean {
		return this.text(row, col) !== "" || this.merge(row, col) !== null
	}
}

// The first position in ascending `list` holding `value` or more (list.length: none).
function firstAtLeast(list: readonly number[], value: number): number {
	let low = 0
	let high = list.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((list[middle] ?? 0) < value) low = middle + 1
		else high = middle
	}

	return low
}

// Whether a formula cell shows its formula instead of its result (Ctrl+`, Excel's Show Formulas).
function showsFormula(scene: CellScene, tile: SheetTile, entry: number): boolean {
	return ((tile.flags[entry] ?? 0) & CellFlag.FORMULA) !== 0 && scene.model.getSnapshot().showFormulas
}

// What an entry shows: its text, or its formula as typed.
function shownText(scene: CellScene, tile: SheetTile, entry: number): string {
	return showsFormula(scene, tile, entry) ? entryInput(tile, entry) : entryText(tile, entry)
}

function intersecting(layout: SheetLayout, rows: GridSegment, cols: GridSegment): SheetRange[] {
	const found: SheetRange[] = []
	const quads = layout.merges

	for (let i = 0; i + 3 < quads.length; i += 4) {
		const startRow = quads[i] ?? 0
		const startCol = quads[i + 1] ?? 0
		const endRow = quads[i + 2] ?? 0
		const endCol = quads[i + 3] ?? 0

		if (
			startRow <= rows.last + 1 &&
			endRow >= rows.first - 1 &&
			startCol <= cols.last + CARRY_COLUMNS &&
			endCol >= cols.first - CARRY_COLUMNS
		)
			found.push({ startRow, startCol, endRow, endCol })
	}

	return found
}

// `under` draws what goes between a pane's fills and its borders and text (layers.ts's "under" decorators), clipped
// to the pane.
export function paintCells(painters: CellPainters, scene: CellScene, under?: (rows: GridSegment, cols: GridSegment) => void): void {
	const { canvas } = painters
	const { view, theme } = scene

	logical(canvas, scene)
	canvas.fillStyle = theme.background
	canvas.fillRect(0, 0, view.width, view.height)
	painters.borders.reset(theme.border)
	painters.measurer.reset()
	roundedTexts.delete(scene.model)

	for (const rows of segments(view.rows)) for (const cols of segments(view.cols)) paintPane(painters, scene, rows, cols, under)
}

// restore() puts back the font saved with the state, which the measurer cannot see.
function restore(painters: CellPainters): void {
	painters.canvas.restore()
	painters.measurer.reset()
}

// The transform cells are laid out in: mirrored for a right-to-left sheet.
function logical(canvas: GridCanvas, scene: CellScene): void {
	const { pixelRatio, view } = scene

	if (scene.layout.rightToLeft) canvas.setTransform(-pixelRatio, 0, 0, pixelRatio, view.width * pixelRatio, 0)
	else canvas.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
}

// The screen's own transform, for text in a mirrored sheet: a span from x to x + width is drawn from screen x.
function physical(canvas: GridCanvas, scene: CellScene): void {
	canvas.setTransform(scene.pixelRatio, 0, 0, scene.pixelRatio, 0, 0)
}

// Where a span laid out from x to x + width starts on screen.
function screenX(scene: CellScene, x: number, width: number): number {
	return scene.layout.rightToLeft ? scene.view.width - x - width : x
}

// The pattern drawn mirrored that shows the file's (a diagonal hatch leans the other way).
const MIRRORED_PATTERNS: Partial<Record<SheetPatternType, SheetPatternType>> = {
	darkDown: "darkUp",
	darkUp: "darkDown",
	lightDown: "lightUp",
	lightUp: "lightDown"
}

interface Box {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

function paintPane(
	painters: CellPainters,
	scene: CellScene,
	rows: GridSegment,
	cols: GridSegment,
	under: ((rows: GridSegment, cols: GridSegment) => void) | undefined
): void {
	const { canvas } = painters
	const { model, view, layout, theme } = scene
	const rowAxis = view.rows.axis
	const colAxis = view.cols.axis
	const rowList = shownIndices(rowAxis, rows.first, rows.last)
	const colList = shownIndices(colAxis, cols.first, cols.last)
	// The shown row before and after the drawn ones, whose borders meet theirs.
	const beforeRow = rowList.length === 0 ? -1 : shownIndex(rowAxis, (rowList[0] ?? 0) - 1, -1)
	const afterRow = rowList.length === 0 ? -1 : shownIndex(rowAxis, (rowList[rowList.length - 1] ?? 0) + 1, 1)
	const asked = beforeRow < 0 ? [...rowList] : [beforeRow, ...rowList]

	if (afterRow >= 0) asked.push(afterRow)

	const lookup = new Lookup(scene, intersecting(layout, rows, cols), asked)

	const rowY = rowList.map(row => screenOf(view.rows, row))
	const colX = colList.map(col => screenOf(view.cols, col))

	canvas.save()
	canvas.beginPath()
	canvas.rect(cols.start, rows.start, cols.end - cols.start, rows.end - rows.start)
	canvas.clip()

	LAID_OUT.clear()

	// Gridlines on each cell's right and bottom pixel.
	if (layout.gridLines && rowList.length > 0 && colList.length > 0) {
		const right = Math.min(cols.end, (colX[colX.length - 1] ?? 0) + colAxis.size(colList[colList.length - 1] ?? 0))
		const bottom = Math.min(rows.end, (rowY[rowY.length - 1] ?? 0) + rowAxis.size(rowList[rowList.length - 1] ?? 0))

		// Text running on into empty neighbours hides the vertical gridlines it crosses, as Excel draws it.
		const covered = runOnCover(painters, scene, lookup, rowList, colList, colX, cols)

		canvas.fillStyle = theme.gridLine
		rowList.forEach((row, i) => canvas.fillRect(cols.start, (rowY[i] ?? 0) + rowAxis.size(row) - 1, right - cols.start, 1))
		colList.forEach((col, j) => {
			const x = (colX[j] ?? 0) + colAxis.size(col) - 1
			const hidden = covered.get(x)

			if (hidden === undefined) {
				canvas.fillRect(x, rows.start, 1, bottom - rows.start)

				return
			}

			// The line in pieces, around the rows whose text crosses it.
			let from = rows.start

			rowList.forEach((row, i) => {
				if (!hidden.has(row)) return

				const top = rowY[i] ?? 0

				if (top > from) canvas.fillRect(x, from, 1, top - from)

				from = top + rowAxis.size(row) - 1
			})

			if (bottom > from) canvas.fillRect(x, from, 1, bottom - from)
		})
	}

	// Fills: a cell's own, or its row's or column's. Merged cells are drawn as one block below.
	rowList.forEach((row, i) => {
		const y = rowY[i] ?? 0
		const height = rowAxis.size(row)

		colList.forEach((col, j) => {
			if (lookup.merges.length > 0 && lookup.merge(row, col) !== null) return

			const style = model.style(lookup.styleIndex(row, col))

			if (hasFill(style)) fillBox(painters, scene, style, { x: colX[j] ?? 0, y, width: colAxis.size(col), height })
		})
	})

	const blocks = lookup.merges
		.filter(
			merge => merge.startRow <= rows.last && merge.endRow >= rows.first && merge.startCol <= cols.last && merge.endCol >= cols.first
		)
		.map(merge => ({ merge, box: mergeBox(view, merge) }))

	for (const { merge, box } of blocks) {
		const style = model.style(lookup.styleIndex(merge.startRow, merge.startCol))

		if (hasFill(style)) {
			fillBox(painters, scene, style, box)
		} else {
			// Hides the gridlines inside the block, keeping its own edges.
			canvas.fillStyle = theme.background
			canvas.fillRect(box.x, box.y, box.width - 1, box.height - 1)
		}
	}

	if (under !== undefined) {
		canvas.save()
		under(rows, cols)
		restore(painters)
	}

	paintBorders(painters, scene, lookup, { rowList, colList, beforeRow, afterRow }, rowY, colX, blocks)

	// Text: merged blocks, then single cells (with text running on into empty neighbours).
	for (const { merge, box } of blocks) paintText(painters, scene, lookup, merge.startRow, merge.startCol, box, box.x, box.x + box.width)

	rowList.forEach((row, i) => {
		const y = rowY[i] ?? 0
		const height = rowAxis.size(row)

		textCells(scene, lookup, row, colList, colX, cols, (col, knownX) => {
			// Text the gridline pass laid out already (it runs on) is drawn from that layout.
			const laid = LAID_OUT.get(row * SHEET_MAX_COLS + col)
			const run = laid?.run ?? runOn(scene, lookup, row, col, cols, knownX)

			if (run !== null)
				drawText(painters, scene, run.content, { x: run.x, y, width: run.width, height }, run.left, run.right, laid?.line)
		})
	})

	LAID_OUT.clear()
	restore(painters)
}

function mergeBox(view: GridView, merge: SheetRange): Box {
	return {
		x: screenOf(view.cols, merge.startCol),
		y: screenOf(view.rows, merge.startRow),
		width: view.cols.axis.offset(merge.endCol + 1) - view.cols.axis.offset(merge.startCol),
		height: view.rows.axis.offset(merge.endRow + 1) - view.rows.axis.offset(merge.startRow)
	}
}

function fillBox(painters: CellPainters, scene: CellScene, style: SheetRenderStyle, box: Box): void {
	const { canvas, patterns } = painters

	const pattern =
		style.pattern !== undefined && scene.layout.rightToLeft
			? { ...style.pattern, type: MIRRORED_PATTERNS[style.pattern.type] ?? style.pattern.type }
			: style.pattern

	canvas.fillStyle = pattern !== undefined ? patterns.fill(canvas, pattern, scene.pixelRatio) : rgb(style.fill ?? 0xffffff)
	canvas.fillRect(box.x, box.y, box.width, box.height)
}

// Each shown cell's top and left edge (and the last row's and column's bottom and right), the heavier of the two
// cells' lines where they meet; edges inside a merge are not drawn. Then diagonals.
function paintBorders(
	painters: CellPainters,
	scene: CellScene,
	lookup: Lookup,
	shown: {
		readonly rowList: readonly number[]
		readonly colList: readonly number[]
		readonly beforeRow: number
		readonly afterRow: number
	},
	rowY: readonly number[],
	colX: readonly number[],
	blocks: readonly { readonly merge: SheetRange; readonly box: Box }[]
): void {
	const { rowList, colList, beforeRow: beforeRows, afterRow: afterRows } = shown
	const { borders } = painters
	const { model, view, scale } = scene
	const rowAxis = view.rows.axis
	const colAxis = view.cols.axis
	const styleOf = (row: number, col: number): SheetRenderStyle => (row < 0 || col < 0 ? {} : model.style(lookup.styleIndex(row, col)))
	// Whether the cell is drawn on a fill: its own, or its merged block's.
	const filled = (row: number, col: number): boolean => {
		if (row < 0 || col < 0) return false

		const block = lookup.merges.length > 0 ? lookup.merge(row, col) : null

		return hasFill(block === null ? styleOf(row, col) : styleOf(block.startRow, block.startCol))
	}
	const sameMerge = (a: SheetRange | null, row: number, col: number): boolean =>
		a !== null && row >= a.startRow && row <= a.endRow && col >= a.startCol && col <= a.endCol
	// The shown index before the first and after the last drawn one (the rest are the drawn ones' neighbours).
	const firstCol = colList[0] ?? 0
	const lastRow = rowList[rowList.length - 1] ?? 0
	const lastCol = colList[colList.length - 1] ?? 0
	const beforeCols = shownIndex(colAxis, firstCol - 1, -1)
	const afterCols = shownIndex(colAxis, lastCol + 1, 1)

	rowList.forEach((row, i) => {
		const y = rowY[i] ?? 0
		const height = rowAxis.size(row)
		const above = i === 0 ? beforeRows : (rowList[i - 1] ?? -1)
		const below = row === lastRow ? afterRows : -1

		colList.forEach((col, j) => {
			const x = colX[j] ?? 0
			const width = colAxis.size(col)
			const style = styleOf(row, col)
			const merge = lookup.merges.length > 0 ? lookup.merge(row, col) : null
			const left = j === 0 ? beforeCols : (colList[j - 1] ?? -1)
			const own = merge === null ? hasFill(style) : filled(row, col)

			if (!sameMerge(merge, above, col)) {
				const line = strongerLine(styleOf(above, col).bottom, style.top)

				if (line !== undefined) borders.edge(line, true, y - 0.5, x - 1, x + width, scale, own || filled(above, col))
			}

			if (!sameMerge(merge, row, left)) {
				const line = strongerLine(styleOf(row, left).right, style.left)

				if (line !== undefined) borders.edge(line, false, x - 0.5, y - 1, y + height, scale, own || filled(row, left))
			}

			if (row === lastRow && below >= 0 && !sameMerge(merge, below, col)) {
				const line = strongerLine(style.bottom, styleOf(below, col).top)

				if (line !== undefined) borders.edge(line, true, y + height - 0.5, x - 1, x + width, scale, own || filled(below, col))
			}

			if (col === lastCol && afterCols >= 0) {
				const right = afterCols

				if (!sameMerge(merge, row, right)) {
					const line = strongerLine(style.right, styleOf(row, right).left)

					if (line !== undefined) borders.edge(line, false, x + width - 0.5, y - 1, y + height, scale, own || filled(row, right))
				}
			}

			if (merge === null) diagonals(borders, style, { x, y, width, height }, scale, scene.layout.rightToLeft)
		})
	})

	for (const { merge, box } of blocks) diagonals(borders, styleOf(merge.startRow, merge.startCol), box, scale, scene.layout.rightToLeft)
}

function hasFill(style: SheetRenderStyle): boolean {
	return style.fill !== undefined || style.pattern !== undefined
}

// Mirrored, a line laid out going down shows going up.
function diagonals(borders: BorderPainter, style: SheetRenderStyle, box: Box, scale: number, mirrored: boolean): void {
	const up: SheetBorderLine | undefined = mirrored ? style.diagonalDown : style.diagonalUp
	const down: SheetBorderLine | undefined = mirrored ? style.diagonalUp : style.diagonalDown
	const onFill = hasFill(style)

	if (up !== undefined) borders.diagonal(up, "up", box.x, box.y, box.width - 1, box.height - 1, scale, onFill)
	if (down !== undefined) borders.diagonal(down, "down", box.x, box.y, box.width - 1, box.height - 1, scale, onFill)
}

// --- Text ---

type Align = "left" | "center" | "right" | "fill"

interface CellText {
	readonly text: string
	readonly runs: TextRun[] | null
	readonly style: SheetRenderStyle
	readonly flags: number
	readonly repeat: { readonly offset: number; readonly char: string } | null
	readonly align: Align
	readonly wrap: boolean
	readonly pending: boolean
	// Where the text came from, for what only a cell too narrow for it needs (its General value).
	readonly tile: SheetTile | null
	readonly entry: number
	readonly row: number
	readonly col: number
}

// General numbers the last frame drew rounded to fit their cell, by grid and "sheet:row:col".
const roundedTexts = new WeakMap<SheetGridModel, Map<string, string>>()

// What the last frame drew for a General number it rounded to fit its cell (Excel's Increase Decimal starts from
// it), or undefined when it drew the number whole or not at all.
export function roundedGeneral(model: SheetGridModel, sheet: SheetId, row: number, col: number): string | undefined {
	return roundedTexts.get(model)?.get(`${String(sheet)}:${String(row)}:${String(col)}`)
}

type GeneralLayer = NonNullable<NonNullable<SheetTile["layers"]>["general"]>

// Each "general" layer's rows by entry, built when a cell of its tile first does not fit.
const generalRows = new WeakMap<GeneralLayer, Map<number, number>>()

// The value of an entry shown in plain General (the tile's "general" layer), or null.
function generalValue(tile: SheetTile | null, entry: number): { value: number; decimal: string } | null {
	const layer = tile?.layers?.general

	if (layer === undefined) return null

	let rows = generalRows.get(layer)

	if (rows === undefined) {
		rows = new Map()

		for (let i = 0; i < layer.entries.length; i++) rows.set(layer.entries[i] ?? -1, i)

		generalRows.set(layer, rows)
	}

	const row = rows.get(entry)

	return row === undefined ? null : { value: layer.values[row] ?? 0, decimal: layer.decimal }
}

// Letters of the right-to-left scripts.
const RTL_LETTER =
	/[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u
const LETTER = /\p{L}/u

// Whether text reads right to left: its reading order, else its first letter's script (the "context" order).
function readsRightToLeft(style: SheetRenderStyle, text: string): boolean {
	if (style.rightToLeft === true) return true

	const letter = LETTER.exec(text)

	return letter !== null && RTL_LETTER.test(letter[0])
}

// The side as laid out: the screen's left is the layout's right in a mirrored sheet.
function side(screen: "left" | "right", mirrored: boolean): Align {
	return mirrored ? (screen === "left" ? "right" : "left") : screen
}

function horizontal(style: SheetRenderStyle, flags: number, pending: boolean, text: string, mirrored: boolean): Align {
	switch (style.align) {
		case "left":
		case "right":
			return side(style.align, mirrored)
		case "center":
		case "fill":
			return style.align
		case "centerContinuous":
		case "distributed":
			return "center"
		case "justify":
		case undefined:
			break
	}

	// General: numbers right, logical values and errors centred, text left (Excel's "General" alignment); text that
	// reads right to left starts at the right.
	if (style.align === undefined) {
		if (pending ? /^[-+]?[\d.,]+%?$/u.test(text.trim()) : (flags & CellFlag.NUMBER) !== 0) return side("right", mirrored)
		if (!pending && (flags & (CellFlag.BOOLEAN | CellFlag.ERROR)) !== 0) return "center"
	}

	return side(readsRightToLeft(style, text) ? "right" : "left", mirrored)
}

function cellText(scene: CellScene, lookup: Lookup, row: number, col: number): CellText | null {
	const { model, sheet } = scene
	const pending = model.pendingText(sheet, row, col)
	const found = model.entry(sheet, row, col)
	const style = model.style(lookup.styleIndex(row, col))

	if (pending !== undefined) {
		if (pending === "") return null

		return {
			text: pending,
			runs: null,
			style,
			flags: 0,
			repeat: null,
			align: horizontal(style, 0, true, pending, scene.layout.rightToLeft),
			wrap: style.wrap === true,
			pending: true,
			tile: null,
			entry: -1,
			row,
			col
		}
	}

	if (found === null) return null

	// Ctrl+`: a formula shows as typed, as text (aligned, running on and never "#" as text is).
	if (showsFormula(scene, found.tile, found.entry)) {
		const input = entryInput(found.tile, found.entry)

		if (input === "") return null

		const flags =
			(found.tile.flags[found.entry] ?? 0) & ~(CellFlag.NUMBER | CellFlag.BOOLEAN | CellFlag.ERROR | CellFlag.RICH | CellFlag.REPEAT)

		return {
			text: input,
			runs: null,
			style,
			flags,
			repeat: null,
			align: horizontal(style, flags, false, input, scene.layout.rightToLeft),
			wrap: style.wrap === true,
			pending: false,
			tile: null,
			entry: -1,
			row,
			col
		}
	}

	const text = entryText(found.tile, found.entry)

	if (text === "") return null

	const flags = found.tile.flags[found.entry] ?? 0
	const raw = (flags & CellFlag.RICH) !== 0 ? entryRuns(found.tile, found.entry) : null
	const runs: TextRun[] | null = raw === null ? null : []

	for (let i = 0; raw !== null && runs !== null && i + 1 < raw.length; i += 2)
		runs.push({ start: raw[i] ?? 0, style: model.style(raw[i + 1] ?? 0) })

	return {
		text,
		runs,
		style,
		flags,
		repeat: (flags & CellFlag.REPEAT) !== 0 ? entryRepeat(found.tile, found.entry) : null,
		align: horizontal(style, flags, false, text, scene.layout.rightToLeft),
		wrap: style.wrap === true || style.align === "justify" || style.align === "distributed",
		pending: false,
		tile: found.tile,
		entry: found.entry,
		row,
		col
	}
}

// The single cells of a row whose text is drawn over the pane: one left of the drawn columns whose text runs on into
// them, the drawn ones (merged cells aside), and one right of them whose right-aligned text runs back.
function textCells(
	scene: CellScene,
	lookup: Lookup,
	row: number,
	colList: readonly number[],
	colX: readonly number[],
	cols: GridSegment,
	visit: (col: number, knownX: number | undefined) => void
): void {
	const colAxis = scene.view.cols.axis

	for (let col = cols.first - 1; col >= Math.max(0, cols.first - CARRY_COLUMNS); col--) {
		if (lookup.merge(row, col) !== null) break
		if (colAxis.size(col) === 0 || lookup.text(row, col) === "") continue

		visit(col, undefined)
		break
	}

	colList.forEach((col, j) => {
		if (lookup.merges.length > 0 && lookup.merge(row, col) !== null) return
		if (lookup.text(row, col) === "") return

		visit(col, colX[j])
	})

	for (let col = cols.last + 1; col <= Math.min(colAxis.lastShown, cols.last + CARRY_COLUMNS); col++) {
		if (lookup.merge(row, col) !== null) break
		if (colAxis.size(col) === 0 || lookup.text(row, col) === "") continue

		visit(col, undefined)
		break
	}
}

interface RunOn {
	readonly content: CellText
	readonly x: number
	readonly width: number
	readonly left: number
	readonly right: number
}

// A single cell's text with its run-on: left-aligned text continues over empty cells to its right, right-aligned
// to its left, centred both ways, as far as the next cell with content (Excel's overflow). Null when nothing shows.
// A hidden run longer than CARRY_COLUMNS stops it: the frame only fetches that much of a hidden run (frameTiles), so
// the answer never depends on what the tile cache happens to hold, and print draws the same.
function runOn(scene: CellScene, lookup: Lookup, row: number, col: number, cols: GridSegment, knownX?: number): RunOn | null {
	const colAxis = scene.view.cols.axis
	const x = knownX ?? screenOf(scene.view.cols, col)
	const width = colAxis.size(col)
	const content = cellText(scene, lookup, row, col)

	if (content === null || width === 0) return null

	const runs = !content.wrap && content.align !== "fill" && (content.style.rotation ?? 0) === 0 && content.style.shrink !== true
	let left = x
	let right = x + width

	if (runs && (content.flags & CellFlag.NUMBER) === 0) {
		if (content.align === "left" || content.align === "center") {
			for (let next = col + 1, hidden = 0; next <= colAxis.lastShown && right < cols.end; next++) {
				const size = colAxis.size(next)

				hidden = size === 0 ? hidden + 1 : 0

				if (hidden > CARRY_COLUMNS || lookup.occupied(row, next)) break

				right += size
			}
		}

		if (content.align === "right" || content.align === "center") {
			for (let before = col - 1, hidden = 0; before >= 0 && left > cols.start; before--) {
				const size = colAxis.size(before)

				hidden = size === 0 ? hidden + 1 : 0

				if (hidden > CARRY_COLUMNS || lookup.occupied(row, before)) break

				left -= size
			}
		}
	}

	if (right <= cols.start || left >= cols.end) return null

	return { content, x, width, left, right }
}

// The vertical gridlines text running on crosses, by their x, with the rows it crosses them in. Only cells whose
// run-on reaches past their own box are measured (one line: text that runs on never wraps); their layouts are kept in
// LAID_OUT for the text pass. The map, its sets and the edges are reused from frame to frame.
const COVERED = new Map<number, Set<number>>()
const SPARE_ROWS: Set<number>[] = []
const EDGES: number[] = []
// One pane's run-on texts laid out by the gridline pass, by row * SHEET_MAX_COLS + col.
const LAID_OUT = new Map<number, { readonly run: RunOn; readonly line: TextLine | undefined }>()

function runOnCover(
	painters: CellPainters,
	scene: CellScene,
	lookup: Lookup,
	rowList: readonly number[],
	colList: readonly number[],
	colX: readonly number[],
	cols: GridSegment
): ReadonlyMap<number, ReadonlySet<number>> {
	const covered = COVERED
	const { measurer } = painters
	const { scale, theme, model } = scene
	const base = model.style(0)
	const padding = Math.max(1, Math.round(TEXT_PADDING * scale))
	const edges = EDGES

	for (const rows of covered.values()) {
		rows.clear()
		SPARE_ROWS.push(rows)
	}

	covered.clear()
	edges.length = 0
	colList.forEach((col, j) => edges.push((colX[j] ?? 0) + scene.view.cols.axis.size(col) - 1))

	for (const row of rowList) {
		textCells(scene, lookup, row, colList, colX, cols, (col, knownX) => {
			// Most text has neighbours with content on both sides: nothing of it runs on.
			if (lookup.occupied(row, col + 1) && (col === 0 || lookup.occupied(row, col - 1))) return

			const run = runOn(scene, lookup, row, col, cols, knownX)

			if (run === null || (run.left === run.x && run.right === run.x + run.width)) return

			const { content } = run
			const font = textFont(content.style, base, theme.font, scale)
			const indent = (content.style.indent ?? 0) > 0 ? (content.style.indent ?? 0) * measurer.width(font.css, "   ") : 0
			const [line] = layoutText(measurer, content.text, content.runs, content.style, {
				wrap: false,
				width: Number.POSITIVE_INFINITY,
				base,
				fallback: theme.font,
				scale
			})

			LAID_OUT.set(row * SHEET_MAX_COLS + col, { run, line })

			const textWidth = line?.width ?? 0
			const start =
				content.align === "right"
					? run.x + run.width - 1 - padding - indent - textWidth
					: content.align === "center"
						? run.x + (run.width - 1 - textWidth) / 2
						: run.x + padding + indent
			const end = start + textWidth

			for (const edge of edges) {
				if (edge <= start || edge >= end || edge < run.left || edge >= run.right - 1) continue

				let rows = covered.get(edge)

				if (rows === undefined) {
					rows = SPARE_ROWS.pop() ?? new Set()
					covered.set(edge, rows)
				}

				rows.add(row)
			}
		})
	}

	return covered
}

function paintText(
	painters: CellPainters,
	scene: CellScene,
	lookup: Lookup,
	row: number,
	col: number,
	box: Box,
	left: number,
	right: number
): void {
	const content = cellText(scene, lookup, row, col)

	if (content !== null) drawText(painters, scene, content, box, left, right)
}

function lineHeight(px: number): number {
	return Math.round(px * LINE_HEIGHT)
}

// Draws a cell's text in `box`, clipped to left..right (its run-on) and the box's height.
// `laid`: the text's one line as the gridline pass laid it out (it runs on, so it neither wraps nor rotates).
function drawText(
	painters: CellPainters,
	scene: CellScene,
	content: CellText,
	cellBox: Box,
	cellLeft: number,
	right: number,
	laid?: TextLine
): void {
	painters.textCell?.(content.row, content.col)
	drawCellText(painters, scene, content, cellBox, cellLeft, right, laid)
	painters.textCell?.(-1, -1)
}

function drawCellText(
	painters: CellPainters,
	scene: CellScene,
	content: CellText,
	cellBox: Box,
	cellLeft: number,
	right: number,
	laid?: TextLine
): void {
	const { canvas, measurer } = painters
	const leading = scene.inset === undefined || content.pending ? 0 : Math.min(cellBox.width, scene.inset(content.flags) * scene.scale)
	const box = leading === 0 ? cellBox : { ...cellBox, x: cellBox.x + leading, width: cellBox.width - leading }
	const left = cellLeft === cellBox.x ? box.x : cellLeft
	const { scale, theme, model } = scene
	const style = content.style
	const base = model.style(0)
	const padding = Math.max(1, Math.round(TEXT_PADDING * scale))
	const font = textFont(style, base, theme.font, scale)
	const indent = (style.indent ?? 0) > 0 ? (style.indent ?? 0) * measurer.width(font.css, "   ") : 0
	const avail = Math.max(0, box.width - 2 * padding - indent - 1)
	const onFill = hasFill(style)
	const color = (value: number | undefined): string => ink(value, onFill, theme)
	let text = content.text
	let runs = content.runs

	// "*x": the character repeated across what the rest leaves of the cell's width.
	if (content.repeat !== null && content.repeat.char !== "") {
		const before = text.slice(0, content.repeat.offset)
		const after = text.slice(content.repeat.offset)
		const charWidth = measurer.width(font.css, content.repeat.char)
		const room = avail - measurer.width(font.css, before + after)
		const count = charWidth > 0 ? Math.max(0, Math.floor(room / charWidth)) : 0

		text = before + content.repeat.char.repeat(Math.min(count, 4096)) + after
		runs = null
	}

	const rotation = style.rotation ?? 0
	const options = { wrap: content.wrap && rotation === 0, width: avail, base, fallback: theme.font, scale }
	let lines: TextLine[]

	if (laid !== undefined && rotation === 0 && !options.wrap && content.repeat === null) {
		lines = [laid]
	} else if (rotation === 255) {
		lines = [...text.replace(/\r?\n|\r/gu, "")].map(
			char => layoutText(measurer, char, null, style, { ...options, wrap: false })[0] as TextLine
		)
	} else {
		lines = layoutText(measurer, text, runs, style, options)
	}

	const widest = lines.reduce((most, line) => Math.max(most, line.width), 0)
	let shrink = 1

	if (content.align === "fill" && lines.length === 1 && widest > 0 && widest < avail) {
		// "Fill" alignment repeats the whole text across the cell.
		const copies = Math.max(1, Math.floor(avail / widest))

		lines = layoutText(measurer, text.repeat(Math.min(copies, 1024)), null, style, { ...options, wrap: false })
	} else if ((content.flags & CellFlag.NUMBER) !== 0 && !content.wrap && rotation === 0 && widest > avail && !content.pending) {
		// A number too wide for its cell: General rounds it to fit, as Excel does; anything else, or a General number
		// nothing fits, shows as "#" across the cell (Excel never cuts a number).
		const general = generalValue(content.tile, content.entry)
		const fitted =
			general === null ? null : fitGeneral(general.value, general.decimal, candidate => measurer.width(font.css, candidate) <= avail)
		const hashWidth = measurer.width(font.css, "#")
		const count = hashWidth > 0 ? Math.max(1, Math.floor(avail / hashWidth)) : 1

		if (fitted !== null) {
			let rounded = roundedTexts.get(scene.model)

			if (rounded === undefined) {
				rounded = new Map()
				roundedTexts.set(scene.model, rounded)
			}

			rounded.set(`${String(scene.sheet)}:${String(content.row)}:${String(content.col)}`, fitted)
		}

		lines = layoutText(measurer, fitted ?? "#".repeat(Math.min(count, 4096)), null, style, { ...options, wrap: false })
	} else if (style.shrink === true && !content.wrap && rotation === 0 && widest > avail && widest > 0) {
		shrink = Math.max(0.25, avail / widest)
	}

	const heights = lines.map(line => lineHeight(line.px * shrink))
	const block = heights.reduce((sum, value) => sum + value, 0)
	const fits =
		left === box.x &&
		right === box.x + box.width &&
		lines.length === 1 &&
		rotation === 0 &&
		widest * shrink <= avail &&
		block <= box.height

	if (!fits) {
		canvas.save()
		canvas.beginPath()
		canvas.rect(left, box.y, right - left, box.height)
		canvas.clip()
	}

	if (scene.layout.rightToLeft) physical(canvas, scene)

	if (rotation !== 0 && rotation !== 255) {
		drawRotated(painters, scene, lines[0], style, content.align, box, padding, rotation, color)
	} else {
		const valign = style.valign ?? "bottom"
		let top =
			valign === "top"
				? box.y + padding
				: valign === "center" || rotation === 255
					? box.y + (box.height - block) / 2
					: box.y + box.height - padding - block

		if (valign === "bottom" && rotation !== 255) top = Math.max(top, box.y + Math.min(padding, Math.max(0, box.height - block)))

		lines.forEach((line, k) => {
			const lineWidth = line.width * shrink
			const align = rotation === 255 ? "center" : content.align
			const x =
				align === "right"
					? box.x + box.width - 1 - padding - indent - lineWidth
					: align === "center"
						? box.x + (box.width - 1 - lineWidth) / 2
						: box.x + padding + indent
			const height = heights[k] ?? 0
			const baseline = top + height - (height - line.px * shrink) / 2 - line.px * shrink * DESCENT

			drawLine(painters, line, screenX(scene, x, lineWidth), baseline, shrink, color)
			top += height
		})
	}

	if (scene.layout.rightToLeft) logical(canvas, scene)

	if (!fits) restore(painters)
}

function drawLine(
	painters: CellPainters,
	line: TextLine,
	x: number,
	baseline: number,
	shrink: number,
	color: (value: number | undefined) => string
): void {
	const { canvas, measurer } = painters
	let at = x

	canvas.textAlign = "left"
	canvas.textBaseline = "alphabetic"

	for (const fragment of line.fragments) {
		const px = fragment.font.px * shrink
		const css = shrink === 1 ? fragment.font.css : fragment.font.css.replace(`${String(fragment.font.px)}px`, `${String(px)}px`)
		const shift = fragment.style.script === "superscript" ? -px * 0.55 : fragment.style.script === "subscript" ? px * 0.25 : 0
		const fill = color(fragment.style.color)
		const width = fragment.width * shrink

		measurer.use(css)
		canvas.fillStyle = fill
		canvas.fillText(fragment.text, at, baseline + shift)

		const underline = fragment.style.underline

		if (underline !== undefined) {
			const thickness = Math.max(1, Math.round(px / 14))

			canvas.fillRect(at, baseline + shift + thickness + 1, width, thickness)

			if (underline === "double" || underline === "doubleAccounting")
				canvas.fillRect(at, baseline + shift + 3 * thickness + 1, width, thickness)
		}

		if (fragment.style.strike === true) canvas.fillRect(at, baseline + shift - px * 0.3, width, Math.max(1, Math.round(px / 14)))

		at += width
	}
}

// Text turned by `degrees` (counter-clockwise): its turned box is placed in the cell as the alignment says.
function drawRotated(
	painters: CellPainters,
	scene: CellScene,
	line: TextLine | undefined,
	style: SheetRenderStyle,
	align: Align,
	box: Box,
	padding: number,
	degrees: number,
	color: (value: number | undefined) => string
): void {
	if (line === undefined) return

	const { canvas } = painters
	const radians = (degrees * Math.PI) / 180
	const height = lineHeight(line.px)
	const turnedWidth = Math.abs(line.width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))
	const turnedHeight = Math.abs(line.width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))
	const valign = style.valign ?? "bottom"
	const cx =
		align === "right"
			? box.x + box.width - padding - turnedWidth / 2
			: align === "center"
				? box.x + box.width / 2
				: box.x + padding + turnedWidth / 2
	const cy =
		valign === "top"
			? box.y + padding + turnedHeight / 2
			: valign === "center"
				? box.y + box.height / 2
				: box.y + box.height - padding - turnedHeight / 2

	canvas.save()
	canvas.translate(screenX(scene, cx, 0), cy)
	canvas.rotate(-radians)
	drawLine(painters, line, -line.width / 2, line.px * (0.5 - DESCENT), 1, color)
	restore(painters)
}
