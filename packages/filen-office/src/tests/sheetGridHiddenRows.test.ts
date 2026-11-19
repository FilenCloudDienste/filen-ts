import { describe, expect, it } from "vitest"
import { CellFlag, TILE_ROWS, type SheetLayout } from "../core/sheet/protocol"
import type { GridAxis } from "../react/sheet/axis"
import { decoratePane, paintScene, type GridDecoration } from "../react/sheet/layers"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { paintChrome } from "../react/sheet/paint/chrome"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { cellSelection } from "../react/sheet/selection"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { frameTiles, gridView } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { openFixture } from "./sheetSessionFixtures"

// A big filtered sheet: a few rows shown far apart, everything between them hidden. A frame costs what it shows, not
// the span from its first shown row to its last: only tiles holding a shown row are asked for, and the painters
// step over the hidden runs.

const STEP = 8000
const SHOWN = Array.from({ length: 25 }, (_, k) => k * STEP)
// A merge whose first cell sits in a hidden row (a tile with no shown row), its last row shown; its first cell holds
// a formula, for a decorator to mark.
const MERGE_FIRST = 3 * STEP - 2
// Merges lying wholly in hidden rows: they ask for no tile.
const HIDDEN_MERGES = [5, 6, 7, 8, 9].map(k => k * STEP + 500)
const LAST_ROW = 199_999

const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

const BODY =
	"<sheetData>" +
	[...SHOWN.slice(0, 3), MERGE_FIRST, ...SHOWN.slice(3)]
		.map(
			row =>
				`<row r="${String(row + 1)}">${
					row === MERGE_FIRST
						? `<c r="A${String(row + 1)}" t="str"><f>"merged"</f><v>merged</v></c>`
						: inline(`A${String(row + 1)}`, `row ${String(row)}`)
				}</row>`
		)
		.join("") +
	`<row r="${String(LAST_ROW + 1)}"><c r="A${String(LAST_ROW + 1)}"><v>1</v></c></row>` +
	`</sheetData><mergeCells count="${String(1 + HIDDEN_MERGES.length)}">` +
	`<mergeCell ref="A${String(MERGE_FIRST + 1)}:B${String(3 * STEP + 1)}"/>` +
	HIDDEN_MERGES.map(row => `<mergeCell ref="A${String(row + 1)}:B${String(row + 3)}"/>`).join("") +
	"</mergeCells>"

// Wraps an axis to count how many indices are asked for their size.
function counting(axis: GridAxis): { axis: GridAxis; calls: () => number } {
	let calls = 0

	return {
		axis: {
			...axis,
			size: index => {
				calls++

				return axis.size(index)
			},
			hidden: index => {
				calls++

				return axis.hidden(index)
			}
		},
		calls: () => calls
	}
}

async function opened(): Promise<{ model: SheetGridModel; sheet: number; layout: SheetLayout }> {
	const { session, info } = await openFixture({ sheets: [{ name: "S", body: BODY }] })
	const sheet = info.activeSheet
	const model = new SheetGridModel({ source: session, edit: session, info })
	const spans: { start: number; end: number }[] = []

	for (let k = 0; k < SHOWN.length; k++)
		spans.push({ start: (SHOWN[k] ?? 0) + 1, end: k + 1 < SHOWN.length ? (SHOWN[k + 1] ?? 0) - 1 : LAST_ROW })

	// A command hides 65,536 rows at most: a few spans at a time.
	for (let k = 0; k < spans.length; k += 6) {
		const result = await model.command({ type: "axis.hide", sheet, axis: "rows", spans: spans.slice(k, k + 6), hidden: true })

		if (!result.ok) throw new Error("not hidden")
	}

	model.need(sheet, [0, 0])

	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const layout = model.layout(sheet)

	if (layout === null) throw new Error("no layout")

	return { model, sheet, layout }
}

