import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList } from "../core/drawingml/displayList"
import { shapeEffects } from "../core/drawingml/fill"
import { D, drawingReader } from "../core/drawingml/reader"
import { parseXml } from "../core/xml/index"
import { RenderReport, layerEffects } from "../core/presentation/render/effects"
import { resolveTextEffects } from "../core/presentation/text/color"
import type { TableModel } from "../core/presentation/model"
import { renderSlide } from "../core/presentation/render/slide"
import { renderTable, renderTableSteps } from "../core/presentation/render/table"
import { NS, SLIDE, THEME, THEME_PART, body, deckOf, renderServices, xfrm } from "./fixtures/presentation/renderDeck"
import { cpuMs } from "./timing"

const EMU = 9525

const BANDED = `<a:tblStyleLst ${NS} def="{S}"><a:tblStyle styleId="{S}" styleName="T">
	<a:band1H><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="AAAAAA"/></a:solidFill></a:fill></a:tcStyle></a:band1H>
	<a:band2H><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="BBBBBB"/></a:solidFill></a:fill></a:tcStyle></a:band2H>
	<a:band1V><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="CCCCCC"/></a:solidFill></a:fill></a:tcStyle></a:band1V>
	<a:band2V><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill></a:fill></a:tcStyle></a:band2V>
</a:tblStyle></a:tblStyleLst>`

// Every cell claims the rest of the grid: within the reader's budgets, but each span meets every band.
function spanningTable(rows: number, columns: number): TableModel {
	return {
		grid: Array.from({ length: columns }, () => 2 * EMU),
		rows: Array.from({ length: rows }, () => ({
			h: 2 * EMU,
			cells: Array.from({ length: columns }, () => ({ text: body(""), gridSpan: columns, rowSpan: rows }))
		})),
		styleId: "{S}",
		flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: true }
	}
}

function input(table: TableModel) {
	const fixture = renderServices({ parts: { [THEME_PART]: THEME, "/ppt/tableStyles.xml": BANDED } }, { textHeight: 0 })
	const styles = fixture.services.xml("/ppt/tableStyles.xml")

	return {
		table,
		context: { list: new DrawingList(), theme: drawingTheme(undefined, () => undefined), images: () => undefined, effects: false },
		services: fixture.services,
		part: undefined,
		tableStyles: styles === undefined ? undefined : { document: styles, part: "/ppt/tableStyles.xml" },
		textHeight: () => 0
	}
}

