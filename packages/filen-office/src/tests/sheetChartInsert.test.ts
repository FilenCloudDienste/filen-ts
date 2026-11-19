import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { unzipSync } from "fflate"
import { chartLayout, chartSource, newChartPart } from "../core/xlsx/charts/create"
import type { ChartCell, ChartSheetCells } from "../core/xlsx/charts/cache"
import { readChartInfo } from "../core/xlsx/charts/model"
import { assertWellFormed, decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"
import { XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { changeOf } from "./sheetNotesFixtures"
import { CHART_PART, KEPT, SOLD, barChart, chartFixture, openCharts, partText } from "./sheetChartFixtures"

// A chart inserted from a range (the series and labels read as Excel reads a selection), with its part, its frame in
// the sheet's drawing, the relationships and content type; and a chart frame deleted with the parts only it has.

const MISSING = xsdOracleMissing()
let oracle: XsdOracle | null = null

beforeAll(() => {
	oracle = MISSING === undefined ? new XsdOracle() : null
})

afterAll(() => {
	oracle?.dispose()
})

function sheetOf(rows: readonly (readonly (string | number | null)[])[]): ChartSheetCells {
	const cell = (value: string | number | null | undefined): ChartCell =>
		value === null || value === undefined
			? { kind: "empty", number: Number.NaN, text: "", format: "General" }
			: typeof value === "number"
				? { kind: "number", number: value, text: String(value), format: "General" }
				: { kind: "text", number: Number.NaN, text: value, format: "General" }

	return {
		lastRow: rows.length - 1,
		lastCol: 9,
		cell: (row, col) => cell(rows[row]?.[col]),
		hidden: () => false,
		hiddenRow: () => false,
		hiddenCol: () => false
	}
}

const range = (endRow: number, endCol: number) => ({ startRow: 0, startCol: 0, endRow, endCol })

describe("chart insertion", () => {
	it("reads a selection as Excel does: more rows than columns makes each column a series", () => {
		const table = sheetOf([
			["Fruit", "Sold", "Kept"],
			["Apple", 3, 1],
			["Pear", 5, 2],
			["Plum", 7, 4]
		])

		expect(chartLayout(table, range(3, 2), "column")).toEqual({ byColumns: true, nameLine: true, categoryLine: true })
		// As many rows as columns: each row is a series.
		expect(
			chartLayout(
				sheetOf([
					[null, "Q1", "Q2"],
					["East", 1, 2],
					["West", 3, 4]
				]),
				range(2, 2),
				"column"
			)
		).toEqual({
			byColumns: false,
			nameLine: true,
			categoryLine: true
		})
		// Numbers only: no labels.
		expect(
			chartLayout(
				sheetOf([
					[1, 2],
					[3, 4],
					[5, 6]
				]),
				range(2, 1),
				"line"
			)
		).toEqual({ byColumns: true, nameLine: false, categoryLine: false })
	})

	it("plots every value of a single numeric column or row, and names the series only by text in the first cell", () => {
		const column = sheetOf([[5], [1], [2], [3], [4], [6], [7], [8], [9], [10]])
		const columnLayout = chartLayout(column, range(9, 0), "column")

		expect(columnLayout).toEqual({ byColumns: true, nameLine: false, categoryLine: false })
		expect(chartSource("Data", range(9, 0), columnLayout, "column").series).toEqual([{ name: null, values: "Data!$A$1:$A$10" }])

		const row = sheetOf([[5, 1, 2, 3, 4, 6, 7, 8, 9, 10]])
		const rowLayout = chartLayout(row, range(0, 9), "column")

		expect(rowLayout).toEqual({ byColumns: false, nameLine: false, categoryLine: false })
		expect(chartSource("Data", range(0, 9), rowLayout, "column").series).toEqual([{ name: null, values: "Data!$A$1:$J$1" }])

		// A text header over one numeric column stays the series name.
		const named = chartLayout(sheetOf([["Sales"], [1], [2], [3]]), range(3, 0), "column")

		expect(named.nameLine).toBe(true)
		expect(chartSource("Data", range(3, 0), named, "column").series).toEqual([{ name: "Data!$A$1", values: "Data!$A$2:$A$4" }])
		expect(chartLayout(sheetOf([["Sales", 1, 2, 3]]), range(0, 3), "column").nameLine).toBe(true)

		// An empty first cell over numbers is no name.
		const blank = chartLayout(sheetOf([[null], [1], [2], [3]]), range(3, 0), "column")

		expect(blank.nameLine).toBe(false)
		expect(chartSource("Data", range(3, 0), blank, "column").series).toEqual([{ name: null, values: "Data!$A$1:$A$4" }])
		expect(chartLayout(sheetOf([[null, 1, 2, 3]]), range(0, 3), "column").nameLine).toBe(false)
		// A scatter of one numeric column is one series of every value.
		expect(chartSource("Data", range(9, 0), chartLayout(column, range(9, 0), "scatter"), "scatter")).toEqual({
			categories: null,
			series: [{ name: null, values: "Data!$A$1:$A$10" }]
		})
	})

	it("writes formulas with characters XML cannot carry as well-formed markup", () => {
		const part = newChartPart(
			{ categories: "'A\u0001'!$A$2:$A$4", series: [{ name: "'A\u0001'!$B$1", values: "'A\u0001'!$B$2:$B$4" }] },
			"column",
			undefined,
			{ strict: false, date1904: false, numericCategories: false }
		)

		expect(() => {
			assertWellFormed(parseXml(part))
		}).not.toThrow()
		expect(decodeUtf8(part)).toContain("<c:f>'A\ufffd'!$B$1</c:f>")
	})

	it("inserts a chart of the selection: part, frame, relationships and content type, valid and saved", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const sheet = sheets[0] ?? 0

		changeOf(
			await session.command({
				type: "chart.insert",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
				chart: "column",
				placement: { from: { row: 5, col: 4, rowOff: 0, colOff: 0 } }
			})
		)

		const layout = await session.layout(sheet)
		const frames = layout.extensions?.drawings?.objects.filter(object => object.kind === "chart") ?? []

		expect(frames.map(object => object.chartPart)).toEqual([CHART_PART, "xl/charts/chart2.xml"])

		const result = await session.save()

		if (!result.ok) throw new Error(result.message)

		const files = unzipSync(result.bytes)
		const chart = decodeUtf8(files["xl/charts/chart2.xml"] ?? new Uint8Array(0))
		const read = readChartInfo(parseXml(encodeUtf8(chart)))

		expect(read?.plots[0]?.series.map(series => [series.name, series.categories, series.values])).toEqual([
			["Sold", "Data!$A$2:$A$4", "Data!$B$2:$B$4"],
			["Kept", "Data!$A$2:$A$4", "Data!$C$2:$C$4"]
		])
		expect(chart).toContain('<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>3</c:v></c:pt>')
		expect(decodeUtf8(files["[Content_Types].xml"] ?? new Uint8Array(0))).toContain(
			'<Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
		)
		expect(decodeUtf8(files["xl/drawings/_rels/drawing1.xml.rels"] ?? new Uint8Array(0))).toMatch(
			/Type="[^"]*\/chart" Target="\.\.\/charts\/chart2\.xml"/
		)
		expect(decodeUtf8(files["xl/drawings/drawing1.xml"] ?? new Uint8Array(0))).toContain(
			'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id='
		)

		if (oracle !== null)
			for (const name of ["xl/charts/chart2.xml", "xl/drawings/drawing1.xml"])
				expect([...(oracle.validate([files[name] ?? new Uint8Array(0)])[0]?.keys() ?? [])]).toEqual([])

		// The insert undoes completely.
		await session.undo()

		const undone = await session.save()

		if (!undone.ok) throw new Error(undone.message)

		expect(Object.keys(unzipSync(undone.bytes))).not.toContain("xl/charts/chart2.xml")
		session.close()
	})

	it("inserts every type it offers, each valid against the schema", async () => {
		for (const type of ["column", "bar", "line", "area", "pie", "doughnut", "scatter"] as const) {
			const { session, sheets } = await openCharts(chartFixture(barChart([SOLD])))

			changeOf(
				await session.command({
					type: "chart.insert",
					sheet: sheets[0] ?? 0,
					range: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
					chart: type,
					placement: { from: { row: 5, col: 4, rowOff: 0, colOff: 0 } }
				})
			)

			const result = await session.save()

			if (!result.ok) throw new Error(result.message)

			const chart = partText(result.bytes, "xl/charts/chart2.xml")

			expect(readChartInfo(parseXml(encodeUtf8(chart)))?.plots[0]?.type).toBe(type)

			if (oracle !== null) expect([...(oracle.validate([encodeUtf8(chart)])[0]?.keys() ?? [])]).toEqual([])

			session.close()
		}
	})

	it("deletes a chart frame with its chart part and the style and colours only it has", async () => {
		const style =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="201"/>'
		const fixture = chartFixture(barChart([SOLD]), {
			"xl/charts/style1.xml": { text: style, type: "application/vnd.ms-office.chartstyle+xml" },
			"xl/charts/_rels/chart1.xml.rels": {
				text:
					'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
					'<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/chartStyle" Target="style1.xml"/></Relationships>',
				type: "application/vnd.openxmlformats-package.relationships+xml"
			}
		})
		const { session, sheets } = await openCharts(fixture)
		const sheet = sheets[0] ?? 0
		const frame = (await session.layout(sheet)).extensions?.drawings?.objects.find(object => object.kind === "chart")

		if (frame === undefined) throw new Error("no chart frame")

		changeOf(await session.command({ type: "drawing.delete", sheet, objects: [{ key: frame.key, stamp: frame.stamp }] }))

		const result = await session.save()

		if (!result.ok) throw new Error(result.message)

		const names = Object.keys(unzipSync(result.bytes))

		expect(names).not.toContain(CHART_PART)
		expect(names).not.toContain("xl/charts/style1.xml")
		expect(names).not.toContain("xl/charts/_rels/chart1.xml.rels")
		session.close()
	})
})
