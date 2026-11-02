import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { presentationChartObject } from "../core/odp/write/chartObject"
import {
	chartWorkbookOp,
	insertChartOp,
	sampleChartCells,
	sampleScatterCells,
	type ChartCell
} from "../core/presentation/edit/commands/chart"
import { heldChart, workbookCells, type Cell } from "../core/presentation/edit/apply/chart"
import type { ShapeNode, ShapeRef, SlideNode, SlideRef } from "../core/presentation/model"
import { cellsWorkbookXlsx, textWorkbookXlsx } from "../core/xlsx/convert/text"
import { parseXml } from "../core/xml/index"
import { chartData } from "../dom/presentation/engine/chart"
import { viewCapability } from "../dom/presentation/engine/view"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Edit Data: the chart follows its data's table (points and series added or taken away, along columns or rows), the
// numbers stay exact and keep their formats, a scatter chart's x values stay numbers, and an embedded .xls's
// conversion to .xlsx is undone and redone across saves without parts or relationships left behind.

type Format = "pptx" | "odp"
type Drive = Awaited<ReturnType<typeof driveSession>>

const CELLS = sampleChartCells({ categories: ["A", "B", "C", "D"], series: ["North", "South", "West"] })

function blank(format: Format): Uint8Array {
	return format === "odp"
		? odpBytes({ body: '<draw:page draw:name="One" draw:master-page-name="M"></draw:page>' })
		: buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("x"))) }] })
}

function chartShape(d: Drive, slide: SlideRef): ShapeNode {
	return (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.frame?.kind === "chart") as ShapeNode
}

async function inserted(
	format: Format,
	cells: ChartCell[][] = CELLS,
	type: "column" | "scatter" = "column"
): Promise<{ readonly d: Drive; readonly target: ShapeRef }> {
	const d = await driveSession(blank(format), format)
	const slide = d.session.deck.slides[0] as SlideRef

	expect(await d.command(insertChartOp(d.session.deck, slide, 0, type, cells))).toMatchObject({ ok: true })
	await d.save()

	return { d, target: { slide, id: chartShape(d, slide).id } }
}

async function workbook(rows: readonly (readonly Cell[])[]): Promise<Uint8Array> {
	const built = await cellsWorkbookXlsx(rows, "Sheet1")

	if (!built.ok) throw new Error(built.refusal.reason)

	return built.bytes
}

async function saved(d: Drive): Promise<Uint8Array> {
	const out = await d.save()

	expect(out.result).toMatchObject({ kind: "written" })

	return out.bytes as Uint8Array
}

function objectOf(bytes: Uint8Array): string {
	const files = unzipSync(bytes)
	const name = Object.keys(files).find(each => /^Object \d+\/content\.xml$/u.test(each)) as string

	return strFromU8(files[name] as Uint8Array)
}

function ranges(object: string): string[] {
	return [...object.matchAll(/chart:values-cell-range-address="([^"]+)"/gu)].map(match => (match[1] as string).replaceAll("&apos;", "'"))
}

async function seriesValues(d: Drive, target: ShapeRef): Promise<(string | null)[]> {
	return (await chartData(d.context, target)).info?.plots[0]?.series.map(series => series.values) ?? []
}

async function reopened(bytes: Uint8Array, format: Format): Promise<{ readonly d: Drive; readonly target: ShapeRef }> {
	const d = await driveSession(bytes, format)
	const slide = d.session.deck.slides[0] as SlideRef

	await viewCapability.render(d.context, [slide])

	return { d, target: { slide, id: chartShape(d, slide).id } }
}

