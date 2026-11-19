import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SheetSessionApi } from "../core/sheet/protocol"
import type { SheetChartEdit } from "../core/xlsx/charts/edit"
import { readChartInfo } from "../core/xlsx/charts/model"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { changeOf, refusalOf } from "./sheetNotesFixtures"
import { buildFixture } from "./sheetSessionFixtures"
import {
	CHART_PART,
	KEPT,
	SHEET_CHART_PART,
	SOLD,
	barChart,
	chartFixture,
	openCharts,
	partText,
	withChartsheet
} from "./sheetChartFixtures"

// The chart editor's edits of a chart part: type, title, legend, data labels, axes and series, each written in
// schema order with everything else as written, undone exactly, and refused where the part holds what an edit would
// lose. Every edited part is checked against the ECMA-376 chart schema when xmllint and the schemas are there.

const MISSING = xsdOracleMissing()
let oracle: XsdOracle | null = null

beforeAll(() => {
	oracle = MISSING === undefined ? new XsdOracle() : null
})

afterAll(() => {
	oracle?.dispose()
})

function valid(text: string): void {
	if (oracle === null) return

	expect([...(oracle.validate([encodeUtf8(text)])[0]?.keys() ?? [])]).toEqual([])
}

async function saved(session: SheetSessionApi): Promise<string> {
	const result = await session.save()

	if (!result.ok) throw new Error(result.message)

	return partText(result.bytes, CHART_PART)
}

async function edited(
	edit: SheetChartEdit,
	chart = barChart([SOLD, KEPT])
): Promise<{ session: SheetSessionApi; sheet: number; text: string; source: string }> {
	const { session, sheets, bytes } = await openCharts(chartFixture(chart))
	const sheet = sheets[0] ?? 0

	changeOf(await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit }))

	const text = await saved(session)

	valid(text)

	return { session, sheet, text, source: partText(bytes, CHART_PART) }
}

function info(text: string) {
	const read = readChartInfo(parseXml(encodeUtf8(text)))

	if (read === null) throw new Error("no chart")

	return read
}

