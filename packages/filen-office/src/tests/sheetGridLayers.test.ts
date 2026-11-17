import { describe, expect, it } from "vitest"
import { CellFlag, type SheetLayout } from "../core/sheet/protocol"
import {
	decoratePane,
	extensionParts,
	gridPanes,
	paintScene,
	rangeRects,
	sameParts,
	type GridDecoration,
	type SheetCellDecorator,
	type SheetGridExtension
} from "../react/sheet/layers"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { gridView, screenOf, type GridView } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { buildFixture, openFixture } from "./sheetSessionFixtures"

// The grid's extension points: decorators reach exactly the flagged cells on screen (a merge once, by its box),
// "under" decorators draw before a pane's text, and the extension list flattens in order and repaints only when a
// part changes.

const BODY =
	"<sheetData>" +
	'<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c><c r="C1" t="str"><v>x</v></c></row>' +
	'<row r="2"><c r="A2"><f>A1+1</f><v>2</v></c></row>' +
	'<row r="4"><c r="B4"><f>A1</f><v>1</v></c></row>' +
	'</sheetData><mergeCells count="1"><mergeCell ref="B4:C5"/></mergeCells>'

async function opened(): Promise<{ model: SheetGridModel; layout: SheetLayout; view: GridView; sheet: number }> {
	const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "S", body: BODY }] }))
	const model = new SheetGridModel({ source: session, edit: session, info })
	const sheet = info.activeSheet

	model.need(sheet, [0, 0])

	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	return { model, layout, view: gridView(axes, layout, { top: 0, left: 0 }, 900, 400), sheet }
}

function recorder(phase: "under" | "over", mask: number, seen: GridDecoration[], canvas?: RecordingCanvas): SheetCellDecorator {
	return {
		id: `${phase}-${String(mask)}`,
		mask,
		phase,
		paint: (_canvas, cell) => {
			seen.push(cell)
			canvas?.fillRect(-1, -1, 1, 1)
		}
	}
}

describe("sheet grid decorators", () => {
	it("visit each flagged cell on screen once, a merge by its first cell and whole box", async () => {
		const { model, layout, view, sheet } = await opened()
		const scene = paintScene({ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1, rightToLeft: false })
		const seen: GridDecoration[] = []
		const canvas = new RecordingCanvas()

		for (const pane of scene.panes)
			decoratePane(canvas, scene, [recorder("over", CellFlag.FORMULA, seen)], "over", pane.rows, pane.cols)

		expect(seen.map(cell => [cell.row, cell.col]).sort()).toEqual([
			[0, 1],
			[1, 0],
			[3, 1]
		])

		const merged = seen.find(cell => cell.row === 3)

		expect(merged?.box).toEqual({
			x: screenOf(view.cols, 1),
			y: screenOf(view.rows, 3),
			width: view.cols.axis.size(1) + view.cols.axis.size(2),
			height: view.rows.axis.size(3) + view.rows.axis.size(4)
		})
	})

	it("of the other phase or mask are not called", async () => {
		const { model, layout, view, sheet } = await opened()
		const scene = paintScene({ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1, rightToLeft: false })
		const seen: GridDecoration[] = []
		const decorators = [recorder("under", CellFlag.FORMULA, seen), recorder("over", CellFlag.ERROR, seen)]

		for (const pane of scene.panes) decoratePane(new RecordingCanvas(), scene, decorators, "over", pane.rows, pane.cols)

		expect(seen).toEqual([])
	})

	it("under the text draw after the fills and before the text", async () => {
		const { model, layout, view, sheet } = await opened()
		const scene = paintScene({ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1, rightToLeft: false })
		const canvas = new RecordingCanvas()
		const seen: GridDecoration[] = []
		const decorators = [recorder("under", CellFlag.FORMULA, seen, canvas)]

		paintCells(
			{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
			{ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 },
			(rows, cols) => decoratePane(canvas, scene, decorators, "under", rows, cols)
		)

		const marks = canvas.calls.flatMap((call, index) => (call.op === "fillRect" && call.args[0] === -1 ? [index] : []))
		const firstText = canvas.calls.findIndex(call => call.op === "fillText")

		expect(marks).toHaveLength(3)
		expect(Math.max(...marks)).toBeLessThan(firstText)
	})
})

describe("sheet grid layer geometry", () => {
	it("gives a range one rectangle per pane, clipped to it", async () => {
		const { view } = await opened()
		const rects = rangeRects(view, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 })

		expect(rects).toEqual([
			{
				x: screenOf(view.cols, 0),
				y: screenOf(view.rows, 0),
				width: view.cols.axis.size(0) + view.cols.axis.size(1),
				height: view.rows.axis.size(0) + view.rows.axis.size(1)
			}
		])
		expect(gridPanes(view)).toHaveLength(1)
	})
})

describe("sheet grid extensions", () => {
	const layer = { id: "l", stage: "chrome" as const, paint: () => undefined }
	const decorator: SheetCellDecorator = { id: "d", mask: CellFlag.NOTE, phase: "over", paint: () => undefined }
	const pointer = (): boolean => false

	it("flatten in order, by stage", () => {
		const cells = { id: "c", stage: "cells" as const, paint: () => undefined }
		const parts = extensionParts([
			{ id: "a", layers: [layer, cells], pointer },
			{ id: "b", decorators: [decorator] }
		])

		expect(parts.chromeLayers).toEqual([layer])
		expect(parts.cellLayers).toEqual([cells])
		expect(parts.decorators).toEqual([decorator])
		expect(parts.pointers).toEqual([pointer])
	})

	it("refuse an id given twice", () => {
		expect(() => extensionParts([{ id: "a" }, { id: "a" }])).toThrow(/given twice/)
	})

	it("rebuilt with the same parts count as unchanged, a new part as changed", () => {
		const list = (): SheetGridExtension[] => [{ id: "a", layers: [layer], decorators: [decorator], pointer }]

		expect(sameParts(extensionParts(list()), extensionParts(list()))).toBe(true)
		expect(
			sameParts(extensionParts(list()), extensionParts([{ id: "a", layers: [{ ...layer }], decorators: [decorator], pointer }]))
		).toBe(false)
	})
})
