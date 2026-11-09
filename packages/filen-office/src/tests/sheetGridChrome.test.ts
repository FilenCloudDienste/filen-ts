import { describe, expect, it } from "vitest"
import type { SheetLayout, SheetRange } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { paintChrome } from "../react/sheet/paint/chrome"
import { axisSelection, cellSelection, extendSelection } from "../react/sheet/selection"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { gridView, screenOf, type GridView } from "../react/sheet/view"
import { RecordingCanvas, type DrawCall } from "./sheetGridCanvas"
import { BASIC, buildFixture, openFixture } from "./sheetSessionFixtures"

// The chrome layer's headers as Excel's: a double line where rows or columns are hidden, and a stronger mark for
// whole rows or columns selected. The latest copy's moving border, and what ends it: Esc, an edit, a cut's paste.

// Column B and rows 3 to 4 hidden.
const HIDDEN =
	'<cols><col min="2" max="2" width="9" hidden="1" customWidth="1"/></cols><sheetData>' +
	'<row r="1"><c r="A1"><v>1</v></c></row><row r="3" hidden="1"/><row r="4" hidden="1"/></sheetData>'

async function opened(body = HIDDEN): Promise<{ model: SheetGridModel; view: GridView; layout: SheetLayout; sheet: number }> {
	const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "S", body }] }))
	const model = new SheetGridModel({ session, info })
	const sheet = info.activeSheet

	model.need(sheet, [0, 0])

	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	return { model, view: gridView(axes, layout, { top: 0, left: 0 }, 900, 400), layout, sheet }
}

function headerLines(canvas: RecordingCanvas, axis: "rows" | "cols", band: number): number[] {
	return canvas.calls
		.filter(
			call =>
				call.op === "fillRect" &&
				call.fill === DEFAULT_THEME.headerLine &&
				(axis === "cols" ? call.args[2] === 1 && call.args[3] === band : call.args[2] === band && call.args[3] === 1)
		)
		.map(call => call.args[axis === "cols" ? 0 : 1] as number)
}

function headerText(canvas: RecordingCanvas, text: string): DrawCall | undefined {
	return canvas.calls.find(call => call.op === "fillText" && call.args[0] === text)
}

function range(startRow: number, startCol: number, endRow: number, endCol: number): SheetRange {
	return { startRow, startCol, endRow, endCol }
}

describe("the chrome layer's headers", () => {
	it("draws a double line where columns or rows are hidden", async () => {
		const { view, model, layout } = await opened()
		const canvas = new RecordingCanvas()

		paintChrome(canvas, { view, theme: DEFAULT_THEME, pixelRatio: 1, selection: null, merges: model.merges(layout), guide: null })

		const a = screenOf(view.cols, 0) + view.cols.axis.size(0)
		const c = screenOf(view.cols, 2)
		const cols = headerLines(canvas, "cols", view.rows.header)

		expect(view.cols.axis.size(1)).toBe(0)
		expect(c).toBe(a)
		// A's boundary line, and a second one a pixel into C past it.
		expect(cols).toContain(a - 1)
		expect(cols).toContain(c + 1)
		// No second line beside a boundary with nothing hidden at it.
		expect(cols).not.toContain(screenOf(view.cols, 3) + 1)

		const row5 = screenOf(view.rows, 4)
		const rows = headerLines(canvas, "rows", view.cols.header)

		expect(rows).toContain(row5 - 1)
		expect(rows).toContain(row5 + 1)
		expect(rows).not.toContain(screenOf(view.rows, 1) + 1)
	})

	it("marks whole columns or rows selected more strongly than a cell selection", async () => {
		const { view, model, layout } = await opened(BASIC.sheets[0]?.body)
		const merges = model.merges(layout)
		const paint = (selection: ReturnType<typeof cellSelection>): RecordingCanvas => {
			const canvas = new RecordingCanvas()

			paintChrome(canvas, { view, theme: DEFAULT_THEME, pixelRatio: 1, selection, merges, guide: null })

			return canvas
		}

		const cells = paint(extendSelection(cellSelection({ row: 0, col: 2 }, merges), { row: 1, col: 3 }, merges))

		expect(headerText(cells, "C")?.fill).toBe(DEFAULT_THEME.headerActiveText)
		expect(headerText(cells, "1")?.fill).toBe(DEFAULT_THEME.headerActiveText)
		expect(cells.calls.some(call => call.fill === DEFAULT_THEME.headerSelectedBackground)).toBe(false)

		// Columns C:D whole: their headers selected, the rows' headers only touched.
		const columns = paint(axisSelection("cols", 2, 3, { row: 0, col: 2 }, null))
		const c = screenOf(view.cols, 2)

		expect(headerText(columns, "C")?.fill).toBe(DEFAULT_THEME.headerSelectedText)
		expect(headerText(columns, "D")?.fill).toBe(DEFAULT_THEME.headerSelectedText)
		expect(headerText(columns, "E")?.fill).toBe(DEFAULT_THEME.headerText)
		expect(headerText(columns, "1")?.fill).toBe(DEFAULT_THEME.headerActiveText)
		expect(columns.calls).toContainEqual(
			expect.objectContaining({
				op: "fillRect",
				args: [c, 0, view.cols.axis.size(2), view.rows.header],
				fill: DEFAULT_THEME.headerSelectedBackground
			})
		)

		const rows = paint(axisSelection("rows", 1, 1, { row: 1, col: 0 }, null))

		expect(headerText(rows, "2")?.fill).toBe(DEFAULT_THEME.headerSelectedText)
		expect(headerText(rows, "A")?.fill).toBe(DEFAULT_THEME.headerActiveText)
	})
})

