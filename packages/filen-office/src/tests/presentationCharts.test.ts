import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { chartWorkbookOp, chartEditOp, insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import { heldChart, workbookCells, type WorkbookCells } from "../core/presentation/edit/apply/chart"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { textWorkbookXlsx } from "../core/xlsx/convert/text"
import { parseXml } from "../core/xml/index"
import type { ChartText } from "../core/drawingml/chart/builder"
import { chartData } from "../dom/presentation/engine/chart"
import { viewCapability } from "../dom/presentation/engine/view"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { clipSlides } from "../dom/presentation/engine/clip"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Charts in a presentation through the engine (prepare, apply, save, upload, commit, rebase): Insert ▸ Chart with its
// embedded workbook, the Chart tab's edits, Edit Data's workbook, and versions across undo, redo and saves.

const CELLS = sampleChartCells({ categories: ["A", "B", "C", "D"], series: ["North", "South", "West"] })

function deckOf(format: "odp" | "pptx"): Uint8Array {
	return format === "odp"
		? odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Charts</text:p></draw:text-box></draw:frame></draw:page>'
			})
		: buildPptx({
				slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Charts"))) }]
			})
}

async function archiveOf(bytes: Uint8Array | undefined): Promise<ZipArchive> {
	if (bytes === undefined) throw new Error("no saved file")

	return ZipArchive.open(bytesSource(bytes))
}

async function textOf(archive: ZipArchive, name: string): Promise<string> {
	const entry = archive.get(name)

	if (entry === undefined) throw new Error(`no ${name}`)

	return new TextDecoder().decode(await archive.read(entry))
}

async function saved(d: Awaited<ReturnType<typeof driveSession>>): Promise<ZipArchive> {
	const out = await d.save()

	expect(out.result).toMatchObject({ kind: "written" })

	return archiveOf(out.bytes)
}

function chartShape(d: Awaited<ReturnType<typeof driveSession>>, slide: SlideRef): ShapeNode {
	const node = d.session.deck.nodes.get(slide) as SlideNode
	const shape = node.shapes.find(each => each.frame?.kind === "chart")

	if (shape === undefined) throw new Error("no chart")

	return shape
}

function names(archive: ZipArchive, pattern: RegExp): string[] {
	return archive.entries.map(entry => entry.name).filter(name => pattern.test(name) && !name.includes("_rels"))
}

// The values a chart part caches for each series (c:val/c:numCache), in order.
function cachedValues(xml: string): number[][] {
	const document = parseXml(new TextEncoder().encode(xml))
	const out: number[][] = []

	for (let node = 0; node < document.count; node++) {
		if (document.localName(node) !== "val" && document.localName(node) !== "yVal") continue

		const values: number[] = []

		for (let child = node; child < document.count && document.end(child) <= document.end(node); child++)
			if (document.localName(child) === "v") values.push(Number(document.textContent(child)))

		out.push(values)
	}

	return out
}

async function insertChart(d: Awaited<ReturnType<typeof driveSession>>, slide: SlideRef): Promise<void> {
	const op = insertChartOp(d.session.deck, slide, 0, "column", CELLS)
	const result = await d.command(op)

	expect(result).toMatchObject({ ok: true })
}

