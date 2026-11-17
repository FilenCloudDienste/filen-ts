import { describe, expect, it } from "vitest"
import type { SheetLayout } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { gridView } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE, buildFixture } from "./sheetSessionFixtures"

// save() and restore() keep and put back the font, as CanvasRenderingContext2D's do (the font is part of the
// HTML canvas drawing state).
class StatefulCanvas extends RecordingCanvas {
	private readonly fonts: string[] = []

	override save(): void {
		this.fonts.push(this.font)
	}

	override restore(): void {
		this.font = this.fonts.pop() ?? this.font
	}
}

const STYLES =
	'<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Arial"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment textRotation="45"/></xf>' +
	'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'

function str(ref: string, text: string, s = 0): string {
	return `<c r="${ref}" t="inlineStr"${s === 0 ? "" : ` s="${String(s)}"`}><is><t>${text}</t></is></c>`
}

async function paintTwice(body: string): Promise<string[]> {
	const result = await inThreadSheetHost().open(
		buildFixture({ sheets: [{ name: "S", body }], styles: STYLES }),
		{ kind: "xlsx", slicing: IMMEDIATE },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind)

	const model = new SheetGridModel({ source: result.session, edit: result.session, info: result.info })
	const sheet = result.info.activeSheet

	model.need(sheet, [0, 0])

	for (let k = 0; k < 8; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 400)
	const canvas = new StatefulCanvas()
	const painters = {
		canvas,
		measurer: new TextMeasurer(canvas),
		borders: new BorderPainter(canvas),
		patterns: new PatternCache(() => null)
	}
	const scene = { model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }

	// The second frame takes every width from the measurer's cache, so nothing sets the font before a clip.
	paintCells(painters, scene)
	canvas.reset()
	paintCells(painters, scene)
	result.session.close()

	return canvas.calls.filter(call => call.op === "fillText").map(call => `${String(call.args[0])} @ ${String(call.font)}`)
}

describe("cell text font", () => {
	it("draws every cell in its own font after a cell whose text was clipped", async () => {
		const drawn = await paintTwice(
			'<cols><col min="1" max="3" width="6" customWidth="1"/></cols><sheetData>' +
				`<row r="1">${str("A1", "a long text clipped by B1")}${str("B1", "b")}${str("C1", "c")}</row>` +
				`<row r="2">${str("A2", "x")}<c r="B2"><v>12</v></c>${str("C2", "bold", 2)}</row></sheetData>`
		)

		expect(drawn.length).toBeGreaterThanOrEqual(6)
		expect(drawn.filter(entry => entry.includes("10px sans-serif"))).toEqual([])
		expect(drawn.filter(entry => entry.startsWith("bold @")).every(entry => entry.includes("bold 18.67px"))).toBe(true)
	})

	it("draws every cell in its own font after turned text and across frozen panes", async () => {
		const drawn = await paintTwice(
			'<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' +
				'<cols><col min="1" max="3" width="6" customWidth="1"/></cols><sheetData>' +
				`<row r="1">${str("A1", "turned", 1)}${str("B1", "b")}${str("C1", "bold", 2)}</row>` +
				`<row r="2">${str("A2", "a long text clipped by B2")}${str("B2", "x")}${str("C2", "y")}</row></sheetData>`
		)

		expect(drawn.length).toBeGreaterThanOrEqual(6)
		expect(drawn.filter(entry => entry.includes("10px sans-serif"))).toEqual([])
		expect(drawn.filter(entry => entry.startsWith("bold @")).every(entry => entry.includes("bold 18.67px"))).toBe(true)
	})
})
