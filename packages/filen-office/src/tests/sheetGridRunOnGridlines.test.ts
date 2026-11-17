import { describe, expect, it, vi } from "vitest"
import type { SheetLayout } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { gridView, screenOf } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { buildFixture, openFixture } from "./sheetSessionFixtures"

// Text running on into empty neighbours hides the gridlines it crosses, as Excel draws it on screen and on paper;
// past the text's end, and in other rows, they stay.

const BODY =
	"<sheetData>" +
	'<row r="1"><c r="A1" t="inlineStr"><is><t>a long text that runs on and on</t></is></c><c r="E1" t="inlineStr"><is><t>stop</t></is></c></row>' +
	'<row r="2"><c r="A2" t="inlineStr"><is><t>short</t></is></c></row>' +
	'<row r="3"><c r="D3" t="inlineStr"><is><t>a right aligned run</t></is></c></row>' +
	"</sheetData>"
const STYLES =
	'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'

async function painted(measurer?: (canvas: RecordingCanvas) => TextMeasurer) {
	const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "S", body: BODY }], styles: STYLES }))
	const model = new SheetGridModel({ source: session, edit: session, info })
	const sheet = info.activeSheet

	model.need(sheet, [0, 0])

	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 300)
	const canvas = new RecordingCanvas()

	paintCells(
		{
			canvas,
			measurer: measurer?.(canvas) ?? new TextMeasurer(canvas),
			borders: new BorderPainter(canvas),
			patterns: new PatternCache(() => null)
		},
		{ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }
	)

	return { canvas, view }
}

// Whether a vertical gridline is drawn at the right edge of `col` through row `row`.
function lineThrough(canvas: RecordingCanvas, view: ReturnType<typeof gridView>, row: number, col: number): boolean {
	const x = screenOf(view.cols, col) + view.cols.axis.size(col) - 1
	const y = screenOf(view.rows, row) + view.rows.axis.size(row) / 2

	return canvas.calls.some(call => {
		if (call.op !== "fillRect" || call.fill !== DEFAULT_THEME.gridLine) return false

		const [left, top, width, height] = call.args as number[]

		return left === x && width === 1 && (top ?? 0) <= y && (top ?? 0) + (height ?? 0) >= y
	})
}

describe("gridlines under text running on", () => {
	it("lays out each text that runs on once per frame, for its gridlines and its drawing both", async () => {
		const measured: string[] = []

		await painted(canvas => {
			const measurer = new TextMeasurer(canvas)
			const width = measurer.width.bind(measurer)

			vi.spyOn(measurer, "width").mockImplementation((font, text) => {
				measured.push(text)

				return width(font, text)
			})

			return measurer
		})

		expect(measured.filter(text => text === "a long text that runs on and on")).toHaveLength(1)
		expect(measured.filter(text => text === "a right aligned run")).toHaveLength(1)
	})

	it("are hidden where the text crosses them and kept past its end and in other rows", async () => {
		const { canvas, view } = await painted()

		// "a long text that runs on and on": 31 characters of 8 px from A1's padding, about 250 px: over A, B and C.
		expect(lineThrough(canvas, view, 0, 0)).toBe(false)
		expect(lineThrough(canvas, view, 0, 1)).toBe(false)
		expect(lineThrough(canvas, view, 0, 2)).toBe(false)
		// The text ends inside D; D's right edge, where E stops it, keeps its line.
		expect(lineThrough(canvas, view, 0, 3)).toBe(true)
		expect(lineThrough(canvas, view, 1, 0)).toBe(true)
		expect(lineThrough(canvas, view, 2, 0)).toBe(true)
	})
})
