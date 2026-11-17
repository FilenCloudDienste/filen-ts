import { describe, expect, it } from "vitest"
import type { SheetLayout } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells, roundedGeneral } from "../react/sheet/paint/cells"
import { paintChrome } from "../react/sheet/paint/chrome"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { cellSelection } from "../react/sheet/selection"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { gridView, screenOf, type GridView } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE, buildFixture } from "./sheetSessionFixtures"
import type { Fixture } from "./xlsxWriteFixtures"

// What the cells and chrome layers draw for formats the toolbar sets: General numbers rounded to their cell's
// width, and a right-to-left sheet mirrored.

const WIDTH = 900

// Records draw calls at their place on screen: x through the transform last set (a mirror or the identity).
class ScreenCanvas extends RecordingCanvas {
	private mirror = false

	override setTransform(...matrix: number[]): void {
		this.mirror = (matrix[0] ?? 1) < 0
	}

	private x(x: number): number {
		return this.mirror ? WIDTH - x : x
	}

	override fillText(text: string, x: number, y: number): void {
		super.fillText(text, this.x(x), y)
	}

	override moveTo(x: number, y: number): void {
		super.moveTo(this.x(x), y)
	}

	override lineTo(x: number, y: number): void {
		super.lineTo(this.x(x), y)
	}

	override translate(x: number, y: number): void {
		super.translate(this.x(x), y)
	}
}

const STYLES =
	'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
	'<border diagonalUp="1"><left style="thick"><color rgb="FF0000FF"/></left><right/><top/><bottom/><diagonal style="thin"><color rgb="FF00FF00"/></diagonal></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment readingOrder="2"/></xf></cellXfs>' +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'