describe("ODP Edit Data fits the chart to its table", () => {
	it("a row added is a point of every series, live, saved and reopened", async () => {
		const { d, target } = await inserted("odp")
		const rows = [...CELLS, ["E", 13, 14, 15]]

		expect(await d.command(chartWorkbookOp(target, await workbook(rows)))).toMatchObject({ ok: true })
		expect(await seriesValues(d, target)).toEqual(["'local-table'!$B$2:$B$6", "'local-table'!$C$2:$C$6", "'local-table'!$D$2:$D$6"])

		const bytes = await saved(d)

		expect(ranges(objectOf(bytes))).toEqual([
			"'local-table'.B2:'local-table'.B6",
			"'local-table'.C2:'local-table'.C6",
			"'local-table'.D2:'local-table'.D6"
		])

		const again = await reopened(bytes, "odp")

		expect(await seriesValues(again.d, again.target)).toEqual(await seriesValues(d, target))
	})

	it("a series taken away is gone; one added is read", async () => {
		const { d, target } = await inserted("odp")

		expect(await d.command(chartWorkbookOp(target, await workbook(CELLS.map(row => row.slice(0, 2)))))).toMatchObject({ ok: true })
		expect(ranges(objectOf(await saved(d)))).toEqual(["'local-table'.B2:'local-table'.B5"])

		expect(
			await d.command(chartWorkbookOp(target, await workbook(CELLS.map((row, k) => [...row, k === 0 ? "East" : k]))))
		).toMatchObject({ ok: true })
		expect(ranges(objectOf(await saved(d)))).toHaveLength(4)
	})

	for (const format of ["odp", "pptx"] as const)
		it(`${format}: a chart whose series are rows grows along its rows and gains a row's series`, async () => {
			const rows: ChartCell[][] = [
				[null, "Q1", "Q2", "Q3", "Q4"],
				["North", 1, 2, 3, 4],
				["South", 5, 6, 7, 8]
			]
			const { d, target } = await inserted(format, rows)
			const sheet = format === "odp" ? "'local-table'" : "Sheet1"

			expect(await seriesValues(d, target)).toEqual([`${sheet}!$B$2:$E$2`, `${sheet}!$B$3:$E$3`])

			const grown = [
				[...(rows[0] as ChartCell[]), "Q5"],
				[...(rows[1] as ChartCell[]), 9],
				[...(rows[2] as ChartCell[]), 10],
				["West", 11, 12, 13, 14, 15]
			]

			expect(await d.command(chartWorkbookOp(target, await workbook(grown)))).toMatchObject({ ok: true })
			expect(await seriesValues(d, target)).toEqual([`${sheet}!$B$2:$F$2`, `${sheet}!$B$3:$F$3`, `${sheet}!$B$4:$F$4`])

			const again = await reopened(await saved(d), format)

			expect(await seriesValues(again.d, again.target)).toEqual(await seriesValues(d, target))
		})
})

