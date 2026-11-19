import { describe, expect, it } from "vitest"
import { refreshChartCaches, type ChartCell, type ChartCells } from "../core/xlsx/charts/cache"
import { numericCells } from "../core/xlsx/charts/formulas"
import { chartAreas } from "../core/xlsx/charts/refs"
import { encodeUtf8 } from "../core/xml/index"
import { changeOf } from "./sheetNotesFixtures"
import { cells } from "./sheetSessionFixtures"
import { CHART_PART, KEPT, SOLD, barChart, chartFixture, openCharts, partText } from "./sheetChartFixtures"

// A chart's cached values (c:numCache, c:strCache) read again from its cells: at once where it is drawn, and at save
// for every chart whose cells an edit changed. A chart whose cells nobody changed keeps its bytes.

function grid(values: Record<string, string | number>, hiddenRows: readonly number[] = [], hiddenCols: readonly number[] = []): ChartCells {
	const cell = (value: string | number | undefined): ChartCell =>
		value === undefined
			? { kind: "empty", number: Number.NaN, text: "", format: "General" }
			: typeof value === "number"
				? { kind: "number", number: value, text: String(value), format: "General" }
				: { kind: "text", number: Number.NaN, text: value, format: "General" }

	return {
		names: () => undefined,
		sheet: name =>
			name.toUpperCase() === "DATA"
				? {
						lastRow: 9,
						lastCol: 9,
						cell: (row, col) => cell(values[`${String.fromCharCode(65 + col)}${String(row + 1)}`]),
						hidden: (row, col) => hiddenRows.includes(row) || hiddenCols.includes(col),
						hiddenRow: row => hiddenRows.includes(row),
						hiddenCol: col => hiddenCols.includes(col)
					}
				: null
	}
}

const CELLS = { A2: "Apple", A3: "Pear", A4: "Plum", B1: "Sold", B2: 3, B3: 5, B4: 7, C1: "Kept", C2: 1, C3: 2, C4: 4 }

async function save(
	session: Awaited<ReturnType<typeof openCharts>>["session"]
): Promise<{ bytes: Uint8Array; changedParts: readonly string[] }> {
	const saved = await session.save()

	if (!saved.ok) throw new Error(saved.message)

	return { bytes: saved.bytes, changedParts: saved.changedParts }
}

describe("chart references", () => {
	it("reads ranges, unions and names, and nothing else", () => {
		const names = (name: string): string | undefined => (name === "Sales" ? "Data!$B$2:$B$4" : undefined)

		expect(chartAreas("Data!$B$2:$B$4", null)).toEqual([{ sheet: "Data", range: { startRow: 1, startCol: 1, endRow: 3, endCol: 1 } }])
		expect(chartAreas("('My Data'!$A$1,'My Data'!$A$3:$A$4)", null)?.map(area => area.range.startRow)).toEqual([0, 2])
		expect(chartAreas("[0]!Sales", names)?.[0]?.sheet).toBe("Data")
		expect(chartAreas("Sales", names)?.length).toBe(1)
		expect(chartAreas("'[1]Other book'!$A$1", null)).toBeNull()
		expect(chartAreas("SUM(Data!A1)", null)).toBeNull()
		expect(chartAreas("$A$1", null)).toBeNull()
	})

	it("gives up on names of unions nested past the budget instead of building their product", () => {
		const union = (piece: string): string => `(${Array.from({ length: 200 }, () => piece).join(",")})`
		const nested: Record<string, string> = { A: union("B"), B: union("C"), C: union("D"), D: union("Data!$A$1") }
		let lookups = 0
		const names = (name: string): string | undefined => {
			lookups++

			return nested[name]
		}
		const started = performance.now()

		expect(chartAreas("A", names)).toBeNull()
		expect(lookups).toBeLessThanOrEqual(1024)
		expect(performance.now() - started).toBeLessThan(1000)

		const budget = { left: 1024 }

		expect(chartAreas("A", names, 0, budget)).toBeNull()
		expect(budget.left).toBeLessThan(0)
	})

	it("still reads a two-level union of names", () => {
		const nested: Record<string, string> = { Both: "(Left,Right)", Left: "(Data!$A$1,Data!$A$2:$A$3)", Right: "Data!$B$1" }

		expect(chartAreas("Both", name => nested[name])?.map(area => [area.sheet, area.range.startRow, area.range.startCol])).toEqual([
			["Data", 0, 0],
			["Data", 1, 0],
			["Data", 0, 1]
		])
	})
})