describe("Insert ▸ Chart in a pptx", () => {
	it("writes a chart part whose embedded workbook is its own relationship, with caches equal to the cells", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const archive = await saved(d)
		const charts = names(archive, /^ppt\/charts\/chart\d+\.xml$/u)
		const embeddings = names(archive, /^ppt\/embeddings\//u)

		expect(charts).toHaveLength(1)
		expect(embeddings).toHaveLength(1)

		const chart = charts[0] as string
		const rels = await textOf(archive, chart.replace("charts/", "charts/_rels/").replace(/$/u, ".rels"))
		const slideRels = await textOf(archive, "ppt/slides/_rels/slide1.xml.rels")
		const xml = await textOf(archive, chart)

		expect(rels).toContain('Id="rId1"')
		expect(rels).toContain("relationships/package")
		expect(rels).toContain(`../embeddings/${(embeddings[0] as string).slice("ppt/embeddings/".length)}`)
		expect(slideRels).toContain("relationships/chart")
		expect(slideRels).not.toContain("relationships/package")
		expect(xml).toContain('<c:externalData r:id="rId1">')
		expect(cachedValues(xml)).toEqual([
			[4.3, 2.5, 3.5, 4.5],
			[2.4, 4.4, 1.8, 2.8],
			[2, 2, 3, 5]
		])
		expect(await textOf(archive, "[Content_Types].xml")).toContain("drawingml.chart+xml")
	})

	it("edits the chart the first save wrote in place, and relates it when only another shape changed", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const first = await saved(d)
		const target = { slide, id: chartShape(d, slide).id }

		expect(await d.command(chartEditOp(target, { kind: "title", text: "Sales" }))).toMatchObject({ ok: true })

		const second = await saved(d)

		expect(names(second, /^ppt\/(charts|embeddings)\//u)).toEqual(names(first, /^ppt\/(charts|embeddings)\//u))
		expect(await textOf(second, "ppt/charts/chart1.xml")).toContain("Sales")

		const other = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.frame === undefined) as ShapeNode
		const move: DeckOp = {
			family: "shape",
			kind: "setXfrm",
			target: { slide, id: other.id },
			xfrm: { ...(other.xfrm as Xfrm), x: 9000 }
		}

		expect(await d.command(move)).toMatchObject({ ok: true })

		const third = await saved(d)

		expect(names(third, /^ppt\/(charts|embeddings)\//u)).toEqual(names(first, /^ppt\/(charts|embeddings)\//u))
		expect(await textOf(third, "ppt/charts/chart1.xml")).toContain("Sales")
	})

	it("refuses an axis value the user can correct as the value, and what the editor cannot change as unsupported", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const xml = await textOf(await saved(d), "ppt/charts/chart1.xml")
		const valueAxis = Number(/<c:valAx><c:axId val="(\d+)"/u.exec(xml)?.[1])
		const categoryAxis = Number(/<c:catAx><c:axId val="(\d+)"/u.exec(xml)?.[1])
		const target = { slide, id: chartShape(d, slide).id }
		const axis = (axisId: number, patch: object) => d.command(chartEditOp(target, { kind: "axis", axis: axisId, patch }))

		expect(await axis(valueAxis, { min: Number.NaN })).toMatchObject({ ok: false, refusal: "invalidValue" })
		expect(await axis(valueAxis, { min: 5, max: 1 })).toMatchObject({ ok: false, refusal: "invalidValue" })
		expect(await axis(valueAxis, { major: 0 })).toMatchObject({ ok: false, refusal: "invalidValue" })
		expect(await axis(categoryAxis, { min: 0 })).toMatchObject({ ok: false, refusal: "unsupported" })
		expect(await axis(valueAxis, { min: 0, max: 10 })).toMatchObject({ ok: true })
	})

	it("names what the first save wrote after an undo past a save and a redo", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const first = names(await saved(d), /^ppt\/(charts|embeddings)\//u)

		expect((await d.undo()).ok).toBe(true)
		await saved(d)
		expect((await d.redo()).ok).toBe(true)
		expect(names(await saved(d), /^ppt\/(charts|embeddings)\//u)).toEqual(first)
	})
})

describe("Edit Data", () => {
	it("pptx: the new workbook replaces the embedded one and the caches equal its cells", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)
		await saved(d)

		const target = { slide, id: chartShape(d, slide).id }
		const data = await chartData(d.context, target, { workbook: true })

		expect(data.info?.plots[0]?.series).toHaveLength(3)
		expect(data.workbook?.kind).toBe("xlsx")

		const edited = CELLS.map((row, r) => row.map((cell, c) => (r > 0 && c > 0 && typeof cell === "number" ? cell * 10 : cell)))
		const workbook = await textWorkbookXlsx(
			edited.map(row => row.map(cell => (cell === null ? "" : String(cell)))),
			"Sheet1"
		)

		if (!workbook.ok) throw new Error("no workbook")

		expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

		const archive = await saved(d)
		const xml = await textOf(archive, "ppt/charts/chart1.xml")

		expect(cachedValues(xml)).toEqual([
			[43, 25, 35, 45],
			[24, 44, 18, 28],
			[20, 20, 30, 50]
		])

		const embedded = names(archive, /^ppt\/embeddings\//u)

		expect(embedded).toHaveLength(1)

		const cells = await workbookCells(await archive.read(archive.get(embedded[0] as string) as never))

		if ("kind" in cells) throw new Error(cells.reason)

		expect(cells.sheet("Sheet1")?.cell(1, 1).number).toBe(43)
	})

	it("pptx: an undo of Edit Data past its save writes the workbook and caches back", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)
		await saved(d)

		const target = { slide, id: chartShape(d, slide).id }
		const workbook = await textWorkbookXlsx(
			[
				["", "S"],
				["x", "7"]
			],
			"Sheet1"
		)

		if (!workbook.ok) throw new Error("no workbook")

		expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })
		await saved(d)
		expect((await d.undo()).ok).toBe(true)

		const archive = await saved(d)

		expect(cachedValues(await textOf(archive, "ppt/charts/chart1.xml"))[0]).toEqual([4.3, 2.5, 3.5, 4.5])

		const cells = await workbookCells(await archive.read(archive.get(names(archive, /^ppt\/embeddings\//u)[0] as string) as never))

		if ("kind" in cells) throw new Error(cells.reason)

		expect(cells.sheet("Sheet1")?.cell(1, 1).number).toBe(4.3)
	})

	it("pptx: the chart follows its table when Edit Data adds a row and takes a series away", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const target = { slide, id: chartShape(d, slide).id }
		const workbook = await textWorkbookXlsx(
			[
				["", "North", "South"],
				["A", "1", "2"],
				["B", "3", "4"],
				["C", "5", "6"],
				["D", "7", "8"],
				["E", "9", "10"]
			],
			"Sheet1"
		)

		if (!workbook.ok) throw new Error("no workbook")

		expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

		const xml = await textOf(await saved(d), "ppt/charts/chart1.xml")

		expect(cachedValues(xml)).toEqual([
			[1, 3, 5, 7, 9],
			[2, 4, 6, 8, 10]
		])
		expect(xml).toContain("Sheet1!$B$2:$B$6")
		expect(xml).not.toContain("$D$")
	})

	it("renders the chart an Edit Data made", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const target = { slide, id: chartShape(d, slide).id }
		const before = await viewCapability.render(d.context, [slide])
		const workbook = await textWorkbookXlsx(
			[
				["", "S"],
				["x", "70"],
				["y", "1"]
			],
			"Sheet1"
		)

		if (!workbook.ok) throw new Error("no workbook")

		expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

		const after = await viewCapability.render(d.context, [slide])

		expect(JSON.stringify(after[0]?.layers)).not.toEqual(JSON.stringify(before[0]?.layers))
		expect(
			heldChart(
				d.session.deck,
				chartShape(d, slide).frame?.kind === "chart" ? (chartShape(d, slide).frame as { part: string }).part : ""
			)
		).toBeDefined()
	})
})