async function painted(
	fixture: Fixture,
	prepare?: (model: SheetGridModel) => void
): Promise<{ canvas: ScreenCanvas; chrome: ScreenCanvas; view: GridView; layout: SheetLayout }> {
	const result = await inThreadSheetHost().open(buildFixture(fixture), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind)

	const model = new SheetGridModel({ source: result.session, edit: result.session, info: result.info })
	const sheet = result.info.activeSheet

	model.need(sheet, [0, 0])

	for (let k = 0; k < 8; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	prepare?.(model)

	const view = gridView(axes, layout, { top: 0, left: 0 }, WIDTH, 400)
	const canvas = new ScreenCanvas()
	const chrome = new ScreenCanvas()

	paintCells(
		{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
		{ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }
	)
	paintChrome(chrome, {
		view,
		theme: DEFAULT_THEME,
		pixelRatio: 1,
		selection: cellSelection({ row: 0, col: 0 }, []),
		merges: [],
		guide: null,
		rightToLeft: layout.rightToLeft
	})

	return { canvas, chrome, view, layout }
}

// 14.67 px Calibri 11 measures 8.07 px a character: a column stored 5.7109375 wide (40 px, §18.3.1.13) takes 4.
const NARROW = '<cols><col min="1" max="2" width="5.7109375" customWidth="1"/></cols>'

describe("General numbers in narrow cells", () => {
	it("round to the characters the cell takes, then go exponential, as Excel shows them", async () => {
		let grid: SheetGridModel | null = null
		const { canvas } = await painted(
			{
				sheets: [
					{
						name: "S",
						body:
							`${NARROW}<sheetData>` +
							'<row r="1"><c r="A1"><v>3.14159265</v></c><c r="B1" s="1"><v>3.14159265</v></c></row>' +
							'<row r="2"><c r="A2"><v>123456789</v></c><c r="B2"><f>A1*2</f><v>6.2831853</v></c></row>' +
							"</sheetData>"
					}
				],
				styles: STYLES
			},
			model => {
				grid = model
			}
		)
		const texts = canvas.texts()

		expect(texts).toContain("3.14")
		// What Increase Decimal starts from: the rounded text, for the General number only.
		expect(grid === null ? null : [roundedGeneral(grid, 0, 0, 0), roundedGeneral(grid, 0, 0, 1)]).toEqual(["3.14", undefined])
		expect(texts).toContain("6.28")
		// Not even "1E+08" fits four characters.
		expect(texts.filter(text => /^#+$/u.test(text)).length).toBe(1)
		// A number in a format of its own (0.00 is "3.14", four characters) fits as it is.
		expect(texts.filter(text => text === "3.14").length).toBe(2)
	})
})

describe("right-to-left sheets", () => {
	const row =
		'<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c><c r="B1" s="2"><v>2</v></c><c r="C1" s="3" t="inlineStr"><is><t>left</t></is></c>' +
		'<c r="D1" t="inlineStr"><is><t>\u05e9\u05dc\u05d5\u05dd</t></is></c><c r="E1" s="4" t="inlineStr"><is><t>order</t></is></c></row>'
	const sheet = (rightToLeft: boolean): Fixture => ({
		sheets: [
			{
				name: "S",
				body: `<sheetViews><sheetView${rightToLeft ? ' rightToLeft="1"' : ""} workbookViewId="0"/></sheetViews><sheetData>${row}</sheetData>`
			}
		],
		styles: STYLES
	})
	const fixture = sheet(true)

	// A column's screen span.
	function span(view: GridView, col: number, mirrored = true): { left: number; right: number } {
		const x = screenOf(view.cols, col)
		const width = view.cols.axis.size(col)

		return mirrored ? { left: WIDTH - x - width, right: WIDTH - x } : { left: x, right: x + width }
	}

	function textX(canvas: ScreenCanvas, text: string): number {
		const call = canvas.calls.find(entry => entry.op === "fillText" && entry.args[0] === text)

		if (call === undefined) throw new Error(`no ${text}`)

		return call.args[1] as number
	}

	const middle = (column: { left: number; right: number }): number => (column.left + column.right) / 2

	// Where text ends: 14.67 px Calibri measures 0.55 of that a character here.
	const textEnd = (canvas: ScreenCanvas, text: string): number => textX(canvas, text) + [...text].length * 14.67 * 0.55

	// At the cell's right edge, its padding inside.
	function atRight(canvas: ScreenCanvas, text: string, column: { left: number; right: number }): void {
		expect(textEnd(canvas, text)).toBeGreaterThan(column.right - 6)
		expect(textEnd(canvas, text)).toBeLessThanOrEqual(column.right)
	}

	it("put column A at the right and row headers beside it", async () => {
		const { chrome, view, layout } = await painted(fixture)

		expect(layout.rightToLeft).toBe(true)

		const a = span(view, 0)
		const header = chrome.calls.find(call => call.op === "fillText" && call.args[0] === "A")
		const row = chrome.calls.find(call => call.op === "fillText" && call.args[0] === "1")

		expect(header?.args[1]).toBeCloseTo((a.left + a.right) / 2, 5)
		expect(row?.args[1]).toBeCloseTo(WIDTH - view.cols.header / 2, 5)
	})

	// General alignment does not follow the sheet's direction (LibreOffice draws it so; §18.18.40 says only that
	// text is left-aligned and numbers right-aligned).
	it("keep General text at the left, a number at the right and explicit left at the left", async () => {
		const { canvas, view } = await painted(fixture)
		const a = span(view, 0)

		expect(textX(canvas, "first")).toBeGreaterThanOrEqual(a.left)
		expect(textX(canvas, "first")).toBeLessThanOrEqual(a.left + 4)
		atRight(canvas, "2", span(view, 1))
		// "Left" is left even in right-to-left mode (ECMA-376 Part 1 §18.18.40).
		expect(textX(canvas, "left")).toBeLessThan(middle(span(view, 2)))
	})

	it("start General text that reads right to left at the right, in either direction of sheet", async () => {
		for (const rightToLeft of [true, false]) {
			const { canvas, view } = await painted(sheet(rightToLeft))

			atRight(canvas, "\u05e9\u05dc\u05d5\u05dd", span(view, 3, rightToLeft))
			// A right-to-left reading order (readingOrder="2") puts even Latin text at the right.
			atRight(canvas, "order", span(view, 4, rightToLeft))
			expect(textX(canvas, "first")).toBeLessThan(middle(span(view, 0, rightToLeft)))
		}
	})

	it("draw a cell's left border on its leading edge, mirrored, and its diagonal going up", async () => {
		const { canvas, view } = await painted(fixture)
		const b = span(view, 1)
		const y = screenOf(view.rows, 0)
		const thick = canvas.calls.filter(call => call.op === "stroke" && call.lineWidth === 3)
		const edges = canvas.calls.filter(call => call.op === "moveTo" && call.args[1] === y - 1).map(call => call.args[0] as number)
		// The diagonal's end at the cell's top.
		const top = canvas.calls.filter(
			call => (call.op === "lineTo" || call.op === "moveTo") && call.args[1] === y && call.lineWidth === 1
		)

		expect(thick.length).toBe(1)
		// "left" is the leading edge (ECMA-376 Part 4 §15.5.1, Part 1 §18.8.37): the right on screen, beside column A.
		expect(edges.some(x => Math.abs(x - b.right) <= 1.5)).toBe(true)
		expect(edges.some(x => Math.abs(x - b.left) <= 1.5)).toBe(false)
		// Going up: its top end at the upper right on screen.
		expect(top.length).toBe(1)
		expect(top[0]?.args[0]).toBeGreaterThan((b.left + b.right) / 2)
	})
})

describe("Show Formulas", () => {
	it("draws each formula as typed, as text, even where its result is empty", async () => {
		const fixture: Fixture = {
			sheets: [
				{
					name: "S",
					body:
						`${NARROW}<sheetData>` +
						'<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*30000000</f><v>60000000</v></c><c r="C1" t="str"><f>""</f><v></v></c></row>' +
						"</sheetData>"
				}
			],
			styles: STYLES
		}
		const results = (await painted(fixture)).canvas.texts()
		const formulas = (await painted(fixture, model => model.setShowFormulas(true))).canvas.texts()

		expect(results.some(text => /^#+$/u.test(text) || text.includes("E+"))).toBe(true)
		expect(formulas).toContain("=A1*30000000")
		expect(formulas).toContain('=""')
		expect(formulas).toContain("2")
	})
})