describe("hostile tables", () => {
	it("draws a cell whose span covers later cells once, and skips the covered cells", () => {
		const rendered = renderTable(input(spanningTable(30, 300)))

		expect(rendered.cells.length).toBe(1)
		expect(rendered.cells[0]?.width).toBeCloseTo(600)
		expect(rendered.cells[0]?.height).toBeCloseTo(60)
	})

	it("renders a 30 × 300 table whose every cell spans the rest of the grid within the slide budget", { timeout: 30_000 }, () => {
		let best = Infinity

		for (let run = 0; run < 3; run++) {
			const started = cpuMs()

			renderTable(input(spanningTable(30, 300)))
			best = Math.min(best, cpuMs() - started)
		}

		expect(best).toBeLessThan(60)
	})

	it("cuts overlapping spans to the positions no earlier cell holds", () => {
		// Row 0: a cell spanning both rows of column 1; row 1: a cell claiming both columns, which column 1 already holds.
		const table: TableModel = {
			grid: [10 * EMU, 10 * EMU],
			rows: [
				{ h: 10 * EMU, cells: [{ text: body("") }, { text: body(""), rowSpan: 2 }] },
				{ h: 10 * EMU, cells: [{ text: body(""), gridSpan: 2 }, { text: body("") }] }
			],
			flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }
		}
		const rendered = renderTable(input(table))

		expect(rendered.cells.map(cell => [cell.row, cell.column, cell.width, cell.height])).toEqual([
			[0, 0, 10, 10],
			[0, 1, 10, 20],
			[1, 0, 10, 10]
		])
	})

	it("gives a sliced render a step per cell", () => {
		const table = spanningTable(4, 4)

		table.rows.forEach(row => row.cells.forEach(cell => Object.assign(cell, { gridSpan: 1, rowSpan: 1 })))

		const steps = renderTableSteps(input(table))
		let yields = 0

		for (let step = steps.next(); step.done !== true; step = steps.next()) yields++

		// Pass one (layout) and pass two (paint) per cell.
		expect(yields).toBe(32)
	})

	it("refuses a grid larger than the occupancy budget", () => {
		const table: TableModel = {
			grid: Array.from({ length: 1000 }, () => EMU),
			rows: Array.from({ length: 1001 }, () => ({ h: EMU, cells: [] })),
			flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }
		}

		expect(renderTable(input(table)).refused).toBe("tooLarge")
	})

	it("gives the host a turn inside one large table on a slide", async () => {
		const table = spanningTable(20, 20)

		table.rows.forEach(row => row.cells.forEach(cell => Object.assign(cell, { gridSpan: 1, rowSpan: 1 })))

		const fixture = renderServices({ parts: { [THEME_PART]: THEME, "/ppt/tableStyles.xml": BANDED } }, { textHeight: 0 })
		const deck = deckOf(
			[],
			[],
			[{ id: 5, name: "Table", hidden: false, kind: "frame", xfrm: xfrm(0, 0, 40 * EMU, 40 * EMU), frame: { kind: "table", table } }]
		)
		let clock = 0
		let pauses = 0

		// Every reading of the clock is a slice later, so each step is due.
		await renderSlide(deck, SLIDE, fixture.services, {
			pause: () => {
				pauses++

				return Promise.resolve()
			},
			sliceMs: 8,
			now: () => (clock += 8)
		})

		expect(pauses).toBeGreaterThan(400)
	})
})

const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const P = "http://schemas.openxmlformats.org/presentationml/2006/main"

describe("hostile effect lists", () => {
	const glows = '<a:glow rad="63500"><a:srgbClr val="FF0000"/></a:glow>'.repeat(5000)
	const shadows = '<a:outerShdw blurRad="1" dist="1"><a:srgbClr val="000000"/></a:outerShdw>'.repeat(3)
	const document = parseXml(
		new TextEncoder().encode(
			`<p:sp xmlns:p="${P}" xmlns:a="${A}"><p:spPr><a:effectLst>${glows}${shadows}<a:softEdge rad="1"/></a:effectLst></p:spPr></p:sp>`
		)
	)
	const reader = drawingReader(document)
	const context = { list: new DrawingList(), theme: drawingTheme(undefined, () => undefined), images: () => undefined, effects: true }

	it("reads the first effect of each kind and counts the rest", () => {
		const read = shapeEffects(context, reader, reader.child(document.documentElement(), D.P, "spPr"), undefined)

		expect(read.sources).toEqual(["glow", "outerShdw", "softEdge"])
		expect(read.repeated).toBe(5001)
	})

	it("reports the repeated effects a layer does not draw", () => {
		const report = new RenderReport()
		const effects = layerEffects(context, reader, document.documentElement(), report)

		expect(effects?.map(effect => effect.kind)).toEqual(["glow", "softEdge"])
		expect(report.toJSON().approximated["effectLst:repeated"]).toBe(5001)
	})
})

describe("hostile text effects", () => {
	it("resolves one text effect of each kind from an edited list", () => {
		const glow = { kind: "glow" as const, color: { kind: "srgb" as const, rgb: "FF0000" }, rad: 63500 }
		const resolved = resolveTextEffects(
			{ effects: [...Array.from({ length: 5000 }, () => glow), { kind: "softEdge", rad: 1 }] },
			() => 0xff0000ff
		)

		expect(resolved.map(effect => effect.kind)).toEqual(["glow", "softEdge"])
	})
})
