// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { SheetGridModel } from "../react/sheet/model"
import { renderPrintPage } from "../react/sheet/print/printJob"
import { layOutPrint, pageCount } from "../react/sheet/print/printLayout"
import { KEPT, SOLD, barChart, chartFixture, withChartsheet } from "./sheetChartFixtures"
import { openFixture } from "./sheetSessionFixtures"
import { buildFixture } from "./xlsxWriteFixtures"

// The browser's print of a chartsheet: its chart on a page of its own, at its size from the top left of the area
// inside the margins, never stretched.

describe("a printed chartsheet", () => {
	it("is one page drawing the chart at its own size inside the margins", async () => {
		const { session, info } = await openFixture(withChartsheet(buildFixture(chartFixture(barChart([SOLD]))), barChart([SOLD, KEPT])))

		for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const graph = info.sheets.find(sheet => sheet.name === "Graph")

		if (graph === undefined) throw new Error("no chartsheet")

		const settings = await session.query("print.settings", { sheet: graph.id })

		if (settings?.chart === undefined) throw new Error("no chart")

		const model = new SheetGridModel({ source: session, edit: session, info })
		const job = await layOutPrint(
			model,
			[{ sheet: graph.id, name: "Graph", setup: settings.setup, ranges: [], used: null, chart: settings.chart }],
			(_font, text) => text.length * 6
		)

		expect(pageCount(job)).toBe(1)

		const svg = (await renderPrintPage({ job, values: { date: "", time: "", file: "b.xlsx", path: "" }, id: "c" }, 0)) ?? ""

		// Letter portrait, normal margins (0.7 in, 0.75 in): 6 x 4 in fits as it is.
		expect(svg).toContain('<g transform="translate(50.4 54)">')
		expect(svg).toMatch(/<svg[^>]* width="432" height="288"/)
		job.dispose()
		session.close()
	})
})
