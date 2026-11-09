import { describe, expect, it } from "vitest"
import type { TableRow } from "../core/presentation/model"
import { RenderReport } from "../core/presentation/render/effects"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { SLIDE, THEME, THEME_PART, body, deckOf, renderServices, xfrm } from "./fixtures/presentation/renderDeck"
import { FIXTURE_ADVANCE, FIXTURE_LINE_HEIGHT } from "./fixtures/presentation/textPage"

const EMU = 9525
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }
// The default cell margins (0.1in left and right, 0.05in top and bottom), px.
const MAR_LR = 9.6
const MAR_TB = 4.8

function table(rows: TableRow[]) {
	return deckOf(
		[],
		[],
		[
			{
				id: 5,
				name: "Table",
				hidden: false,
				kind: "frame",
				xfrm: xfrm(0, 0, 300 * EMU, 100 * EMU),
				frame: {
					kind: "table",
					table: {
						grid: [100 * EMU, 100 * EMU, 100 * EMU],
						rows,
						flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }
					}
				}
			}
		]
	)
}

describe("table cell text direction (tcPr vert)", () => {
	it("lays turned cells out in their turned box, grows the row to their lines and anchors across the cell", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const report = new RenderReport()
		const deck = table([
			{
				h: 50 * EMU,
				cells: [
					{ text: body("Hello world"), props: { vert: "vert" } },
					{ text: body("Hi"), props: { vert: "vert270", anchor: "ctr" } },
					{ text: body("X"), props: { vert: "wordArtVert" } }
				]
			},
			{ h: 50 * EMU, cells: [{ text: body(""), props: { vert: "vert" } }, { text: body("Plain") }, { text: body("") }] }
		])
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING, report)
		const rowEdges = render.layers[0]?.table?.rowEdges ?? []
		const line = "Hello world".length * FIXTURE_ADVANCE

		// The row grows to the turned cell's line length, not to its block (24 px) height.
		expect(rowEdges[1]).toBeCloseTo(line + 2 * MAR_TB, 4)

		const vertRequests = fixture.requests.filter(request => request.cell?.row === 0 && request.cell.column === 0)

		// Measured wrapping at the stored row height, then drawn in the turned box (the row's inner height by the cell's
		// inner width).
		expect(vertRequests.map(request => request.bodyPr.vertical)).toEqual(["vert", "vert"])
		expect(vertRequests[0]?.width).toBeCloseTo(50 - 2 * MAR_TB, 4)
		expect(vertRequests[0]?.height).toBe(0)
		expect(vertRequests[1]?.width).toBeCloseTo(line, 4)
		expect(vertRequests[1]?.height).toBeCloseTo(100 - 2 * MAR_LR, 4)

		const layerOf = (row: number, column: number) =>
			render.layers.find(layer => layer.cell?.[0] === row && layer.cell[1] === column && layer.textMatrix !== undefined)
		const near = (actual: readonly number[] | undefined, expected: readonly number[]): void => {
			expect(actual).toHaveLength(6)
			expected.forEach((value, k) => expect(actual?.[k]).toBeCloseTo(value, 4))
		}

		// vert: turned 90°, the page's top at the cell's right inner edge.
		near(layerOf(0, 0)?.textMatrix, [0, 1, -1, 0, 100 - MAR_LR, MAR_TB])
		// vert270 centred: turned 270°, the page's top at the left inner edge, moved right by half the spare width.
		near(layerOf(0, 1)?.textMatrix, [0, -1, 1, 0, 100 + MAR_LR + (100 - 2 * MAR_LR - FIXTURE_LINE_HEIGHT) / 2, MAR_TB + line])
		// Stacked WordArt is still drawn horizontally (and reported); the plain cell keeps its translate.
		near(layerOf(0, 2)?.textMatrix, [1, 0, 0, 1, 200 + MAR_LR, MAR_TB])
		near(layerOf(1, 1)?.textMatrix, [1, 0, 0, 1, 100 + MAR_LR, (rowEdges[1] ?? 0) + MAR_TB])
		expect(report.approximated.get("tableCell:vert")).toBe(1)

		// An empty turned cell still has its turned text box, so the editor types into it as it renders.
		const empty = layerOf(1, 0)

		expect(empty?.text).toBeUndefined()
		near(empty?.textMatrix, [0, 1, -1, 0, 100 - MAR_LR, (rowEdges[1] ?? 0) + MAR_TB])
		expect(layerOf(1, 2)).toBeUndefined()
	})

	it("lays an unwrapped turned cell out when its row stores no height", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const deck = table([
			{ h: 0, cells: [{ text: body("Long line"), props: { vert: "vert270" } }, { text: body("") }, { text: body("") }] }
		])
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const measure = fixture.requests.find(request => request.cell?.column === 0)

		expect(measure?.bodyPr.wrap).toBe(false)
		expect(render.layers[0]?.table?.rowEdges[1]).toBeCloseTo("Long line".length * FIXTURE_ADVANCE + 2 * MAR_TB, 4)
	})
})