describe("chart editing", () => {
	it("reads a chart for the editor: plots, series and their cells, axes, title and legend", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT], { title: "Fruit" })))
		const got = await session.query("chart.get", { sheet: sheets[0] ?? 0, part: CHART_PART })

		expect(got?.refusal).toBeNull()
		expect(got?.info.title).toBe("Fruit")
		expect(got?.info.legend).toBe("r")
		expect(got?.info.plots.map(plot => [plot.type, plot.grouping])).toEqual([["column", "clustered"]])
		expect(got?.info.plots[0]?.series.map(series => [series.name, series.nameRef, series.categories, series.values])).toEqual([
			["Sold", "Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4"],
			["Kept", "Data!$C$1", "Data!$A$2:$A$4", "Data!$C$2:$C$4"]
		])
		expect(got?.info.axes.map(axis => [axis.id, axis.kind, axis.position])).toEqual([
			[111, "cat", "b"],
			[222, "val", "l"]
		])
		// A part the sheet does not show is no chart of it.
		expect(await session.query("chart.get", { sheet: sheets[1] ?? 0, part: CHART_PART })).toBeNull()
		session.close()
	})

	it("sets the title text keeping its run properties, shows the automatic one, and removes it", async () => {
		const chart = barChart([SOLD], { title: "Old" })
		const set = await edited({ kind: "title", text: "Sales <2024>\nby fruit" }, chart)

		expect(set.text).toContain('<a:r><a:rPr lang="en-GB" b="1"/><a:t>Sales &lt;2024&gt;</a:t></a:r>')
		expect(info(set.text).title).toBe("Sales <2024>\nby fruit")
		set.session.close()

		const removed = await edited({ kind: "title", text: null }, chart)

		expect(removed.text).not.toContain("<c:title>")
		expect(removed.text).toContain('<c:autoTitleDeleted val="1"/>')
		removed.session.close()

		const added = await edited({ kind: "title", text: "New" })

		expect(added.text).toMatch(/<c:chart><c:title><c:tx><c:rich xmlns:a="[^"]+"><a:bodyPr\/>/)
		expect(added.text).toContain('<c:autoTitleDeleted val="0"/>')
		added.session.close()
	})

	it("moves and removes the legend", async () => {
		const moved = await edited({ kind: "legend", position: "b" })

		expect(info(moved.text).legend).toBe("b")
		moved.session.close()

		const removed = await edited({ kind: "legend", position: null })

		expect(info(removed.text).legend).toBeNull()
		removed.session.close()
	})

	it("sets an axis's bounds, units, format, title, visibility and gridlines in schema order", async () => {
		const { text, session } = await edited({
			kind: "axis",
			axis: 222,
			patch: { min: 0, max: 10, major: 2, format: '0.0"kg"', title: "Count", gridlines: false }
		})
		const axis = info(text).axes.find(entry => entry.id === 222)

		expect(axis).toMatchObject({ min: 0, max: 10, major: 2, format: '0.0"kg"', title: "Count", majorGridlines: false })
		expect(text).toContain('<c:scaling><c:orientation val="minMax"/><c:max val="10"/><c:min val="0"/></c:scaling>')
		session.close()
	})

	it("refuses bounds that cross, units that are not positive and bounds on a category axis", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD])))
		const sheet = sheets[0] ?? 0
		const edit = (patch: object, axis = 222) =>
			session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: { kind: "axis", axis, patch } })

		// A value the user typed and can correct, refused as the value, not the chart.
		expect(refusalOf(await edit({ min: 5, max: 1 }))).toBe("chartValue")
		expect(refusalOf(await edit({ min: 3, max: 3 }))).toBe("chartValue")
		expect(refusalOf(await edit({ major: 0 }))).toBe("chartValue")
		expect(refusalOf(await edit({ minor: -1 }))).toBe("chartValue")
		expect(refusalOf(await edit({ min: Number.NaN }))).toBe("chartValue")
		expect(refusalOf(await edit({ major: Number.POSITIVE_INFINITY }))).toBe("chartValue")
		// What the editor cannot change on this chart.
		expect(refusalOf(await edit({ min: 0 }, 111))).toBe("chartUnsupported")
		session.close()
	})

	it("shows data labels on every series, at a position the type allows", async () => {
		const { text, session } = await edited({
			kind: "labels",
			plot: null,
			labels: { value: true, category: false, series: false, percent: false, position: "outEnd" }
		})

		expect(info(text).plots[0]?.series.every(series => series.labels?.value === true && series.labels.position === "outEnd")).toBe(true)
		session.close()

		const { session: other, sheets } = await openCharts(chartFixture(barChart([SOLD])))

		expect(
			refusalOf(
				await other.command({
					type: "chart.edit",
					sheet: sheets[0] ?? 0,
					part: CHART_PART,
					edit: {
						kind: "labels",
						plot: 0,
						labels: { value: true, category: false, series: false, percent: false, position: "t" }
					}
				})
			)
		).toBe("chartUnsupported")
		other.close()
	})

	it.each([
		["stacked", false],
		["percentStacked", false],
		["clustered", true]
	] as const)("drops an outside-end label position a %s grouping does not allow", async (grouping, kept) => {
		const { session, sheet } = await edited({
			kind: "labels",
			plot: null,
			labels: { value: true, category: false, series: false, percent: false, position: "outEnd" }
		})

		expect(await saved(session)).toContain('<c:dLblPos val="outEnd"/>')
		changeOf(
			await session.command({
				type: "chart.edit",
				sheet,
				part: CHART_PART,
				edit: { kind: "type", plot: 0, type: "column", grouping }
			})
		)

		const text = await saved(session)

		valid(text)
		expect(info(text).plots[0]?.grouping).toBe(grouping)
		expect(text.includes('<c:dLblPos val="outEnd"/>')).toBe(kept)
		session.close()
	})

	it("changes a column chart into a line chart, keeping series ids and their cells", async () => {
		const extension =
			'<c:extLst><c:ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}" xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart"><c16:uniqueId val="{00000000-0001}"/></c:ext></c:extLst>'
		const chart = barChart([{ ...SOLD, extra: extension }, KEPT])
		const { text, session } = await edited({ kind: "type", plot: 0, type: "line" }, chart)
		const read = info(text)

		expect(read.plots.map(plot => [plot.element, plot.type, plot.grouping])).toEqual([["lineChart", "line", "standard"]])
		expect(read.plots[0]?.series.map(series => series.values)).toEqual(["Data!$B$2:$B$4", "Data!$C$2:$C$4"])
		expect(text).toContain("c16:uniqueId")
		expect(text).not.toContain("invertIfNegative")
		expect(read.axes.map(axis => axis.kind)).toEqual(["cat", "val"])
		session.close()
	})

	it("turns columns into bars by turning the axes, and stacks them", async () => {
		const { text, session } = await edited({ kind: "type", plot: 0, type: "bar", grouping: "stacked" })
		const read = info(text)

		expect(read.plots[0]?.type).toBe("bar")
		expect(read.plots[0]?.grouping).toBe("stacked")
		expect(text).toContain('<c:overlap val="100"/>')
		expect(read.axes.map(axis => [axis.kind, axis.position])).toEqual([
			["cat", "l"],
			["val", "b"]
		])
		session.close()
	})

	it("makes a pie without axes, and a column chart of a pie with new ones", async () => {
		const pie = await edited({ kind: "type", plot: 0, type: "pie" })
		const read = info(pie.text)

		expect(read.plots[0]?.element).toBe("pieChart")
		expect(read.axes).toEqual([])
		expect(pie.text).toContain('<c:varyColors val="1"/>')
		pie.session.close()

		const back = await edited({ kind: "type", plot: 0, type: "column" }, pie.text)
		const axes = info(back.text).axes

		expect(axes.map(axis => [axis.kind, axis.position])).toEqual([
			["cat", "b"],
			["val", "l"]
		])
		expect(info(back.text).plots[0]?.axes).toEqual(axes.map(axis => axis.id))
		back.session.close()
	})

	it("makes a scatter chart of x and y values on two value axes", async () => {
		const { text, session } = await edited({ kind: "type", plot: 0, type: "scatter" })

		expect(text).toContain("<c:xVal><c:strRef><c:f>Data!$A$2:$A$4</c:f>")
		expect(text).toContain("<c:yVal><c:numRef><c:f>Data!$B$2:$B$4</c:f>")
		expect(info(text).axes.map(axis => axis.kind)).toEqual(["val", "val"])
		expect(text).toContain('<c:crossBetween val="midCat"/>')
		session.close()
	})

	it("adds, sets, moves and removes series", async () => {
		const added = await edited(
			{ kind: "series.add", plot: 0, name: "=Other!A1", categories: "A2:A4", values: "=Data!C2:C4" },
			barChart([SOLD])
		)
		const series = info(added.text).plots[0]?.series ?? []

		expect(series.map(entry => [entry.idx, entry.order, entry.nameRef, entry.categories, entry.values])).toEqual([
			[0, 0, "Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4"],
			[1, 1, "Other!$A$1", "Data!$A$2:$A$4", "Data!$C$2:$C$4"]
		])
		// Its caches come from the cells.
		expect(added.text).toContain('<c:f>Other!$A$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>9</c:v></c:pt></c:strCache>')
		added.session.close()

		// A name without "=" is the name itself, though it reads like a cell.
		const set = await edited({ kind: "series.set", series: 1, name: "Q1", values: "Data!$B$3:$B$4" })

		expect(info(set.text).plots[0]?.series[1]).toMatchObject({ name: "Q1", nameRef: null, values: "Data!$B$3:$B$4" })
		set.session.close()

		const moved = await edited({ kind: "series.move", series: 1, to: 0 })

		expect(info(moved.text).plots[0]?.series.map(entry => [entry.name, entry.order])).toEqual([
			["Kept", 0],
			["Sold", 1]
		])
		moved.session.close()

		const removed = await edited({ kind: "series.remove", series: 0 })

		expect(info(removed.text).plots[0]?.series.map(entry => entry.name)).toEqual(["Kept"])
		removed.session.close()
	})

	it("gives an added series an idx and order no series of the chart has, the ones Excel keeps filtered out included", async () => {
		const filtered =
			'<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"><c15:filteredBarSeries><c15:ser><c:idx val="2"/><c:order val="2"/><c:tx><c:v>Hidden</c:v></c:tx><c:invertIfNegative val="0"/><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c15:ser></c15:filteredBarSeries></c:ext></c:extLst>'
		const added = await edited(
			{ kind: "series.add", plot: 0, name: "New", categories: null, values: "=Data!$C$2:$C$4" },
			barChart([SOLD, KEPT], { plotExtra: filtered })
		)

		expect([...added.text.matchAll(/<c:idx val="(\d+)"\/>/g)].map(match => match[1])).toEqual(["0", "1", "3", "2"])
		expect([...added.text.matchAll(/<c:order val="(\d+)"\/>/g)].map(match => match[1])).toEqual(["0", "1", "3", "2"])
		added.session.close()
	})

	it("acts on the series an edit names by its id, and refuses once that series is gone", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT, { ...KEPT, name: "Data!$A$1" }])))
		const sheet = sheets[0] ?? 0
		const remove = { kind: "series.remove", series: 1, id: 1 } as const

		// The same click twice: the second, sent before the editor read the chart again, still names series 1.
		changeOf(await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: remove }))
		expect(refusalOf(await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: remove }))).toBe("chartUnsupported")
		changeOf(
			await session.command({
				type: "chart.edit",
				sheet,
				part: CHART_PART,
				edit: { kind: "series.set", series: 2, id: 2, name: "Third" }
			})
		)

		const series = info(await saved(session)).plots[0]?.series ?? []

		expect(series.map(entry => [entry.idx, entry.name])).toEqual([
			[0, "Sold"],
			[2, "Third"]
		])
		session.close()
	})

	it("refuses a series range that names no cells of the workbook", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD])))
		const sheet = sheets[0] ?? 0

		for (const values of ["Nowhere!A1:A3", "SUM(A1:A3)", "[1]Data!A1", ""])
			expect(
				refusalOf(
					await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: { kind: "series.set", series: 0, values } })
				)
			).toBe("formula")

		session.close()
	})

	it("refuses to rewrite what holds an extension it does not know, and keeps the part", async () => {
		const unknown = '<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><x/></c:ext></c:extLst>'
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD], { plotExtra: unknown })))
		const sheet = sheets[0] ?? 0

		expect(
			refusalOf(await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: { kind: "type", plot: 0, type: "line" } }))
		).toBe("chartUnsupported")
		// What does not touch that element still edits.
		changeOf(await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: { kind: "legend", position: "t" } }))
		expect(await saved(session)).toContain(unknown)
		await session.undo()
		expect(await saved(session)).toBe(partText(bytes, CHART_PART))
		session.close()
	})

	it("undoes and redoes an edit exactly", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const sheet = sheets[0] ?? 0

		changeOf(await session.command({ type: "chart.edit", sheet, part: CHART_PART, edit: { kind: "type", plot: 0, type: "area" } }))

		const after = await saved(session)

		await session.undo()
		expect(await saved(session)).toBe(partText(bytes, CHART_PART))
		await session.redo()
		expect(await saved(session)).toBe(after)
		session.close()
	})
})