describe("chart fallback texts in a presentation", () => {
	it("draws an unnamed series and the automatic title in the texts the page opened the deck with", async () => {
		const cells = sampleChartCells({ categories: ["A", "B", "C", "D"], series: ["", "", ""] })
		const shown = async (chartText?: ChartText): Promise<string> => {
			const d = await driveSession(deckOf("pptx"), "pptx", [], chartText === undefined ? {} : { chartText })
			const slide = d.session.deck.slides[0] as SlideRef

			expect(await d.command(insertChartOp(d.session.deck, slide, 0, "column", cells))).toMatchObject({ ok: true })

			return JSON.stringify((await viewCapability.render(d.context, [slide]))[0]?.layers)
		}

		expect(await shown()).toContain("Series1")

		const german = await shown({ series: "Datenreihe{n}", chartTitle: "Diagrammtitel", axisTitle: "Achsentitel" })

		expect(german).toContain("Datenreihe1")
		expect(german).toContain("Datenreihe3")
		expect(german).not.toMatch(/Series\d|Chart Title/)
	})
})

describe("ODP charts", () => {
	it("inserts a chart as an object of its own reading its own table", async () => {
		const d = await driveSession(deckOf("odp"), "odp")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)

		const archive = await saved(d)
		const objects = archive.entries.map(entry => entry.name).filter(name => /^Object \d+\/content\.xml$/u.test(name))

		expect(objects).toHaveLength(1)

		const object = await textOf(archive, objects[0] as string)
		const manifest = await textOf(archive, "META-INF/manifest.xml")
		const content = await textOf(archive, "content.xml")

		expect(object).toContain('table:name="local-table"')
		expect(object).toContain("<chart:plot-area")
		expect(manifest).toContain("application/vnd.oasis.opendocument.chart")
		expect(content).toContain(`xlink:href="./${(objects[0] as string).slice(0, -"/content.xml".length)}"`)

		// Read back: the chart frame, its values from its own table.
		const reopened = await driveSession(await bytesOf(d), "odp")

		await viewCapability.render(reopened.context, [reopened.session.deck.slides[0] as SlideRef])

		const shape = chartShape(reopened, reopened.session.deck.slides[0] as SlideRef)
		const data = await chartData(reopened.context, { slide: reopened.session.deck.slides[0] as SlideRef, id: shape.id })

		expect(data.info?.plots[0]?.series).toHaveLength(3)
	})

	it("changes a chart's type on its object and Edit Data writes its own table", async () => {
		const d = await driveSession(deckOf("odp"), "odp")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)
		await saved(d)

		const target = { slide, id: chartShape(d, slide).id }

		expect(await d.command(chartEditOp(target, { kind: "type", plot: 0, type: "line" }))).toMatchObject({ ok: true })

		const workbook = await textWorkbookXlsx(
			[
				["", "North"],
				["A", "9"],
				["B", "8"]
			],
			"Sheet1"
		)

		if (!workbook.ok) throw new Error("no workbook")

		expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

		const archive = await saved(d)
		const content = await textOf(archive, "content.xml")
		const href = /xlink:href="\.\/(Object \d+)"/u.exec(content)?.[1] ?? ""
		const object = await textOf(archive, `${href}/content.xml`)

		expect(object).toContain('chart:class="chart:line"')
		expect(object).toContain('office:value="9"')
	})
})