describe("number categories", () => {
	it("reads whole columns only as far as the sheet's cells, and no further than a chart plots", () => {
		let reads = 0
		const numbers = (lastRow: number): ChartCells => ({
			names: () => undefined,
			sheet: () => ({
				lastRow,
				lastCol: 25,
				cell: () => {
					reads++

					return { kind: "number", number: 1, text: "1", format: "General" }
				},
				hidden: () => false,
				hiddenRow: () => false,
				hiddenCol: () => false
			})
		})

		expect(numericCells("Data!$A:$A", numbers(9))).toBe(true)
		expect(reads).toBe(10)
		reads = 0
		// 1,048,576 rows of 26 columns of numbers: past what a chart plots, so read as text and not walked.
		expect(numericCells("Data!$A:$Z", numbers(1_048_575))).toBe(false)
		expect(reads).toBe(0)
	})
})

describe("chart caches", () => {
	it("keeps a chart's bytes when its caches equal its cells", () => {
		const bytes = encodeUtf8(barChart([SOLD, KEPT]))
		const refreshed = refreshChartCaches(bytes, grid(CELLS))

		expect(refreshed.changed).toBe(false)
		expect(refreshed.bytes).toBe(bytes)
	})

	it("writes the cells' values, text and formats into stale or missing caches", () => {
		const { catCache: _dropped, ...stale } = SOLD
		const bytes = encodeUtf8(barChart([{ ...stale, valCache: [0, 0, 0] }]))
		const refreshed = refreshChartCaches(bytes, grid({ ...CELLS, B3: "n/a" }))
		const text = new TextDecoder().decode(refreshed.bytes)

		expect(refreshed.changed).toBe(true)
		// A cell holding text is no point of a number cache; the count stays the range's.
		expect(text).toContain(
			'<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="2"><c:v>7</c:v></c:pt></c:numCache>'
		)
		expect(text).toContain(
			'<c:f>Data!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>Apple</c:v></c:pt><c:pt idx="1"><c:v>Pear</c:v></c:pt><c:pt idx="2"><c:v>Plum</c:v></c:pt></c:strCache>'
		)
	})

	it("leaves hidden rows out of what a chart of visible cells shows, never out of what is saved", () => {
		const bytes = encodeUtf8(barChart([SOLD]))
		const shown = new TextDecoder().decode(refreshChartCaches(bytes, grid(CELLS, [2]), { shown: true }).bytes)

		expect(shown).toContain(
			'<c:f>Data!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numCache>'
		)
		expect(shown).toContain('<c:ptCount val="2"/><c:pt idx="0"><c:v>Apple</c:v></c:pt><c:pt idx="1"><c:v>Plum</c:v></c:pt>')
		expect(refreshChartCaches(bytes, grid(CELLS, [2])).changed).toBe(false)
		// A chart that plots hidden cells too shows them.
		const all = encodeUtf8(barChart([SOLD]).replace('<c:plotVisOnly val="1"/>', '<c:plotVisOnly val="0"/>'))

		expect(refreshChartCaches(all, grid(CELLS, [2]), { shown: true }).changed).toBe(false)
	})

	it("drops a hidden level of multi-level categories from what a chart of visible cells shows, keeping its points", () => {
		// Two-level categories down A2:B4 (outer A, inner B) over the values in C2:C4.
		const rowWise = { A2: "East", A4: "West", B2: "Apple", B3: "Pear", B4: "Plum", C2: 3, C3: 5, C4: 7 }
		const multiLevel = (cat: string, val: string): Uint8Array =>
			encodeUtf8(
				barChart([{ name: "Data!$C$1", cat, val }]).replace(
					`<c:cat><c:strRef><c:f>${cat}</c:f></c:strRef></c:cat>`,
					`<c:cat><c:multiLvlStrRef><c:f>${cat}</c:f></c:multiLvlStrRef></c:cat>`
				)
			)
		const shown = (bytes: Uint8Array, cells: ChartCells): string =>
			new TextDecoder().decode(refreshChartCaches(bytes, cells, { shown: true }).bytes)
		const byRows = multiLevel("Data!$A$2:$B$4", "Data!$C$2:$C$4")
		const inner =
			'<c:lvl><c:pt idx="0"><c:v>Apple</c:v></c:pt><c:pt idx="1"><c:v>Pear</c:v></c:pt><c:pt idx="2"><c:v>Plum</c:v></c:pt></c:lvl>'

		// The outer level's column hidden: every point, with the inner level only.
		expect(shown(byRows, grid(rowWise, [], [0]))).toContain(`<c:multiLvlStrCache><c:ptCount val="3"/>${inner}</c:multiLvlStrCache>`)
		// A hidden point row: that point only.
		expect(shown(byRows, grid(rowWise, [2]))).toContain(
			'<c:multiLvlStrCache><c:ptCount val="2"/><c:lvl><c:pt idx="0"><c:v>Apple</c:v></c:pt><c:pt idx="1"><c:v>Plum</c:v></c:pt></c:lvl>' +
				'<c:lvl><c:pt idx="0"><c:v>East</c:v></c:pt><c:pt idx="1"><c:v>West</c:v></c:pt></c:lvl></c:multiLvlStrCache>'
		)

		// Both levels hidden: the points without levels, as many as the values.
		const bare = shown(byRows, grid(rowWise, [], [0, 1]))

		expect(bare).toContain('<c:multiLvlStrCache><c:ptCount val="3"/></c:multiLvlStrCache>')
		expect(bare).toContain('<c:f>Data!$C$2:$C$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/>')

		// Across: the levels are rows 1 (outer) and 2 (inner) over the values in row 3.
		const colWise = { A1: "East", C1: "West", A2: "Apple", B2: "Pear", C2: "Plum", A3: 3, B3: 5, C3: 7 }
		const byCols = multiLevel("Data!$A$1:$C$2", "Data!$A$3:$C$3")

		expect(shown(byCols, grid(colWise, [0]))).toContain(`<c:multiLvlStrCache><c:ptCount val="3"/>${inner}</c:multiLvlStrCache>`)
		expect(shown(byCols, grid(colWise, [], [1]))).toContain(
			'<c:multiLvlStrCache><c:ptCount val="2"/><c:lvl><c:pt idx="0"><c:v>Apple</c:v></c:pt><c:pt idx="1"><c:v>Plum</c:v></c:pt></c:lvl>'
		)
		expect(shown(byCols, grid(colWise, [0, 1]))).toContain('<c:multiLvlStrCache><c:ptCount val="3"/></c:multiLvlStrCache>')
	})

	it("turns number categories that now hold text into text ones", () => {
		const chart = barChart([SOLD])
			.replace("<c:cat><c:strRef><c:f>Data!$A$2:$A$4</c:f>", "<c:cat><c:numRef><c:f>Data!$A$2:$A$4</c:f>")
			.replace(
				'<c:pt idx="2"><c:v>Plum</c:v></c:pt></c:strCache></c:strRef></c:cat>',
				'<c:pt idx="2"><c:v>Plum</c:v></c:pt></c:strCache></c:numRef></c:cat>'
			)
		const text = new TextDecoder().decode(refreshChartCaches(encodeUtf8(chart), grid(CELLS)).bytes)

		expect(text).toMatch(/<c:cat><c:strRef><c:f>Data!\$A\$2:\$A\$4<\/c:f><c:strCache>/)
	})

	it("refreshes a chart's caches from edited cells when the workbook is saved", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[2, 1, "50"]]) }))

		const saved = await save(session)
		const chart = partText(saved.bytes, CHART_PART)

		expect(saved.changedParts).toContain(CHART_PART)
		expect(chart).toContain(
			'<c:f>Data!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>50</c:v></c:pt>'
		)
		// The series that reads other cells is as it was.
		expect(chart).toContain(
			'<c:f>Data!$C$2:$C$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>1</c:v></c:pt>'
		)
		session.close()
	})

	it("leaves charts untouched when nothing they read was edited", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT])))

		// A cell the chart does not read, and a cell on another sheet.
		changeOf(await session.command({ type: "cells.set", sheet: sheets[0] ?? 0, cells: cells([[8, 6, "12"]]) }))
		changeOf(await session.command({ type: "cells.set", sheet: sheets[1] ?? 0, cells: cells([[0, 0, "1"]]) }))

		const saved = await save(session)

		expect(saved.changedParts).not.toContain(CHART_PART)
		session.close()
	})

	it("keeps the chart's bytes when an edit of its cells is undone before the save", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[1, 1, "40"]]) }))
		await session.undo()
		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[9, 9, "1"]]) }))

		const saved = await save(session)

		expect(saved.changedParts).not.toContain(CHART_PART)
		expect(partText(saved.bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})

	it("refreshes a chart when its cells' number formats change, and draws only the rows left shown", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0
		const request = { part: CHART_PART, width: 4_572_000, height: 2_743_200 }
		const first = await session.query("chart.render", request)

		// A format: the cached categories' text and the values' format code follow it.
		changeOf(
			await session.command({
				type: "format.apply",
				sheet: data,
				ranges: [{ startRow: 1, startCol: 1, endRow: 3, endCol: 1 }],
				patch: { numFmt: "0.00" }
			})
		)

		const formatted = await session.query("chart.render", { ...request, since: first.stamp })

		expect(formatted.kind).toBe("drawing")
		expect(partText(await save(session).then(result => result.bytes), CHART_PART)).toContain(
			"<c:f>Data!$B$2:$B$4</c:f><c:numCache><c:formatCode>0.00</c:formatCode>"
		)

		// Row 3 hidden: the chart (visible cells only) draws two categories.
		changeOf(await session.command({ type: "axis.hide", sheet: data, axis: "rows", spans: [{ start: 2, end: 2 }], hidden: true }))

		const hidden = await session.query("chart.render", { ...request, since: formatted.stamp })

		expect(hidden.kind).toBe("drawing")
		expect(hidden.kind === "drawing" ? hidden.drawing.texts.some(text => JSON.stringify(text).includes("Pear")) : true).toBe(false)
		session.close()
	})

	it("draws an unnamed series in the session's chart text, and again once that text changes", async () => {
		const { session } = await openCharts(chartFixture(barChart([SOLD, KEPT]).replace(/<c:tx>.*?<\/c:tx>/gu, "")))
		const request = { part: CHART_PART, width: 4_572_000, height: 2_743_200 }
		const textOf = (render: Awaited<ReturnType<typeof session.query<"chart.render">>>): string =>
			render.kind === "drawing" ? JSON.stringify(render.drawing.texts) : ""
		const first = await session.query("chart.render", request)

		expect(textOf(first)).toContain("Series2")
		session.configure({ chartText: { series: "Datenreihe{n}", chartTitle: "Diagrammtitel", axisTitle: "Achsentitel" } })

		const german = await session.query("chart.render", { ...request, since: first.stamp })

		expect(german.kind).toBe("drawing")
		expect(textOf(german)).toContain("Datenreihe2")
		expect(textOf(german)).not.toContain("Series")
		expect((await session.query("chart.render", { ...request, since: german.stamp })).kind).toBe("same")
		session.close()
	})

	it("draws a chart from its cells as they now are, and says when nothing changed since", async () => {
		const { session, sheets } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const request = { part: CHART_PART, width: 4_572_000, height: 2_743_200 }
		const first = await session.query("chart.render", request)

		expect(first.kind).toBe("drawing")
		expect((await session.query("chart.render", { ...request, since: first.stamp })).kind).toBe("same")

		changeOf(await session.command({ type: "cells.set", sheet: sheets[0] ?? 0, cells: cells([[1, 1, "30"]]) }))

		const after = await session.query("chart.render", { ...request, since: first.stamp })

		expect(after.kind).toBe("drawing")
		expect(after.stamp).not.toBe(first.stamp)
		// An edit elsewhere leaves it as drawn.
		changeOf(await session.command({ type: "cells.set", sheet: sheets[1] ?? 0, cells: cells([[3, 3, "1"]]) }))
		expect((await session.query("chart.render", { ...request, since: after.stamp })).kind).toBe("same")
		session.close()
	})
})