describe("Edit Data keeps numbers exact and in their formats", () => {
	const exact: ChartCell[][] = [
		[null, "S"],
		["a", 1234567.891234],
		["b", 0.1 + 0.2],
		["c", 123456789012345]
	]

	for (const format of ["odp", "pptx"] as const)
		it(`${format}: the workbook Edit Data opens holds every number exactly`, async () => {
			const { d, target } = await inserted(format, exact)
			const data = await chartData(d.context, target, { workbook: true })
			const cells = await workbookCells(data.workbook?.bytes as Uint8Array)

			if ("kind" in cells) throw new Error(cells.reason)

			const sheet = cells.sheet(cells.sheets[0] as string)

			expect([1, 2, 3].map(row => sheet?.cell(row, 1).number)).toEqual([1234567.891234, 0.1 + 0.2, 123456789012345])
		})

	it("odp: Edit Data applied unchanged writes every value back exactly", async () => {
		const { d, target } = await inserted("odp", exact)
		const data = await chartData(d.context, target, { workbook: true })

		expect(await d.command(chartWorkbookOp(target, data.workbook?.bytes as Uint8Array))).toMatchObject({ ok: true })

		const object = objectOf(await saved(d))

		for (const value of ["1234567.891234", String(0.1 + 0.2), "123456789012345"]) expect(object).toContain(`office:value="${value}"`)
	})

	it("odp: dates and percentages keep their formats through Edit Data, save and the next Edit Data", async () => {
		const { d, target } = await inserted("odp")
		const rows: Cell[][] = [
			[null, "S"],
			[
				{ number: 45292, format: "m/d/yyyy" },
				{ number: 0.25, format: "0%" }
			],
			[
				{ number: 45293, format: "m/d/yyyy" },
				{ number: 0.5, format: "0%" }
			]
		]

		expect(await d.command(chartWorkbookOp(target, await workbook(rows)))).toMatchObject({ ok: true })

		const bytes = await saved(d)
		const object = objectOf(bytes)

		expect(object).toMatch(/<number:date-style /u)
		expect(object).toMatch(/<number:percentage-style /u)
		expect(object).toMatch(/office:value-type="float" office:value="0.25"><text:p>25%<\/text:p>/u)
		expect(object).toContain("<text:p>1/1/2024</text:p>")
		// Both axes, linked to their cells' format, state it: the dates on x, the percentages on y.
		expect(
			[...object.matchAll(/<chart:axis chart:dimension="([xy])"[^>]*chart:style-name="(ltA\d+)"/gu)].map(match => match[1])
		).toEqual(["x", "y"])
		expect([
			...object.matchAll(/style:data-style-name="ltN\d+"[^>]*><style:chart-properties chart:link-data-style-to-source="false"/gu)
		]).toHaveLength(2)

		const again = await reopened(bytes, "odp")
		const data = await chartData(again.d.context, again.target, { workbook: true })
		const cells = await workbookCells(data.workbook?.bytes as Uint8Array)

		if ("kind" in cells) throw new Error(cells.reason)

		const sheet = cells.sheet(cells.sheets[0] as string)

		expect([sheet?.cell(1, 0).text, sheet?.cell(1, 1).text, sheet?.cell(2, 1).number]).toEqual(["1/1/2024", "25%", 0.5])
	})

	it("odp: a scatter chart's x values stay numbers after Edit Data", async () => {
		const { d, target } = await inserted("odp", sampleScatterCells({ x: "X", y: "Y" }), "scatter")
		const rows: Cell[][] = [
			["X", "Y"],
			[10, 1],
			[20, 4],
			[40, 2]
		]

		expect(await d.command(chartWorkbookOp(target, await workbook(rows)))).toMatchObject({ ok: true })

		const now = chartShape(d, target.slide).frame as { readonly part: string }
		const document = heldChart(d.session.deck, now.part)?.document
		const markup = document === undefined ? "" : new TextDecoder().decode(document.bytes)
		const xVal = markup.slice(markup.indexOf("<c:xVal>"), markup.indexOf("</c:xVal>"))

		expect(xVal).toMatch(/<c:num(Ref|Lit)>/u)
		expect([...xVal.matchAll(/<c:v>([^<]*)<\/c:v>/gu)].map(match => match[1])).toEqual(["10", "20", "40"])
	})
})

describe("a chart part converted to an ODP object keeps its number formats", () => {
	const chart = (categories: string, values: string): Uint8Array =>
		strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' +
				'<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>S</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
				`<c:cat><c:numRef><c:f>Sheet1!$A$2:$A$3</c:f><c:numCache><c:formatCode>${categories}</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>45292</c:v></c:pt><c:pt idx="1"><c:v>45293</c:v></c:pt></c:numCache></c:numRef></c:cat>` +
				`<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>${values}</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>0.25</c:v></c:pt><c:pt idx="1"><c:v>0.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>` +
				'<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="2"/></c:catAx>' +
				'<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>'
		)
	const NO_THEME = drawingTheme(undefined, () => undefined)

	it("date categories and percent values: the table's cells and the source-linked axes", () => {
		const object = presentationChartObject(parseXml(chart("m/d/yyyy", "0%")), NO_THEME, "10cm", "8cm")
		const content = strFromU8(object?.content as Uint8Array)

		expect(object?.lost).toBe(false)
		expect(content).toContain("<text:p>1/1/2024</text:p>")
		expect(content).toMatch(/office:value-type="float" office:value="0.25"><text:p>25%<\/text:p>/u)
		// Each axis states the format of the cells it shows (no source to link to).
		expect([
			...content.matchAll(
				/style:data-style-name="([^"]+)"[^>]*><style:chart-properties[^>]*chart:link-data-style-to-source="false"/gu
			)
		]).toHaveLength(2)
	})

	it("a format no data style can say is reported lost", () => {
		expect(presentationChartObject(parseXml(chart("mmmmm", "0%")), NO_THEME, "10cm", "8cm")?.lost).toBe(true)
	})
})