describe("versions across saves", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: a duplicated slide's chart gets parts of its own, and its edits leave the original's alone`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await insertChart(d, slide)
			expect(await d.command({ family: "slide", kind: "duplicate", slide })).toMatchObject({ ok: true })

			const copy = d.session.deck.slides[1] as SlideRef
			const pattern = format === "odp" ? /^Object \d+\/content\.xml$/u : /^ppt\/charts\/chart\d+\.xml$/u
			const first = await saved(d)
			const charts = names(first, pattern)

			expect(charts).toHaveLength(2)

			await viewCapability.render(d.context, [copy])
			expect(
				await d.command(chartEditOp({ slide: copy, id: chartShape(d, copy).id }, { kind: "title", text: "Copy" }))
			).toMatchObject({ ok: true })

			const second = await saved(d)
			const texts = await Promise.all(names(second, pattern).map(name => textOf(second, name)))

			const before = await Promise.all(charts.map(name => textOf(first, name)))

			expect(names(second, pattern)).toEqual(charts)
			expect(texts.filter(text => text.includes("Copy"))).toHaveLength(1)
			expect(texts.filter((text, index) => text === before[index])).toHaveLength(1)
		})
	}

	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: an edited chart is written back into its own part, and an undo past the save writes the source's back`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await insertChart(d, slide)

			const pattern = format === "odp" ? /^Object \d+\// : /^ppt\/(charts|embeddings)\//u
			const first = await saved(d)
			const chart = format === "odp" ? "Object 1/content.xml" : "ppt/charts/chart1.xml"
			const before = await textOf(first, chart)
			const target = { slide, id: chartShape(d, slide).id }

			expect(await d.command(chartEditOp(target, { kind: "title", text: "Renamed" }))).toMatchObject({ ok: true })

			const second = await saved(d)

			expect(names(second, pattern)).toEqual(names(first, pattern))
			expect(await textOf(second, chart)).toContain("Renamed")

			expect((await d.undo()).ok).toBe(true)

			const third = await saved(d)

			expect(names(third, pattern)).toEqual(names(first, pattern))
			expect(await textOf(third, chart)).toBe(before)

			expect((await d.redo()).ok).toBe(true)
			expect(await textOf(await saved(d), chart)).toContain("Renamed")
		})
	}
})