describe("chartsheets", () => {
	it("finds a chartsheet's chart and its size, draws it and edits it there only", async () => {
		const bytes = withChartsheet(buildFixture(chartFixture(barChart([SOLD]))), barChart([SOLD, KEPT]))
		const { session, sheets } = await openCharts(bytes)
		const graph = sheets[2] ?? 0

		expect(await session.query("chart.sheet", { sheet: graph })).toEqual({
			part: SHEET_CHART_PART,
			width: 5_486_400,
			height: 3_657_600
		})
		expect(await session.query("chart.sheet", { sheet: sheets[0] ?? 0 })).toBeNull()
		expect((await session.query("chart.render", { part: SHEET_CHART_PART, width: 5_486_400, height: 3_657_600 })).kind).toBe("drawing")

		changeOf(
			await session.command({
				type: "chart.edit",
				sheet: graph,
				part: SHEET_CHART_PART,
				edit: { kind: "title", text: "On its own sheet" }
			})
		)
		// A chart another sheet shows is not this sheet's to edit.
		expect(
			refusalOf(
				await session.command({ type: "chart.edit", sheet: graph, part: CHART_PART, edit: { kind: "legend", position: null } })
			)
		).toBe("chartUnsupported")

		const result = await session.save()

		if (!result.ok) throw new Error(result.message)

		const text = partText(result.bytes, SHEET_CHART_PART)

		expect(info(text).title).toBe("On its own sheet")
		valid(text)
		session.close()
	})
})
