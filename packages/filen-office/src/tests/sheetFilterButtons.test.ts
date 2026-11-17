import { describe, expect, it } from "vitest"
import type { SheetLayout } from "../core/sheet/protocol"
import { paintScene } from "../react/sheet/layers"
import { SheetGridModel } from "../react/sheet/model"
import {
	FILTER_BUTTONS_LAYER,
	FILTER_BUTTON_SIZE,
	filterButtonAt,
	filterButtonRect,
	filterRangeAt,
	inFilterButton
} from "../react/sheet/overlays/filterButtons"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { gridView } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { buildFixture, openFixture } from "./sheetSessionFixtures"

// The autofilter buttons on the grid: one per header cell whose column shows one, at its trailing edge, found again
// by a press on it in either direction of writing; columns the file hides the button of get none.

const BODY =
	'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row><row r="2"><c r="A2"><v>4</v></c></row></sheetData>' +
	'<autoFilter ref="A1:C2"><filterColumn colId="1"><filters><filter val="9"/></filters></filterColumn><filterColumn colId="2" hiddenButton="1"/></autoFilter>'

async function grid(): Promise<{ model: SheetGridModel; layout: SheetLayout; sheet: number }> {
	const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "S", body: BODY }] }))
	const model = new SheetGridModel({ source: session, edit: session, info })
	const sheet = info.activeSheet

	return { model, layout: (model.layout(sheet) ?? info.activeLayout) as SheetLayout, sheet }
}

describe("filter buttons", () => {
	it("find the header cells with a button and the range of any cell in a filter", async () => {
		const { layout } = await grid()

		expect(filterButtonAt(layout, 0, 0)?.bits).toBe(1)
		expect(filterButtonAt(layout, 0, 1)?.bits).toBe(3)
		expect(filterButtonAt(layout, 0, 2)).toBeNull()
		expect(filterButtonAt(layout, 1, 0)).toBeNull()
		expect(filterRangeAt(layout, 1, 2)?.range).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 })
		expect(filterRangeAt(layout, 2, 0)).toBeNull()
	})

	it("sit at the cell's trailing bottom corner, and a press finds them mirrored too", () => {
		const cell = { x: 100, y: 20, width: 64, height: 20 }
		const button = filterButtonRect(cell, 1)

		expect(button).toEqual({ x: 100 + 64 - FILTER_BUTTON_SIZE - 1, y: 23, width: FILTER_BUTTON_SIZE, height: FILTER_BUTTON_SIZE })
		// A short row's button fits inside its gridlines; zoom scales it.
		expect(filterButtonRect({ ...cell, height: 12 }, 1).width).toBe(10)
		expect(filterButtonRect({ ...cell, height: 60 }, 2).width).toBe(32)
		expect(inFilterButton(cell, 160, 30, 1, false)).toBe(true)
		expect(inFilterButton(cell, 110, 30, 1, false)).toBe(false)
		expect(inFilterButton(cell, 105, 30, 1, true)).toBe(true)
		expect(inFilterButton(cell, 160, 30, 1, true)).toBe(false)
	})

	it("paint one button per shown column, the filtered one in the selection colour", async () => {
		const { model, layout, sheet } = await grid()
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		const scene = paintScene({
			model,
			sheet,
			layout,
			view: gridView(axes, layout, { top: 0, left: 0 }, 900, 400),
			theme: DEFAULT_THEME,
			scale: 1,
			pixelRatio: 1,
			rightToLeft: false
		})
		const canvas = new RecordingCanvas()

		FILTER_BUTTONS_LAYER.paint(canvas, scene)

		const faces = canvas.calls.filter(call => call.op === "fillRect" && call.fill === DEFAULT_THEME.headerBackground)

		expect(faces.length).toBe(2)
		expect(canvas.calls.some(call => call.op === "fillRect" && call.fill === DEFAULT_THEME.selectionLine)).toBe(true)
	})
})