// A deck whose chart's data is an embedded .xls (an OLE object, as a pptx converted from a .ppt holds it): the
// inserted chart's .xlsx swapped for a workbook of the corpus.
const XLS = join(CORPUS_DIR, "xls", "csvkit__test.xls")
const LEGEND_ODP = join(CORPUS_DIR, "odp", "lo__custom_legend_position.odp")
const PLOT_PPTX = join(CORPUS_DIR, "pptx", "pypptx__cht-plot-props.pptx")

// A chart's own Edit Data workbook with every number of its data area (below the header row, right of the label
// column) × 100 and rounded (a product like 4.4 × 100 = 440.00000000000006 would type as text), as the .xlsx Edit
// Data sends back.
async function scaledWorkbook(
	bytes: Uint8Array | undefined
): Promise<{ readonly sheet: ReturnType<WorkbookCells["sheet"]>; readonly workbook: { readonly bytes: Uint8Array } }> {
	const cells = await workbookCells(bytes ?? new Uint8Array())

	if ("kind" in cells) throw new Error(cells.reason)

	const sheet = cells.sheet(cells.sheets[0] ?? "")
	const rows: string[][] = []

	for (let row = 0; row <= (sheet?.lastRow ?? -1); row++) {
		const line: string[] = []

		for (let col = 0; col <= (sheet?.lastCol ?? -1); col++) {
			const cell = sheet?.cell(row, col)

			line.push(
				cell === undefined || cell.kind === "empty"
					? ""
					: row > 0 && col > 0 && cell.kind === "number"
						? String(Math.round(cell.number * 100))
						: cell.text
			)
		}

		rows.push(line)
	}

	const workbook = await textWorkbookXlsx(rows, "Sheet1")

	if (!workbook.ok) throw new Error("no workbook")

	return { sheet, workbook }
}

async function xlsDeck(): Promise<Uint8Array> {
	const d = await driveSession(deckOf("pptx"), "pptx")
	const slide = d.session.deck.slides[0] as SlideRef

	await insertChart(d, slide)
	await saved(d)

	const files = unzipSync(await bytesOf(d))
	const embedded = Object.keys(files).find(name => name.startsWith("ppt/embeddings/")) as string

	delete files[embedded]
	files["ppt/embeddings/Microsoft_Excel_97-2003_Worksheet1.xls"] = readFileSync(XLS)
	files["ppt/charts/_rels/chart1.xml.rels"] = strToU8(
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/Microsoft_Excel_97-2003_Worksheet1.xls"/></Relationships>'
	)
	files["[Content_Types].xml"] = strToU8(
		new TextDecoder()
			.decode(files["[Content_Types].xml"])
			.replace("<Default ", '<Default Extension="xls" ContentType="application/vnd.ms-excel"/><Default ')
	)

	return zipSync(files)
}