describe("chart caches as Excel writes them", () => {
	const request = { part: CHART_PART, width: 4_572_000, height: 2_743_200 }

	it("keeps a pivot chart's own caches: drawn from them and never rewritten from the pivot table's cells", async () => {
		// The pivot table's area holds its labels and grand total; the chart's caches hold only the plotted items.
		const chart = barChart([{ ...SOLD, valCache: [30, 50, 70] }]).replace(
			'<c:date1904 val="0"/>',
			'<c:date1904 val="0"/><c:pivotSource><c:name>[Book.xlsx]Data!PivotTable1</c:name><c:fmtId val="0"/></c:pivotSource>'
		)
		const { session, sheets, bytes } = await openCharts(chartFixture(chart))
		const data = sheets[0] ?? 0
		const first = await session.query("chart.render", request)
		const texts = first.kind === "drawing" ? JSON.stringify(first.drawing.texts) : ""

		// The value axis reaches 80 (over the cache's 70), not 8 (over the cells' 7).
		expect(texts).toContain('"text":"80"')
		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[1, 1, "99"]]) }))
		changeOf(await session.command({ type: "axis.hide", sheet: data, axis: "rows", spans: [{ start: 2, end: 2 }], hidden: true }))
		expect((await session.query("chart.render", { ...request, since: first.stamp })).kind).toBe("same")

		const saved = await save(session)

		expect(saved.changedParts).not.toContain(CHART_PART)
		expect(partText(saved.bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})

	it("follows a defined name a row insert moves, both where drawn and at save", async () => {
		const fixture = chartFixture(barChart([{ ...SOLD, name: "[0]!Head", cat: "[0]!Cats", val: "[0]!Sales" }]))
		const { session, sheets } = await openCharts({
			...fixture,
			workbookTail:
				'<definedNames><definedName name="Cats">Data!$A$2:$A$4</definedName><definedName name="Head">Data!$B$1</definedName><definedName name="Sales">Data!$B$2:$B$4</definedName></definedNames>'
		})
		const data = sheets[0] ?? 0

		changeOf(await session.command({ type: "axis.insert", sheet: data, axis: "rows", at: 0, count: 1 }))
		await save(session)

		const first = await session.query("chart.render", request)

		// Sales is now Data!$B$3:$B$5: B5 holds what B4 held.
		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[4, 1, "99"]]) }))
		expect((await session.query("chart.render", { ...request, since: first.stamp })).kind).toBe("drawing")
		expect(partText((await save(session)).bytes, CHART_PART)).toMatch(/\[0\]!Sales<\/c:f><c:numCache>.*<c:v>99<\/c:v>/)
		session.close()
	})

	it("keeps caches whose numbers Excel wrote with 17 significant digits", () => {
		const chart = barChart([SOLD]).replace("<c:v>3</c:v>", "<c:v>0.10000000000000001</c:v>")

		expect(refreshChartCaches(encodeUtf8(chart), grid({ ...CELLS, B2: 0.1 })).changed).toBe(false)
	})

	it("keeps caches holding escaped text that reads as the cells show it", () => {
		const chart = barChart([SOLD]).replace("<c:v>Pear</c:v>", "<c:v>Pe_x000d_ar</c:v>")

		expect(refreshChartCaches(encodeUtf8(chart), grid({ ...CELLS, A3: "Pe\rar" })).changed).toBe(false)
	})

	it("writes text that looks like an escape with its underscore escaped", () => {
		const text = new TextDecoder().decode(refreshChartCaches(encodeUtf8(barChart([SOLD])), grid({ ...CELLS, A3: "_x0041_" })).bytes)

		expect(text).toContain("<c:v>_x005F_x0041_</c:v>")
	})

	it("keeps the file's format code on a number cache over cells that hold no number", () => {
		const chart = barChart([{ ...SOLD, valCache: [] }]).replace(
			'<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="0"/>',
			'<c:numCache><c:formatCode>0</c:formatCode><c:ptCount val="3"/>'
		)

		expect(refreshChartCaches(encodeUtf8(chart), grid({ ...CELLS, B2: "", B3: "", B4: "" })).changed).toBe(false)
	})

	it("keeps the extension of number categories that now hold text", () => {
		const extension =
			'<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:fullRef xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"><c15:sqref>Data!$A$2:$A$9</c15:sqref></c15:fullRef></c:ext></c:extLst>'
		const chart = barChart([SOLD])
			.replace("<c:cat><c:strRef><c:f>Data!$A$2:$A$4</c:f>", "<c:cat><c:numRef><c:f>Data!$A$2:$A$4</c:f>")
			.replace(
				'<c:pt idx="2"><c:v>Plum</c:v></c:pt></c:strCache></c:strRef></c:cat>',
				`<c:pt idx="2"><c:v>Plum</c:v></c:pt></c:strCache>${extension}</c:numRef></c:cat>`
			)
		const text = new TextDecoder().decode(refreshChartCaches(encodeUtf8(chart), grid(CELLS)).bytes)

		expect(text).toMatch(/<c:cat><c:strRef><c:f>Data!\$A\$2:\$A\$4<\/c:f><c:strCache>.*?<\/c:strCache><c:extLst><c:ext uri="\{02D57815/)
	})

	it("neither redraws nor rewrites a chart when a column is resized", async () => {
		const chart = barChart([SOLD, KEPT]).replace("<c:v>3</c:v>", "<c:v>0.10000000000000001</c:v>")
		const fixture = chartFixture(chart)
		const sheet0 = fixture.sheets[0]
		const body = (sheet0?.body ?? "").replace('<c r="B2"><v>3</v></c>', '<c r="B2"><v>0.1</v></c>')
		const { session, sheets, bytes } = await openCharts({
			...fixture,
			sheets: [{ ...sheet0, name: "Data", body }, ...fixture.sheets.slice(1)]
		})
		const data = sheets[0] ?? 0
		const first = await session.query("chart.render", request)

		changeOf(
			await session.command({
				type: "axis.resize",
				sheet: data,
				axis: "cols",
				indices: Uint32Array.of(1),
				sizes: Float32Array.of(90)
			})
		)
		expect((await session.query("chart.render", { ...request, since: first.stamp })).kind).toBe("same")

		const saved = await save(session)

		expect(saved.changedParts).not.toContain(CHART_PART)
		expect(partText(saved.bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})

	it("redraws a chart of visible cells when rows are hidden, and saves it as it was", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0
		const first = await session.query("chart.render", request)

		changeOf(await session.command({ type: "axis.hide", sheet: data, axis: "rows", spans: [{ start: 2, end: 2 }], hidden: true }))
		expect((await session.query("chart.render", { ...request, since: first.stamp })).kind).toBe("drawing")

		const saved = await save(session)

		expect(saved.changedParts).not.toContain(CHART_PART)
		expect(partText(saved.bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})
})

describe("chart caches across saves", () => {
	it("refreshes again when an edit is undone or redone after a save", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[1, 1, "99"]]) }))
		expect(partText((await save(session)).bytes, CHART_PART)).toContain("<c:v>99</c:v>")
		await session.undo()
		expect(partText((await save(session)).bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		await session.redo()
		expect(partText((await save(session)).bytes, CHART_PART)).toContain("<c:v>99</c:v>")
		session.close()
	})

	it("brings back a cleared range's points when the clear is undone after a save", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0

		changeOf(
			await session.command({
				type: "cells.clear",
				sheet: data,
				ranges: [{ startRow: 0, startCol: 0, endRow: 3, endCol: 2 }],
				what: "all"
			})
		)
		expect(partText((await save(session)).bytes, CHART_PART)).not.toContain("<c:v>Apple</c:v>")
		await session.undo()
		expect(partText((await save(session)).bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})

	it("keeps no cache an aborted save wrote", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[1, 1, "99"]]) }))
		expect((await session.save({ signal: { aborted: true } })).ok).toBe(false)
		await session.undo()
		expect(partText((await save(session)).bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})

	it("saves the caches an edit after a save needs, and the source once it is undone again", async () => {
		const { session, sheets, bytes } = await openCharts(chartFixture(barChart([SOLD, KEPT])))
		const data = sheets[0] ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[1, 1, "99"]]) }))
		await save(session)
		changeOf(await session.command({ type: "chart.edit", sheet: data, part: CHART_PART, edit: { kind: "legend", position: "t" } }))
		await session.undo()

		const kept = partText((await save(session)).bytes, CHART_PART)

		expect(kept).toContain("<c:v>99</c:v>")
		expect(kept).toContain('<c:legendPos val="r"/>')
		await session.undo()
		expect(partText((await save(session)).bytes, CHART_PART)).toBe(partText(bytes, CHART_PART))
		session.close()
	})
})
