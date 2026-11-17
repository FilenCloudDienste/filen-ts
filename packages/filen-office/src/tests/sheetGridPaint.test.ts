import { describe, expect, it } from "vitest"
import { CellFlag, type SheetLayout } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { paintChrome } from "../react/sheet/paint/chrome"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { addSelection, cellSelection, extendSelection } from "../react/sheet/selection"
import { DEFAULT_THEME, type SheetGridTheme } from "../react/sheet/theme"
import { gridView, screenOf, type GridView } from "../react/sheet/view"
import { RecordingCanvas, type DrawCall } from "./sheetGridCanvas"
import { SML, buildFixture, openFixture } from "./sheetSessionFixtures"

// What the cells layer draws for a workbook's formats: fills and patterns, borders by precedence and diagonals,
// aligned, wrapped, turned and rich text, the number format's repeat fill, "#" for a number too wide, merged blocks
// and text running on into empty neighbours; and what the chrome layer draws for a selection.

const STYLES =
	'<numFmts count="1"><numFmt numFmtId="164" formatCode="0*-"/></numFmts>' +
	'<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>' +
	'<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
	'<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>' +
	'<fill><patternFill patternType="darkDown"><fgColor rgb="FF0000FF"/><bgColor rgb="FFFFFFFF"/></patternFill></fill></fills>' +
	'<borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border>' +
	'<border><left/><right style="thin"><color rgb="FF000000"/></right><top/><bottom/><diagonal/></border>' +
	'<border><left style="thick"><color rgb="FF0000FF"/></left><right/><top/><bottom/><diagonal/></border>' +
	'<border diagonalUp="1" diagonalDown="1"><left/><right/><top/><bottom/><diagonal style="double"><color rgb="FF00FF00"/></diagonal></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="11">' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="3" xfId="0" applyBorder="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment textRotation="45"/></xf>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>' +
	'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>' +
	'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
	"</cellXfs>" +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'

const STRINGS = [
	"fill",
	"diag",
	"alpha beta gamma delta epsilon zeta eta theta",
	"turned",
	"pat",
	null,
	"merged",
	"a long text that runs on",
	"stop",
	"red"
]

const SHARED =
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${SML}" count="10" uniqueCount="10">` +
	STRINGS.map(entry =>
		entry === null
			? '<si><r><t xml:space="preserve">plain </t></r><r><rPr><b/><sz val="11"/><color rgb="FF00AA00"/><rFont val="Arial"/></rPr><t>bold</t></r></si>'
			: `<si><t>${entry}</t></si>`
	).join("") +
	"</sst>"

const BODY =
	'<cols><col min="3" max="3" width="5" customWidth="1"/></cols><sheetData>' +
	'<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="2"><v>1</v></c><c r="C1" s="3"><v>2</v></c></row>' +
	'<row r="2"><c r="A2" s="4" t="s"><v>1</v></c><c r="B2" s="5" t="s"><v>2</v></c><c r="C2" s="6" t="s"><v>3</v></c></row>' +
	'<row r="3"><c r="A3" s="8"><v>5</v></c><c r="B3" s="9" t="s"><v>4</v></c><c r="C3"><v>123456789012</v></c></row>' +
	'<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4" s="10" t="s"><v>9</v></c></row>' +
	'<row r="5"><c r="A5" s="7" t="s"><v>6</v></c></row>' +
	'<row r="7"><c r="A7" t="s"><v>7</v></c><c r="C7" t="s"><v>8</v></c></row>' +
	'</sheetData><mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells>'

