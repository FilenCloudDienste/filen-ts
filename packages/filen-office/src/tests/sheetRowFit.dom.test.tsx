// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SHEET_MAX_ROWS, type SheetSessionApi } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGrid, SheetGridModel } from "../react/sheet/index"
import { TextMeasurer } from "../react/sheet/paint/text"
import { measureRows } from "../react/sheet/rowFit"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE, buildFixture, savedBytes } from "./sheetSessionFixtures"
import { STYLES, parts } from "./xlsxWriteFixtures"
import { budget } from "./timing"

// Rows without a height of their own fit the wrapped text an edit changes, measured by the grid as it draws it:
// wrap turned on grows the row, a wider column or wrap turned off shrinks it, a height set by hand stays, and a
// file's saved heights show as they are at open.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
		return new RecordingCanvas() as unknown as CanvasRenderingContext2D
	} as unknown as typeof HTMLCanvasElement.prototype.getContext)
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 800 : 0
	})
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 400 : 0
	})
})

const roots: Root[] = []

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
	vi.restoreAllMocks()
})

async function settle(): Promise<void> {
	for (let k = 0; k < 10; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

// A1 a text of 20 characters (8.07 px each in the test canvas) in a 64 px column; row 3 set by hand; row 5 saved
// taller than its content.
const BODY =
	'<sheetFormatPr defaultRowHeight="15"/><sheetData>' +
	'<row r="1"><c r="A1" t="inlineStr"><is><t>wrapped words of text</t></is></c></row>' +
	'<row r="3" ht="30" customHeight="1"><c r="A3" t="inlineStr"><is><t>wrapped words of text</t></is></c></row>' +
	'<row r="5" ht="45"><c r="A5" t="inlineStr"><is><t>short</t></is></c></row></sheetData>'
const WRAP_STYLES = STYLES.replace('<cellXfs count="2">', '<cellXfs count="3">').replace(
	"</cellXfs>",
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs>'
)

// Each mounted model's session, which edits and saves go through.
const sessions = new WeakMap<SheetGridModel, SheetSessionApi>()

function sessionOf(model: SheetGridModel): SheetSessionApi {
	const session = sessions.get(model)

	if (session === undefined) throw new Error("no session")

	return session
}

async function mount(): Promise<SheetGridModel> {
	const opened = await inThreadSheetHost().open(
		buildFixture({ sheets: [{ name: "One", body: BODY }], styles: WRAP_STYLES }),
		{ kind: "xlsx", slicing: IMMEDIATE },
		() => undefined
	)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })

	sessions.set(model, opened.session)

	const container = document.createElement("div")
	const root = createRoot(container)

	roots.push(root)
	document.body.appendChild(container)
	model.measureWith({ measurer: () => new TextMeasurer(new RecordingCanvas()), font: () => "sans-serif" })
	await act(async () => {
		root.render(
			<SheetGrid
				grid={model}
				label="Sheet"
				editorLabel="Cell entry"
			/>
		)
	})
	await settle()

	return model
}

function height(model: SheetGridModel, row: number): number {
	const layout = model.layout(model.getSnapshot().sheet)
	const at = layout?.rows.indices.indexOf(row) ?? -1

	return at < 0 ? (layout?.rows.defaultSize ?? -1) : (layout?.rows.sizes[at] ?? -1)
}

const cell = (row: number) => [{ startRow: row, startCol: 0, endRow: row, endCol: 0 }]

describe("rows fitted to wrapped text", () => {
	it("measures a wrapped cell's lines as the grid draws them, at 100 %", async () => {
		const model = await mount()
		const sheet = model.getSnapshot().sheet

		await model.command({ type: "format.apply", sheet, ranges: cell(0), patch: { wrap: true } })

		const measured = measureRows(model, sheet, new Set([0, 1]), new TextMeasurer(new RecordingCanvas()), "sans-serif", new Set())

		// "wrapped words of text" in 64 - 7 px: "wrapped " | "words of " | "text", three 18 px lines and 2 px.
		expect(measured === null ? null : [Array.from(measured.rows), Array.from(measured.heights)]).toEqual([[0], [56]])
	})

	it("grows a row when wrap goes on, shrinks it when the column widens or wrap goes off, and keeps hand-set heights", async () => {
		const model = await mount()
		const sheet = model.getSnapshot().sheet

		// At open nothing is fitted: a saved height shows as saved.
		expect([height(model, 0), height(model, 4)]).toEqual([20, 60])

		await model.command({
			type: "format.apply",
			sheet,
			ranges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 0 }],
			patch: { wrap: true }
		})
		await settle()
		expect([height(model, 0), height(model, 2)]).toEqual([56, 40])
		expect(parts(await savedBytes(sessionOf(model)))["xl/worksheets/sheet1.xml"]).toContain('<row r="1" ht="42">')

		await model.command({ type: "axis.resize", sheet, axis: "cols", indices: Uint32Array.of(0), sizes: Float32Array.of(120) })
		await settle()
		expect(height(model, 0)).toBe(38)

		await model.command({ type: "format.apply", sheet, ranges: cell(0), patch: { wrap: false } })
		await settle()
		expect(height(model, 0)).toBe(20)
		// A row whose text never wrapped keeps its saved height.
		expect(height(model, 4)).toBe(60)
	})

	it("fits wrap toggled on a whole column without a long task, the rows on screen only", async () => {
		const model = await mount()
		const sheet = model.getSnapshot().sheet
		const command = vi.spyOn(sessionOf(model), "command")
		const started = performance.now()

		await model.command({
			type: "format.apply",
			sheet,
			ranges: [{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 }],
			patch: { wrap: true }
		})
		await settle()

		const fits = command.mock.calls.filter(([sent]) => sent.type === "axis.fit")

		expect(fits.length).toBe(1)
		expect(fits[0]?.[0].type === "axis.fit" ? fits[0][0].rows.length : -1).toBeLessThanOrEqual(64)
		expect(height(model, 0)).toBe(56)
		expect(performance.now() - started).toBeLessThan(budget(1000))
	})
})