describe("the copy's moving border", () => {
	it("is drawn dashed round the copied range, its dashes at the step's offset over a solid halo", async () => {
		const { view, model, layout } = await opened(BASIC.sheets[0]?.body)
		const canvas = new RecordingCanvas()
		const clip = range(1, 1, 2, 2)

		paintChrome(canvas, {
			view,
			theme: DEFAULT_THEME,
			pixelRatio: 1,
			selection: null,
			merges: model.merges(layout),
			guide: null,
			clip: { range: clip, offset: 3 }
		})

		const x = screenOf(view.cols, 1) - 0.5
		const y = screenOf(view.rows, 1) - 0.5
		const width = view.cols.axis.size(1) + view.cols.axis.size(2)
		const height = view.rows.axis.size(1) + view.rows.axis.size(2)
		const rects = canvas.calls.filter(call => call.op === "rect" && call.args[0] === x && call.args[1] === y)
		const strokes = canvas.calls.filter(call => call.op === "stroke")

		expect(rects.map(call => call.args)).toEqual([
			[x, y, width, height],
			[x, y, width, height]
		])
		expect(strokes.map(call => [call.stroke, call.dash, call.dashOffset])).toEqual([
			[DEFAULT_THEME.selectionHalo, [], 0],
			[DEFAULT_THEME.selectionLine, [4, 4], -3]
		])
		expect(canvas.lineDashOffset).toBe(0)
	})

	it("shows from a copy until Esc, and a cancelled cut no longer names its clip", async () => {
		const { model, sheet } = await opened(BASIC.sheets[0]?.body)

		expect(model.cancelClip()).toBe(false)

		model.setClip({ id: 1, sheet, range: range(0, 0, 0, 1), cut: false })
		expect(model.clipMark()?.range).toEqual(range(0, 0, 0, 1))
		expect(model.cancelClip()).toBe(true)
		expect(model.clipMark()).toBeNull()
		// A copy still pastes as itself once its border went.
		expect(model.clipId()).toBe(1)
		expect(model.cancelClip()).toBe(false)

		model.setClip({ id: 2, sheet, range: range(0, 0, 0, 1), cut: true })
		expect(model.cancelClip()).toBe(true)
		expect(model.clipId()).toBeUndefined()
	})

	it("survives the copy's own pastes and ends on any other edit", async () => {
		const { model, sheet } = await opened(BASIC.sheets[0]?.body)
		const copied = await model.session.query("copy", { sheet, range: range(0, 0, 0, 1), cut: false })

		if ("refused" in copied) throw new Error("refused")

		model.setClip({ id: copied.clip, sheet, range: range(0, 0, 0, 1), cut: false })
		expect(
			(await model.command({ type: "clipboard.paste", sheet, at: { row: 5, col: 0 }, text: copied.text, clip: copied.clip })).ok
		).toBe(true)
		expect(model.clipMark()).not.toBeNull()

		await model.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(9), cols: Uint16Array.of(0), inputs: ["x"] } })
		expect(model.clipMark()).toBeNull()
		expect(model.clipId()).toBe(copied.clip)
	})

	it("ends on the cut's paste, which leaves a copy of the pasted cells to paste again", async () => {
		const { model, sheet } = await opened(BASIC.sheets[0]?.body)
		const cut = await model.session.query("copy", { sheet, range: range(0, 0, 0, 1), cut: true })

		if ("refused" in cut) throw new Error("refused")

		model.setClip({ id: cut.clip, sheet, range: range(0, 0, 0, 1), cut: true })
		await model.command({ type: "clipboard.paste", sheet, at: { row: 5, col: 0 }, text: cut.text, clip: cut.clip })
		expect(model.clipMark()).toBeNull()
		expect(model.clipId()).toBe(cut.clip)
	})

	it("ends on undo", async () => {
		const { model, sheet } = await opened(BASIC.sheets[0]?.body)

		await model.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(9), cols: Uint16Array.of(0), inputs: ["x"] } })
		model.setClip({ id: 1, sheet, range: range(0, 0, 0, 0), cut: false })
		expect((await model.undo()).ok).toBe(true)
		expect(model.clipMark()).toBeNull()
	})
})