describe("chart versions nothing names any more", () => {
	type Drive = Awaited<ReturnType<typeof driveSession>>

	// The versions the session holds ("chart:N", numbered from 1).
	const held = (d: Drive): string[] =>
		Array.from({ length: 64 }, (_, k) => `chart:${String(k + 1)}`).filter(name => heldChart(d.session.deck, name) !== undefined)
	const partOf = (d: Drive, slide: SlideRef): string | undefined => {
		const frame = chartShape(d, slide).frame

		return frame?.kind === "chart" ? frame.part : undefined
	}
	const edits = async (d: Drive, slide: SlideRef, count: number): Promise<void> => {
		const target = { slide, id: chartShape(d, slide).id }

		for (let k = 0; k < count; k++)
			expect(await d.command(chartEditOp(target, { kind: "title", text: `Title ${String(k)}` }))).toMatchObject({ ok: true })
	}

	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: once the history lets go of their steps, only the version the frame names is held`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await insertChart(d, slide)
			await edits(d, slide, 4)
			expect(held(d).length).toBeGreaterThan(1)

			sessionEdits(d.session).history.clear()

			expect(held(d)).toEqual([partOf(d, slide)])
		})

		it(`${format}: a version only a step names survives a prune, so the undo of the chart's delete is exact`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await insertChart(d, slide)
			await edits(d, slide, 2)

			const edited = partOf(d, slide)
			const id = chartShape(d, slide).id

			const other = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.frame === undefined) as ShapeNode
			const move: DeckOp = {
				family: "shape",
				kind: "setXfrm",
				target: { slide, id: other.id },
				xfrm: { ...(other.xfrm as Xfrm), x: 9000 }
			}

			expect(await d.command({ family: "shape", kind: "delete", slide, shapes: [id] })).toMatchObject({ ok: true })
			expect(await d.command(move)).toMatchObject({ ok: true })
			await saved(d)
			expect((await d.undo()).ok).toBe(true)
			expect((await d.undo()).ok).toBe(true)
			expect(partOf(d, slide)).toBe(edited)
			expect((await d.undo()).ok).toBe(true)
			expect((await d.undo()).ok).toBe(true)
			await saved(d)
		})

		it(`${format}: a redo after a prune points the frame at the version its op made`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await insertChart(d, slide)
			await edits(d, slide, 3)

			const last = partOf(d, slide)

			expect((await d.undo()).ok).toBe(true)
			await saved(d)
			expect((await d.redo()).ok).toBe(true)
			expect(partOf(d, slide)).toBe(last)
			await saved(d)
		})
	}

	it("pptx: after a slide copy (it starts no save), the versions of a discarded redo are let go of", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await insertChart(d, slide)
		expect((await clipSlides(d.context, [slide])).ok).toBe(true)
		expect(sessionEdits(d.session).history.saving).toBe(false)

		const made: (string | undefined)[] = []

		for (let k = 0; k < 3; k++) {
			await edits(d, slide, 1)
			made.push(partOf(d, slide))
		}

		expect((await d.undo()).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)
		// The new edits discard the redo of the two undone ones (once the first can no longer be taken back).
		await edits(d, slide, 2)

		expect(heldChart(d.session.deck, made[1] ?? "")).toBeUndefined()
		expect(heldChart(d.session.deck, made[2] ?? "")).toBeUndefined()
		expect(heldChart(d.session.deck, partOf(d, slide) ?? "")).toBeDefined()
	})
})

describe("an embedded .xls", () => {
	it.skipIf(!existsSync(XLS))(
		"Edit Data hands the .xls over and its first commit writes the chart into a new part with an .xlsx",
		async () => {
			const d = await driveSession(await xlsDeck(), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			await viewCapability.render(d.context, [slide])

			const target = { slide, id: chartShape(d, slide).id }
			const data = await chartData(d.context, target, { workbook: true })

			expect(data.workbook?.kind).toBe("xls")

			const workbook = await textWorkbookXlsx(
				[
					["", "S"],
					["x", "5"],
					["y", "6"]
				],
				"Sheet1"
			)

			if (!workbook.ok) throw new Error("no workbook")

			expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

			const archive = await saved(d)
			const slideXml = await textOf(archive, "ppt/slides/slide1.xml")
			const slideRels = await textOf(archive, "ppt/slides/_rels/slide1.xml.rels")
			const rId = /<c:chart [^>]*r:id="([^"]+)"/u.exec(slideXml)?.[1] ?? ""
			const target2 = new RegExp(`Id="${rId}"[^>]*Target="\\.\\./charts/(chart\\d+\\.xml)"`, "u").exec(slideRels)?.[1] ?? ""

			expect(target2).toBe("chart2.xml")

			const rels = await textOf(archive, "ppt/charts/_rels/chart2.xml.rels")

			expect(rels).toContain('Id="rId1"')
			expect(rels).toContain("relationships/package")
			expect(rels).toMatch(/\.xlsx"/u)
			expect(cachedValues(await textOf(archive, "ppt/charts/chart2.xml"))[0]).toEqual([5, 6])
		}
	)
})

