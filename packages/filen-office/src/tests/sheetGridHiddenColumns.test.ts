import { describe, expect, it } from "vitest"
import { TILE_COLS, type SheetLayout } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { frameTiles, gridView } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { openFixture } from "./sheetSessionFixtures"

// Text runs on across hidden columns and stops at content in one of them, however long the hidden run: the frame
// fetches the tiles of up to CARRY_COLUMNS (64) hidden columns from either shown side, and the run-on stops past
// that many, so the drawing never depends on which tiles the cache happens to hold.

const LONG = "a long text that runs on well past its own narrow cell and further still"

const column = (index: number): string => {
	let name = ""

	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name

	return name
}

// Columns B (1) to `lastHidden` hidden, A1 holding text, and `content` (a hidden column) of row 1 holding some.
const body = (lastHidden: number, content: number | null): string =>
	`<cols><col min="2" max="${String(lastHidden + 1)}" width="9" hidden="1" customWidth="1"/></cols><sheetData>` +
	`<row r="1"><c r="A1" t="inlineStr"><is><t>${LONG}</t></is></c>` +
	(content === null ? "" : `<c r="${column(content)}1" t="inlineStr"><is><t>x</t></is></c>`) +
	"</row>" +
	// A cell past the run, so the sheet's extent holds shown columns after it.
	`<row r="3"><c r="${column(lastHidden + 30)}3"><v>1</v></c></row></sheetData>`

const settle = async (): Promise<void> => {
	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function opened(lastHidden: number, content: number | null) {
	const { session, info } = await openFixture({ sheets: [{ name: "S", body: body(lastHidden, content) }] })
	const sheet = info.activeSheet
	const model = new SheetGridModel({ source: session, edit: session, info })

	model.need(sheet, [0, 0])
	await settle()

	const layout = model.layout(sheet) as SheetLayout
	const axes = model.axes(sheet)

	if (axes === null) throw new Error("no axes")

	const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 400)

	return { model, sheet, layout, view }
}

type Opened = Awaited<ReturnType<typeof opened>>

function frameTileCols({ model, layout, view }: Opened): Set<number> {
	return new Set(frameTiles(view, model.merges(layout)).filter((_, i) => i % 2 === 1))
}

// The draw calls of one cells frame.
function paint({ model, sheet, layout, view }: Opened): string {
	const canvas = new RecordingCanvas()

	paintCells(
		{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
		{ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }
	)

	return JSON.stringify(canvas.calls)
}

describe("text run-on over hidden columns", () => {
	it("stops at content in a wholly hidden tile column, with the cache cold and warm", async () => {
		// B:BL hidden: tile column 1 (AG:BL) has no shown column. AL1 holds content.
		const stopped = await opened(63, 37)

		expect(frameTileCols(stopped).has(1)).toBe(true)

		stopped.model.need(stopped.sheet, frameTiles(stopped.view, stopped.model.merges(stopped.layout)))
		await settle()

		expect(stopped.model.entry(stopped.sheet, 0, 37)).not.toBeNull()

		const cold = paint(stopped)
		const free = await opened(63, null)

		free.model.need(free.sheet, frameTiles(free.view, free.model.merges(free.layout)))
		await settle()

		// Without the hidden content the text runs on into the shown columns past the run.
		expect(paint(free)).not.toBe(cold)

		stopped.model.need(stopped.sheet, [...frameTiles(stopped.view, stopped.model.merges(stopped.layout)), 0, 1, 0, 2])
		await settle()

		expect(paint(stopped)).toBe(cold)
	})

	it("draws the same whether or not a tile past CARRY_COLUMNS hidden columns is held", async () => {
		// B:GR hidden (199 columns); content at CW1 (100), in tile column 3, which the frame does not fetch.
		const run = await opened(199, 100)

		expect(frameTileCols(run).has(3)).toBe(false)

		run.model.need(run.sheet, frameTiles(run.view, run.model.merges(run.layout)))
		await settle()

		const cold = paint(run)

		run.model.need(run.sheet, [...frameTiles(run.view, run.model.merges(run.layout)), 0, 3])
		await settle()

		expect(run.model.entry(run.sheet, 0, 100)).not.toBeNull()
		expect(paint(run)).toBe(cold)
	})

	it("fetches a bounded number of tile columns for a 16,000-column hidden run", async () => {
		const run = await opened(16_000, null)
		const tileCols = frameTileCols(run)

		// The shown A, 64 hidden columns from each side of the run, and the shown columns past it.
		expect(tileCols.has(0)).toBe(true)
		expect(tileCols.has(Math.floor(16_000 / TILE_COLS))).toBe(true)
		expect(tileCols.size).toBeLessThanOrEqual(10)
	})
})