async function painted(
	theme: SheetGridTheme = DEFAULT_THEME
): Promise<{ canvas: RecordingCanvas; view: GridView; model: SheetGridModel; layout: SheetLayout }> {
	const { session, info } = await openFixture(
		buildFixture({ sheets: [{ name: "S", body: BODY }], sharedStrings: SHARED, styles: STYLES })
	)
	const model = new SheetGridModel({ source: session, edit: session, info })
	const sheet = info.activeSheet

	model.need(sheet, [0, 0])

	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 400)
	const canvas = new RecordingCanvas()

	paintCells(
		{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
		{ model, sheet, layout, view, theme, scale: 1, pixelRatio: 1 }
	)

	return { canvas, view, model, layout }
}

function box(view: GridView, row: number, col: number): { x: number; y: number; width: number; height: number } {
	return { x: screenOf(view.cols, col), y: screenOf(view.rows, row), width: view.cols.axis.size(col), height: view.rows.axis.size(row) }
}

function textCall(canvas: RecordingCanvas, text: string): DrawCall | undefined {
	return canvas.calls.find(call => call.op === "fillText" && call.args[0] === text)
}

describe("grid painting", () => {
	it("fills cells with their colour and patterns with the mix of theirs when no swatch canvas exists", async () => {
		const { canvas, view } = await painted()
		const a1 = box(view, 0, 0)
		const b3 = box(view, 2, 1)

		expect(canvas.calls).toContainEqual(
			expect.objectContaining({ op: "fillRect", args: [a1.x, a1.y, a1.width, a1.height], fill: "#ffff00" })
		)
		// darkDown sets half the swatch: blue and white half and half.
		expect(canvas.calls).toContainEqual(
			expect.objectContaining({ op: "fillRect", args: [b3.x, b3.y, b3.width, b3.height], fill: "#8080ff" })
		)
	})

	it("draws the heavier line where two cells' borders meet, once, and both diagonals doubled", async () => {
		const { canvas, view } = await painted()
		const c1 = box(view, 0, 2)
		const shared = canvas.calls.filter(call => call.op === "moveTo" && call.args[0] === c1.x - 0.5 && call.args[1] === c1.y - 1)
		const strokes = canvas.calls.filter(call => call.op === "stroke")

		// B1's thin right edge meets C1's thick left edge: the thick one (3 px, blue) is drawn at that gridline.
		expect(strokes.some(call => call.lineWidth === 3 && call.stroke === "#0000ff")).toBe(true)
		expect(strokes.some(call => call.lineWidth === 1 && call.stroke === "#000000")).toBe(false)
		expect(shared.length).toBe(1)

		const a2 = box(view, 1, 0)
		const diagonals = canvas.calls.filter(
			call => call.op === "lineTo" && call.args[1] === a2.y && call.args[0] === a2.x + a2.width - 1 + 1
		)

		// A double diagonal is two strokes (one per side of the line), both directions.
		expect(strokes.filter(call => call.stroke === "#00ff00").length).toBe(4)
		expect(diagonals.length).toBe(1)
	})

	it("wraps, turns and colours text as its format says", async () => {
		const { canvas } = await painted()
		const texts = canvas.texts()

		// Wrapped at B's width: more than one line, no word cut.
		expect(texts.filter(text => /alpha|beta|gamma|zeta|theta/u.test(text)).length).toBeGreaterThan(1)
		expect(texts.every(text => !/^(lpha|amma|psilon|heta)/u.test(text))).toBe(true)
		expect(canvas.calls.some(call => call.op === "rotate" && Math.abs((call.args[0] as number) + Math.PI / 4) < 1e-9)).toBe(true)
		expect(textCall(canvas, "turned")).toBeDefined()
		expect(textCall(canvas, "red")).toMatchObject({ fill: "#ff0000", font: expect.stringContaining("bold") })
	})

	it("draws rich text run by run in each run's own font and colour", async () => {
		const { model, layout, view } = await painted()
		const sheet = layout.sheet
		const found = model.entry(sheet, 3, 0)

		if (found === null) throw new Error("no A4")

		const { tile, entry } = found
		const flags = Uint32Array.from(tile.flags)

		flags[entry] = (flags[entry] ?? 0) | CellFlag.RICH
		model.apply({
			state: { version: tile.version + 1, dirty: false, canUndo: false, canRedo: false },
			patches: [
				{
					...tile,
					version: tile.version + 1,
					flags,
					layers: {
						...tile.layers,
						runs: {
							runEntries: Uint16Array.of(entry, entry),
							runStarts: Uint32Array.of(0, 6),
							runStyles: Uint32Array.of(0, 11)
						}
					},
					mode: "replace"
				}
			],
			invalidated: [],
			layouts: [],
			styles: { from: 11, styles: [{ font: "Arial", size: 11, bold: true, color: 0x00aa00 }] }
		})

		const canvas = new RecordingCanvas()
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		paintCells(
			{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
			{ model, sheet, layout: model.layout(sheet) as SheetLayout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }
		)

		const plain = textCall(canvas, "plain ")
		const bold = textCall(canvas, "bold")

		expect(plain?.font).not.toContain("bold")
		expect(bold).toMatchObject({ fill: "#00aa00", font: expect.stringContaining('bold 14.67px "Arial"') })
		expect(bold?.args[1]).toBeCloseTo((plain?.args[1] as number) + 6 * 14.67 * 0.55, 5)
	})

	it("repeats a format's fill character across the cell and shows a number too wide as #", async () => {
		const { canvas, view } = await painted()
		const repeated = canvas.texts().find(text => text.startsWith("5-"))
		const hashes = canvas.texts().find(text => /^#+$/u.test(text))

		expect(repeated).toBeDefined()
		// Filled to the cell's width less its padding: 64 - 2 * 3 - 1 = 57 px at 8.07 px a character.
		expect(repeated?.length).toBe(Math.floor(57 / (14.67 * 0.55)))
		expect(hashes).toBeDefined()
		expect((hashes?.length ?? 0) * 14.67 * 0.55).toBeLessThanOrEqual(view.cols.axis.size(2))
	})

	it("draws a merge as one block with its text centred across it, and runs text on to the next cell with content", async () => {
		const { canvas, view } = await painted()
		const a5 = box(view, 4, 0)
		const width = view.cols.axis.size(0) + view.cols.axis.size(1) + view.cols.axis.size(2)
		const merged = textCall(canvas, "merged")
		const textWidth = 6 * 14.67 * 0.55

		expect(merged?.args[1]).toBeCloseTo(a5.x + (width - 1 - textWidth) / 2, 5)

		const a7 = box(view, 6, 0)
		const runOn = canvas.calls.find(call => call.op === "rect" && call.args[0] === a7.x && call.args[1] === a7.y)

		// Clipped at C7, which holds text: A's and B's widths.
		expect(runOn?.args[2]).toBe(view.cols.axis.size(0) + view.cols.axis.size(1))
	})

	it("keeps frozen rows and columns in place while the rest scrolls", async () => {
		const rows = Array.from(
			{ length: 60 },
			(_, k) =>
				`<row r="${String(k + 1)}"><c r="A${String(k + 1)}"><v>${String(k + 1)}</v></c><c r="B${String(k + 1)}"><v>${String(1000 + k + 1)}</v></c></row>`
		).join("")
		const { session, info } = await openFixture(
			buildFixture({
				sheets: [
					{
						name: "F",
						body:
							'<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' +
							`<sheetData>${rows}</sheetData>`
					}
				]
			})
		)
		const model = new SheetGridModel({ source: session, edit: session, info })
		const sheet = info.activeSheet

		model.need(sheet, [0, 0])

		for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const layout = model.layout(sheet) as SheetLayout
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		expect(layout.pane).toMatchObject({ rows: 1, cols: 1 })

		// Scrolled 20 rows down: row 1 and column A stay, row 22 is the first scrolled row.
		const view = gridView(axes, layout, { top: 20 * 20, left: 0 }, 900, 400)
		const canvas = new RecordingCanvas()

		paintCells(
			{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
			{ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }
		)

		expect(view.rows.first).toBe(21)
		expect(textCall(canvas, "1")?.args[2]).toBeLessThan(view.rows.header + 20)
		expect(textCall(canvas, "1001")?.args[2]).toBeLessThan(view.rows.header + 20)
		expect(textCall(canvas, "22")?.args[2]).toBeGreaterThan(view.rows.header + 20)
		expect(textCall(canvas, "22")?.args[2]).toBeLessThan(view.rows.header + 40)
		expect(textCall(canvas, "5")).toBeUndefined()
		expect(screenOf(view.rows, 21)).toBe(view.rows.header + 20)
	})

	it("draws unformatted cells in the theme's colours and keeps the file's fills, colours and text on fills", async () => {
		const dark: SheetGridTheme = { ...DEFAULT_THEME, background: "#1e1e1e", text: "#e6e6e6", gridLine: "#3a3a3a", border: "#9a9a9a" }
		const { canvas } = await painted(dark)

		expect(canvas.calls[0]).toMatchObject({ op: "fillRect", fill: "#1e1e1e" })
		expect(canvas.calls.some(call => call.op === "fillRect" && call.fill === "#3a3a3a")).toBe(true)
		// Automatic text on no fill follows the theme; on the file's yellow fill it stays dark; red stays red.
		expect(textCall(canvas, "turned")?.fill).toBe("#e6e6e6")
		expect(textCall(canvas, "fill")?.fill).toBe("#000000")
		expect(textCall(canvas, "red")?.fill).toBe("#ff0000")
		// C1's blue border stays blue; an automatic (black) one takes the theme's border colour.
		expect(canvas.calls.some(call => call.op === "stroke" && call.stroke === "#0000ff")).toBe(true)

		const lines = new RecordingCanvas()
		const borders = new BorderPainter(lines)

		borders.reset(dark.border)
		borders.edge({ style: "thin", color: 0x000000 }, true, 10.5, 0, 50, 1)
		borders.edge({ style: "thin", color: 0x00ff00 }, true, 20.5, 0, 50, 1)

		expect(lines.calls.filter(call => call.op === "stroke").map(call => call.stroke)).toEqual(["#9a9a9a", "#00ff00"])
	})

	it("draws automatic borders next to a fill black, as on paper, and the theme's colour between unfilled cells", async () => {
		const styles =
			'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
			'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
			'<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill></fills>' +
			'<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
			'<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
			'<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>' +
			'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			'<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
			'<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>' +
			'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs>' +
			'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
		const body = '<sheetData><row r="2"><c r="B2" s="1"><v>1</v></c></row><row r="4"><c r="B4" s="2"><v>2</v></c></row></sheetData>'
		const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "S", body }], styles }))
		const model = new SheetGridModel({ source: session, edit: session, info })
		const sheet = info.activeSheet

		model.need(sheet, [0, 0])

		for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const layout = model.layout(sheet) as SheetLayout
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 400)
		const canvas = new RecordingCanvas()
		const dark: SheetGridTheme = { ...DEFAULT_THEME, background: "#1e1e1e", border: "#fafafa" }

		paintCells(
			{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
			{ model, sheet, layout, view, theme: dark, scale: 1, pixelRatio: 1 }
		)

		const top = (row: number): unknown => {
			const cell = box(view, row, 1)

			return canvas.calls.find(call => call.op === "moveTo" && call.args[0] === cell.x - 1 && call.args[1] === cell.y - 0.5)?.stroke
		}
		const right = (row: number): unknown => {
			const cell = box(view, row, 1)

			return canvas.calls.find(
				call => call.op === "moveTo" && call.args[0] === cell.x + cell.width - 0.5 && call.args[1] === cell.y - 1
			)?.stroke
		}

		// B2 is filled white: its lines, the one it shares with its unfilled neighbour C2 too, are black.
		expect(top(1)).toBe("#000000")
		expect(right(1)).toBe("#000000")
		// B4 has no fill: its automatic lines follow the theme.
		expect(top(3)).toBe("#fafafa")
		expect(right(3)).toBe("#fafafa")
	})

	it("rings every outline of the selection with a halo inside it, drawn before the lines", async () => {
		const { view, model, layout } = await painted()
		const merges = model.merges(layout)
		const outlined = (selection: ReturnType<typeof cellSelection>): DrawCall[] => {
			const canvas = new RecordingCanvas()

			paintChrome(canvas, { view, theme: DEFAULT_THEME, pixelRatio: 1, selection, merges, guide: null })

			return canvas.calls.filter(
				call => call.op === "fillRect" && (call.fill === DEFAULT_THEME.selectionLine || call.fill === DEFAULT_THEME.selectionHalo)
			)
		}

		// One cell: a 2 px line on its left and top gridlines and in, the halo the pixel inside it.
		const c1 = box(view, 0, 2)
		const single = outlined(cellSelection({ row: 0, col: 2 }, merges))

		expect(single.map(call => call.fill)).toEqual([
			...Array<string>(4).fill(DEFAULT_THEME.selectionHalo),
			...Array<string>(4).fill(DEFAULT_THEME.selectionLine)
		])
		expect(single[0]?.args).toEqual([c1.x + 1, c1.y + 1, c1.width - 3, 1])
		expect(single[4]?.args).toEqual([c1.x - 1, c1.y - 1, c1.width + 1, 2])

		// A range: its outline, and the active cell's 1 px one inside it.
		const range = outlined(extendSelection(cellSelection({ row: 0, col: 2 }, merges), { row: 1, col: 3 }, merges))

		expect(range.filter(call => call.fill === DEFAULT_THEME.selectionHalo)).toHaveLength(8)
		expect(range.filter(call => call.fill === DEFAULT_THEME.selectionLine)).toHaveLength(8)
		expect(range.findIndex(call => call.fill === DEFAULT_THEME.selectionLine)).toBe(8)
		expect(range).toContainEqual(
			expect.objectContaining({ args: [c1.x - 1, c1.y - 1, c1.width + 1, 1], fill: DEFAULT_THEME.selectionLine })
		)
	})

	it("tints the selection but its active cell, outlines the last range, and marks its headers", async () => {
		const { view, model, layout } = await painted()
		const canvas = new RecordingCanvas()
		const merges = model.merges(layout)
		const selection = addSelection(
			extendSelection(cellSelection({ row: 0, col: 0 }, merges), { row: 1, col: 1 }, merges),
			{ row: 3, col: 3 },
			merges
		)

		paintChrome(canvas, { view, theme: DEFAULT_THEME, pixelRatio: 1, selection, merges, guide: { axis: "cols", at: 200 } })

		const d4 = box(view, 3, 3)
		const tints = canvas.calls.filter(call => call.op === "fillRect" && call.fill === DEFAULT_THEME.selectionFill)

		expect(tints.length).toBe(2)
		expect(canvas.calls).toContainEqual(expect.objectContaining({ op: "clearRect", args: [d4.x, d4.y, d4.width, d4.height] }))
		expect(canvas.texts()).toEqual(expect.arrayContaining(["A", "B", "D", "1", "4"]))
		expect(
			canvas.calls.some(call => call.op === "fillText" && call.args[0] === "A" && call.fill === DEFAULT_THEME.headerActiveText)
		).toBe(true)
		expect(canvas.calls.some(call => call.op === "fillText" && call.args[0] === "C" && call.fill === DEFAULT_THEME.headerText)).toBe(
			true
		)
		expect(canvas.calls).toContainEqual(
			expect.objectContaining({ op: "fillRect", args: [199, 0, 2, view.height], fill: DEFAULT_THEME.resizeLine })
		)
	})
})