describe.skipIf(!existsSync(CORPUS_DIR))("charts of the corpus", () => {
	it.skipIf(!existsSync(LEGEND_ODP))(
		"odp: changes a LibreOffice chart's legend and writes Edit Data's cells into its own table, in its own object",
		async () => {
			const file = LEGEND_ODP
			const d = await driveSession(readFileSync(file), "odp")
			const slide = d.session.deck.slides[0] as SlideRef

			await viewCapability.render(d.context, [slide])

			const shape = chartShape(d, slide)
			const target = { slide, id: shape.id }
			const data = await chartData(d.context, target, { workbook: true })

			expect(data.data).toBe(true)
			expect(data.workbook?.kind).toBe("xlsx")

			const { sheet, workbook } = await scaledWorkbook(data.workbook?.bytes)

			expect(await d.command(chartEditOp(target, { kind: "legend", position: "b" }))).toMatchObject({ ok: true })
			expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

			const archive = await saved(d)
			const objects = names(archive, /^Object \d+\/content\.xml$/u)

			expect(objects).toEqual(Object.keys(unzipSync(readFileSync(file))).filter(name => /^Object \d+\/content\.xml$/u.test(name)))

			const object = await textOf(archive, objects[0] as string)

			expect(object).toContain('chart:legend-position="bottom"')
			expect(object).toContain(`office:value="${String(Math.round((sheet?.cell(1, 1).number ?? 0) * 100))}"`)
		}
	)

	it.skipIf(!existsSync(PLOT_PPTX))("edits a deck's own chart in place and writes its caches from Edit Data's workbook", async () => {
		const file = PLOT_PPTX
		const d = await driveSession(readFileSync(file), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await viewCapability.render(d.context, [slide])

		const shape = chartShape(d, slide)
		const target = { slide, id: shape.id }
		const part = (shape.frame as { part: string }).part.slice(1)
		const data = await chartData(d.context, target, { workbook: true })

		expect(data.info).not.toBeNull()
		expect(data.workbook?.kind).toBe("xlsx")

		const before = unzipSync(readFileSync(file))
		const cached = cachedValues(new TextDecoder().decode(before[part]))
		const { workbook } = await scaledWorkbook(data.workbook?.bytes)

		expect(cached.flat().some(value => value !== 0)).toBe(true)
		expect(await d.command(chartEditOp(target, { kind: "title", text: "Corpus title" }))).toMatchObject({ ok: true })
		expect(await d.command(chartWorkbookOp(target, workbook.bytes))).toMatchObject({ ok: true })

		const archive = await saved(d)

		expect(names(archive, /^ppt\/charts\/chart\d+\.xml$/u)).toEqual(
			Object.keys(before)
				.filter(name => /^ppt\/charts\/chart\d+\.xml$/u.test(name))
				.sort()
		)
		expect(await textOf(archive, part)).toContain("Corpus title")
		// The workbook sent holds the deck's own numbers × 100 (rounded), so the rewritten caches are the cached values × 100.
		expect(cachedValues(await textOf(archive, part))).toEqual(cached.map(series => series.map(value => Math.round(value * 100))))
	})
})

async function bytesOf(d: Awaited<ReturnType<typeof driveSession>>): Promise<Uint8Array> {
	const current = d.drive.files.get(d.drive.current)

	if (current === undefined) throw new Error("no file")

	return Promise.resolve(current)
}