describe("grid frames over hidden rows", () => {
	it("asks only for tiles holding a shown row and the tile of a merge's hidden first cell", async () => {
		const { model, sheet, layout } = await opened()
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		expect(axes.rows.count).toBeGreaterThan(LAST_ROW)

		const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 1000)
		const coordinates = frameTiles(view, model.merges(layout))
		const tileRows = new Set(coordinates.filter((_, i) => i % 2 === 0))

		expect(view.rows.first).toBe(0)
		expect(view.rows.last).toBeGreaterThan(LAST_ROW)
		// The span covers 3,000 tile rows; the shown rows sit in 25 of them, the rows past the last hidden one in a few.
		expect(tileRows.size).toBeLessThanOrEqual(SHOWN.length + 3)

		for (const row of SHOWN) expect(tileRows.has(Math.floor(row / TILE_ROWS))).toBe(true)

		expect(tileRows.has(Math.floor(MERGE_FIRST / TILE_ROWS))).toBe(true)

		for (const row of HIDDEN_MERGES) expect(tileRows.has(Math.floor(row / TILE_ROWS))).toBe(false)

		for (const tileRow of tileRows) {
			const holdsShown = Array.from({ length: TILE_ROWS }, (_, k) => tileRow * TILE_ROWS + k).some(
				row => row < axes.rows.count && !axes.rows.hidden(row)
			)
			const holdsAnchor = tileRow === Math.floor(MERGE_FIRST / TILE_ROWS)

			expect(holdsShown || holdsAnchor).toBe(true)
		}
	})

	it("paints the shown rows without walking the hidden ones, a merge's text from its hidden first cell included", async () => {
		const { model, sheet, layout } = await opened()
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 1000)

		model.need(sheet, frameTiles(view, model.merges(layout)))

		for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const rows = counting(axes.rows)
		const counted = gridView({ ...axes, rows: rows.axis }, layout, { top: 0, left: 0 }, 900, 1000)
		const canvas = new RecordingCanvas()

		paintCells(
			{ canvas, measurer: new TextMeasurer(canvas), borders: new BorderPainter(canvas), patterns: new PatternCache(() => null) },
			{ model, sheet, layout, view: counted, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1 }
		)

		const texts = canvas.calls.filter(call => call.op === "fillText").map(call => call.args[0])

		// The merge's shown last row draws the merge's text, not its own cell's.
		for (const row of SHOWN) if (row !== 3 * STEP) expect(texts).toContain(`row ${String(row)}`)

		expect(texts).toContain("merged")

		paintChrome(new RecordingCanvas(), {
			view: counted,
			theme: DEFAULT_THEME,
			pixelRatio: 1,
			rightToLeft: false,
			selection: cellSelection({ row: 0, col: 0 }, model.merges(layout)),
			merges: model.merges(layout),
			guide: null
		})

		// The span holds 200,000 rows: a walk index by index asks each of them at least once.
		expect(rows.calls()).toBeLessThan(5000)
	})

	it("decorates a partly shown merge anchored in a tile with no shown row once", async () => {
		const { model, sheet, layout } = await opened()
		const axes = model.axes(sheet)

		if (axes === null) throw new Error("no axes")

		const view = gridView(axes, layout, { top: 0, left: 0 }, 900, 1000)

		model.need(sheet, frameTiles(view, model.merges(layout)))

		for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const scene = paintScene({ model, sheet, layout, view, theme: DEFAULT_THEME, scale: 1, pixelRatio: 1, rightToLeft: false })
		const seen: GridDecoration[] = []
		const decorator = {
			id: "formula",
			mask: CellFlag.FORMULA,
			phase: "over" as const,
			paint: (_: unknown, cell: GridDecoration) => seen.push(cell)
		}

		for (const pane of scene.panes) decoratePane(new RecordingCanvas(), scene, [decorator], "over", pane.rows, pane.cols)

		expect(seen.map(cell => [cell.row, cell.col])).toEqual([[MERGE_FIRST, 0]])
	})
})