describe("an embedded .xls through Edit Data, undo and redo across saves", () => {
	const XLS = join(CORPUS_DIR, "xls", "csvkit__test.xls")

	// A pptx whose chart's data is an embedded .xls (an OLE object, as a pptx converted from a .ppt holds it).
	async function xlsDeck(): Promise<Uint8Array> {
		const { d } = await inserted("pptx")
		const files = unzipSync(d.drive.files.get(d.drive.current) as Uint8Array)
		const embedded = Object.keys(files).find(name => name.startsWith("ppt/embeddings/")) as string

		delete files[embedded]
		files["ppt/embeddings/Microsoft_Excel_97-2003_Worksheet1.xls"] = readFileSync(XLS)
		files["ppt/charts/_rels/chart1.xml.rels"] = strToU8(
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/Microsoft_Excel_97-2003_Worksheet1.xls"/></Relationships>'
		)
		files["[Content_Types].xml"] = strToU8(
			strFromU8(files["[Content_Types].xml"] as Uint8Array).replace(
				"<Default ",
				'<Default Extension="xls" ContentType="application/vnd.ms-excel"/><Default '
			)
		)

		return zipSync(files)
	}

	// The chart and embedded parts of a saved file, and the charts its slide relates.
	function parts(bytes: Uint8Array): readonly [string, string] {
		const files = unzipSync(bytes)

		return [
			Object.keys(files)
				.filter(name => /^ppt\/(charts\/chart\d+\.xml|embeddings\/)/u.test(name))
				.sort()
				.join(","),
			(strFromU8(files["ppt/slides/_rels/slide1.xml.rels"] as Uint8Array).match(/charts\/chart\d+\.xml/gu) ?? []).join(",")
		]
	}

	it.skipIf(!existsSync(XLS))("each save holds the one chart its frame names, with its workbook, nothing else", async () => {
		const source = await xlsDeck()
		const d = await driveSession(source, "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await viewCapability.render(d.context, [slide])

		const target = { slide, id: chartShape(d, slide).id }
		// The undo writes the source's chart and workbook back, bytes and names (the parts its step names).
		const same = (bytes: Uint8Array): void => {
			const before = unzipSync(source)
			const after = unzipSync(bytes)

			for (const name of xls.split(",")) expect(after[name], name).toEqual(before[name])
		}
		const data = await textWorkbookXlsx(
			[
				["", "S"],
				["x", "5"],
				["y", "6"]
			],
			"Sheet1"
		)

		if (!data.ok) throw new Error(data.refusal.reason)

		const xls = "ppt/charts/chart1.xml,ppt/embeddings/Microsoft_Excel_97-2003_Worksheet1.xls"
		const xlsx = "ppt/charts/chart2.xml,ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"

		expect(await d.command(chartWorkbookOp(target, data.bytes))).toMatchObject({ ok: true })
		expect(parts(await saved(d))).toEqual([xlsx, "charts/chart2.xml"])
		expect((await d.undo()).ok).toBe(true)

		const back = await saved(d)

		expect(parts(back)).toEqual([xls, "charts/chart1.xml"])
		same(back)
		expect((await d.redo()).ok).toBe(true)
		expect(parts(await saved(d))).toEqual([xlsx, "charts/chart2.xml"])
		expect((await d.undo()).ok).toBe(true)

		const again = await saved(d)

		expect(parts(again)).toEqual([xls, "charts/chart1.xml"])
		same(again)
	})
})
