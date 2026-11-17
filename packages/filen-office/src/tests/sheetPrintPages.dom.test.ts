// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { DEFAULT_PAGE_SETUP, type SheetPageSetup } from "../core/sheet/print/setup"
import { tileKey, type SheetRange } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { renderPrintPage } from "../react/sheet/print/printJob"
import { layOutPrint, pageCount, printPageAt, PrintPageTooLarge } from "../react/sheet/print/printLayout"
import { clampRanges } from "../react/sheet/print/printPage"
import { SvgCanvas } from "../react/sheet/print/svgCanvas"
import { KEPT, SOLD, barChart, chartFixture } from "./sheetChartFixtures"
import { DRAWINGS, PNG, bitmapEmf, withMedia } from "./sheetDrawingsFixtures"
import { NOTES, VML_HEAD } from "./sheetNotesFixtures"
import { buildFixture, openFixture } from "./sheetSessionFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"

// Text measures 6 points per character, whatever the font.
const MEASURE = (_font: string, text: string): number => text.length * 6

describe("the SVG canvas", () => {
	it("writes rectangles under their transform, grouped by clip", () => {
		const canvas = new SvgCanvas("t-", MEASURE)

		canvas.setTransform(-1, 0, 0, 1, 100, 0)
		canvas.fillStyle = "#ff0000"
		canvas.fillRect(10, 5, 20, 4)
		canvas.save()
		canvas.beginPath()
		canvas.rect(0, 0, 50, 50)
		canvas.clip()
		canvas.fillRect(0, 0, 1, 1)
		canvas.fillRect(2, 2, 1, 1)
		canvas.restore()
		canvas.fillRect(0, 0, 1, 1)

		expect(canvas.markup()).toBe(
			'<defs><clipPath id="t-c0"><rect x="50" y="0" width="50" height="50"/></clipPath></defs>' +
				'<g><rect x="70" y="5" width="20" height="4" fill="#ff0000"/></g>' +
				'<g clip-path="url(#t-c0)"><rect x="99" y="0" width="1" height="1" fill="#ff0000"/><rect x="97" y="2" width="1" height="1" fill="#ff0000"/></g>' +
				'<g><rect x="99" y="0" width="1" height="1" fill="#ff0000"/></g>'
		)
	})

	it("writes text with its font, alignment and escapes, and measures with the measure it was given", () => {
		const canvas = new SvgCanvas("t-", MEASURE)

		canvas.font = 'bold 14px "A&B", sans-serif'
		canvas.textAlign = "center"
		canvas.textBaseline = "middle"
		canvas.fillText("<1 & 2>", 10, 20)

		expect(canvas.measureText("abc").width).toBe(18)
		expect(canvas.markup()).toBe(
			'<g><text x="10" y="20" fill="#000000" style="font:bold 14px &quot;A&amp;B&quot;, sans-serif" text-anchor="middle" dominant-baseline="central">&lt;1 &amp; 2&gt;</text></g>'
		)
	})

	it("keeps a text's leading, trailing and repeated spaces, as a canvas draws them", () => {
		const canvas = new SvgCanvas("t-", MEASURE)

		canvas.fillText(" lead", 0, 0)
		canvas.fillText("two  spaces", 0, 10)
		canvas.fillText("one space", 0, 20)

		expect(canvas.markup()).toBe(
			'<g><text x="0" y="0" xml:space="preserve" fill="#000000" style="font:10px sans-serif"> lead</text>' +
				'<text x="0" y="10" xml:space="preserve" fill="#000000" style="font:10px sans-serif">two  spaces</text>' +
				'<text x="0" y="20" fill="#000000" style="font:10px sans-serif">one space</text></g>'
		)
	})

	it("writes strokes, dashes, circles and gradients", () => {
		const canvas = new SvgCanvas("t-", MEASURE)

		canvas.setTransform(2, 0, 0, 2, 0, 0)
		canvas.setLineDash([2, 1])
		canvas.lineWidth = 1
		canvas.strokeStyle = "#00ff00"
		canvas.beginPath()
		canvas.moveTo(0, 0)
		canvas.lineTo(5, 0)
		canvas.stroke()
		canvas.beginPath()
		canvas.arc(5, 5, 2, 0, Math.PI * 2)
		canvas.fill()

		const gradient = canvas.createLinearGradient(0, 0, 10, 0)

		gradient.addColorStop(0, "#000000")
		gradient.addColorStop(1, "rgba(0, 0, 0, 0.1)")
		canvas.fillStyle = gradient
		canvas.fillRect(0, 0, 10, 1)

		const markup = canvas.markup()

		expect(markup).toContain('<path d="M0 0L10 0" fill="none" stroke="#00ff00" stroke-width="2" stroke-dasharray="4 2"/>')
		expect(markup).toContain('<path d="M14 10A4 4 0 1 1 6 10A4 4 0 1 1 14 10" fill="#000000"/>')
		expect(markup).toContain(
			'<linearGradient id="t-g0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="20" y2="0"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="rgba(0, 0, 0, 0.1)"/></linearGradient>'
		)
		expect(markup).toContain('<rect x="0" y="0" width="20" height="2" fill="url(#t-g0)"/>')
	})
})

describe("clamping what prints", () => {
	it("cuts whole rows and columns at the used range and drops ranges past it", () => {
		const used: SheetRange = { startRow: 0, startCol: 0, endRow: 9, endCol: 3 }

		expect(
			clampRanges(
				[
					{ startRow: 0, startCol: 1, endRow: 1_048_575, endCol: 2 },
					{ startRow: 4, startCol: 0, endRow: 5, endCol: 16_383 },
					{ startRow: 20, startCol: 0, endRow: 1_048_575, endCol: 1 },
					{ startRow: 0, startCol: 0, endRow: 50, endCol: 50 }
				],
				used
			)
		).toEqual([
			{ startRow: 0, startCol: 1, endRow: 9, endCol: 2 },
			{ startRow: 4, startCol: 0, endRow: 5, endCol: 3 },
			{ startRow: 0, startCol: 0, endRow: 50, endCol: 50 }
		])
	})
})

function rows(count: number): string {
	let body = ""

	for (let row = 1; row <= count; row++)
		body += `<row r="${String(row)}"><c r="A${String(row)}" t="inlineStr"><is><t>row ${String(row)}</t></is></c><c r="B${String(row)}"><v>${String(row * 10)}</v></c></row>`

	return `<sheetData>${body}</sheetData>`
}

const SETUP: SheetPageSetup = {
	...DEFAULT_PAGE_SETUP,
	gridLines: true,
	headings: true,
	titleRows: { first: 0, last: 0 },
	headerFooter: { ...DEFAULT_PAGE_SETUP.headerFooter, odd: { header: "&L&A&RPage &P of &N", footer: "&C&F" } }
}

const VALUES = { date: "1/2/2026", time: "10:00", file: "book.xlsx", path: "" }

async function openModel(bytes: Uint8Array): Promise<SheetGridModel> {
	const { session, info } = await openFixture(bytes)

	// Features reading parts beside the sheet (drawings, notes) land in a few turns.
	for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

	return new SheetGridModel({ source: session, edit: session, info })
}

async function printed(count: number, setup: SheetPageSetup = SETUP) {
	const model = await openModel(buildFixture({ sheets: [{ name: "Data", body: rows(count) }] }))
	const ranges = [{ startRow: 0, startCol: 0, endRow: count - 1, endCol: 1 }]
	const job = await layOutPrint(model, [{ sheet: 0, name: "Data", setup, ranges, used: ranges[0] ?? null }], MEASURE)

	return { model, job }
}

// Every page of a one-sheet print over `bytes`, printing its used range with `setup`.
async function pages(bytes: Uint8Array, setup: Partial<SheetPageSetup>): Promise<string[]> {
	const model = await openModel(bytes)
	const settings = await model.session.query("print.settings", { sheet: 0 })

	if (settings === null) throw new Error("no settings")

	const job = await layOutPrint(
		model,
		[
			{
				sheet: 0,
				name: "S",
				setup: { ...settings.setup, ...setup },
				ranges: settings.used === null ? [] : [settings.used],
				used: settings.used
			}
		],
		MEASURE
	)
	const out: string[] = []

	for (let k = 0; k < pageCount(job); k++) out.push((await renderPrintPage({ job, values: VALUES, id: `t${String(k)}` }, k)) ?? "")

	job.dispose()

	return out
}

describe("printed pages", () => {
	it("cuts a sheet into pages and numbers them across the print", async () => {
		const { job } = await printed(120)

		// Letter, normal margins: 684 - 15 points of headings over 15-point rows is 44 rows a page, less a title row after.
		expect(job.sheets[0]?.pagination.pages.map(page => [page.rows.first, page.rows.last])).toEqual([
			[0, 43],
			[44, 86],
			[87, 119]
		])
		expect(pageCount(job)).toBe(3)
		expect(printPageAt(job, 2)).toMatchObject({ number: 3, first: false })
		expect(printPageAt(job, 3)).toBeNull()
	})

	it("lays rows out at the heights the file stores, not at whole pixels", async () => {
		// 15.5 pt rows (20.67 px, shown as 21): Letter with normal margins holds 684 / 15.5 = 44 of them, not 43.
		const body = rows(120)
			.replace("<sheetData>", '<sheetFormatPr defaultRowHeight="15.5"/><sheetData>')
			.replace('<row r="2">', '<row r="2" ht="15.75" customHeight="1">')
		const model = await openModel(buildFixture({ sheets: [{ name: "Data", body }] }))
		const ranges = [{ startRow: 0, startCol: 0, endRow: 119, endCol: 1 }]
		const setup = { ...DEFAULT_PAGE_SETUP, gridLines: true }
		const job = await layOutPrint(model, [{ sheet: 0, name: "Data", setup, ranges, used: ranges[0] ?? null }], MEASURE)
		const pages = job.sheets[0]?.pagination.pages.map(page => [page.rows.first, page.rows.last])

		// Row 2 is 15.75 pt (a whole 21 px): 683.75 of 684 points on the first page.
		expect(pages?.[0]).toEqual([0, 43])
		expect(pages?.[1]).toEqual([44, 87])
		expect(job.sheets[0]?.rows.size(5)).toBeCloseTo(20.667, 2)
		expect(job.sheets[0]?.rows.size(1)).toBe(21)
	})

	it("lays out a print only as far as its page cap, across its sheets, and says more would follow", async () => {
		const model = await openModel(buildFixture({ sheets: [{ name: "Data", body: rows(120) }] }))
		const ranges = [{ startRow: 0, startCol: 0, endRow: 119, endCol: 1 }]
		const request = { sheet: 0, name: "Data", setup: SETUP, ranges, used: ranges[0] ?? null }
		const capped = await layOutPrint(model, [request, { ...request, name: "Again" }], MEASURE, 4)

		expect(capped.sheets.map(entry => entry.pagination.pages.length)).toEqual([3, 1])
		expect(capped.more).toBe(true)
		expect((await layOutPrint(model, [request], MEASURE, 3)).more).toBe(false)
	})

	it("draws a page's cells, its repeated titles, headings, gridlines and the header and footer", async () => {
		const { model, job } = await printed(120)
		const second = (await renderPrintPage({ job, values: VALUES, id: "p" }, 1)) ?? ""

		expect(second.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
		expect(second).toContain('width="612pt" height="792pt" viewBox="0 0 612 792"')
		// The title row repeats above the page's own rows.
		expect(second).toContain(">row 1</text>")
		expect(second).toContain(">row 45</text>")
		expect(second).toContain(">row 87</text>")
		expect(second).not.toContain(">row 88</text>")
		expect(second).not.toContain(">row 44</text>")
		expect(second).toContain(">450</text>")
		// Headings: the letters and the row numbers shown.
		expect(second).toContain(">A</text>")
		expect(second).toContain(">45</text>")
		expect(second).toContain('fill="#a6a6a6"')
		expect(second).toContain(">Data</tspan>")
		expect(second).toContain(">Page 2 of 3</tspan>")
		expect(second).toContain(">book.xlsx</tspan>")
		// Ids are the page's own.
		expect(second).toContain('id="p-1-area"')
		expect(model.tiles.has(tileKey(0, 1, 0))).toBe(true)
	})

	it("draws neither gridlines nor headings when the sheet does not print them", async () => {
		const { job } = await printed(5, { ...DEFAULT_PAGE_SETUP })
		const page = (await renderPrintPage({ job, values: VALUES, id: "q" }, 0)) ?? ""

		expect(page).toContain(">row 5</text>")
		expect(page).not.toContain('fill="#a6a6a6"')
		expect(page).not.toContain(">A</text>")
		expect(page).not.toContain("<tspan")
	})
})

const STYLED =
	'<fonts count="1"><font><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>' +
	'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>'

const ERRORS = buildFixture({
	sheets: [
		{
			name: "S",
			body: '<sheetData><row r="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="B1" s="1" t="inlineStr"><is><t>green</t></is></c></row></sheetData>'
		}
	],
	styles: STYLED
})

describe("what a sheet's print settings change on paper", () => {
	it("prints error values as shown, blank, as dashes or as #N/A", async () => {
		expect((await pages(ERRORS, {}))[0]).toContain(">#DIV/0!</text>")
		expect((await pages(ERRORS, { errors: "blank" }))[0]).not.toContain("#DIV/0!")
		expect((await pages(ERRORS, { errors: "dash" }))[0]).toContain(">--</text>")
		expect((await pages(ERRORS, { errors: "NA" }))[0]).toContain(">#N/A</text>")
	})

	it("prints in black and white: no fills, black text, the rest grey", async () => {
		const colour = (await pages(ERRORS, {}))[0] ?? ""
		const plain = (await pages(ERRORS, { blackAndWhite: true }))[0] ?? ""

		expect(colour).toContain('fill="#00ff00"')
		expect(colour).toContain('fill="#ff0000"')
		expect(plain).not.toContain('fill="#00ff00"')
		expect(plain).not.toContain('fill="#ff0000"')
		expect(plain).toContain('<feColorMatrix type="saturate" values="0"/>')
	})

	it("prints no gridlines in draft quality", async () => {
		expect((await pages(ERRORS, { gridLines: true }))[0]).toContain('fill="#a6a6a6"')
		expect((await pages(ERRORS, { gridLines: true, draft: true }))[0]).not.toContain('fill="#a6a6a6"')
	})

	it("lists the notes after the sheet, or draws the shown ones where they stand", async () => {
		const bytes = buildFixture(NOTES)
		const atEnd = await pages(bytes, { cellComments: "atEnd" })

		expect(atEnd).toHaveLength(2)
		expect(atEnd[1]).toContain(">Cell: B2</text>")
		expect(atEnd[1]).toContain(">Cell: D5</text>")
		expect(atEnd[1]).toContain("first note")

		const shown = await pages(bytes, { cellComments: "asDisplayed" })

		expect(shown).toHaveLength(1)
		expect(shown[0]).toContain('fill="#ffffe1"')
		expect(shown[0]).toContain(">second</text>")
		expect(shown[0]).not.toContain("first note")
		expect((await pages(bytes, {}))[0]).not.toContain('fill="#ffffe1"')
	})

	it("places an object across a page break on both pages, clipped at each page's edge, and grows the used range over it", async () => {
		const bytes = withMedia(
			buildFixture({
				...DRAWINGS,
				sheets: [
					{
						...(DRAWINGS.sheets[0] as (typeof DRAWINGS.sheets)[0]),
						body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"/></rowBreaks><drawing r:id="rId1"/>'
					}
				]
			}),
			{ "xl/media/image1.png": PNG }
		)
		const printedPages = await pages(bytes, {})

		// The picture (B2:D6) and the text box (F2:H4) make the used range A1:H19 (the chart frame ends at row 19).
		expect(printedPages.length).toBeGreaterThanOrEqual(2)
		expect(printedPages[0]).toContain("<image")
		expect(printedPages[1]).toContain("<image")
		expect(printedPages[0]).toContain(">Hello<")
		expect(printedPages[0]).toContain('-over"><rect')
		expect((await pages(bytes, { draft: true }))[0]).not.toContain("<image")
	})

	it("prints a chart drawn from its cells at its frame's size", async () => {
		const page = (await pages(buildFixture(chartFixture(barChart([SOLD, KEPT], { title: "Fruit sold" }))), {}))[0] ?? ""

		expect(page).toContain(">Fruit sold<")
		expect(page).toContain(">Apple<")
	})

	it("prints a header picture where the header names it", async () => {
		const bytes = withMedia(
			buildFixture({
				sheets: [
					{
						name: "S",
						body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><headerFooter><oddHeader>&amp;C&amp;G</oddHeader></headerFooter><legacyDrawingHF r:id="rId1"/>',
						rels: relationship("rId1", "vmlDrawing", "../drawings/vmlDrawing1.vml")
					}
				],
				parts: {
					"xl/drawings/vmlDrawing1.vml": {
						text: `${VML_HEAD}<v:shape id="CH" o:spid="_x0000_s1025" type="#_x0000_t75" style="position:absolute;margin-left:0;margin-top:0;width:72pt;height:36pt;z-index:1"><v:imagedata o:relid="rId1" o:title="logo"/></v:shape></xml>`,
						type: TYPES.vml
					},
					"xl/drawings/_rels/vmlDrawing1.vml.rels": {
						text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "image", "../media/image1.png")}</Relationships>`,
						type: TYPES.relationships
					}
				}
			}),
			{ "xl/media/image1.png": PNG }
		)
		const page = (await pages(bytes, {}))[0] ?? ""

		expect(page).toContain('<image href="blob:')
		expect(page).toContain('width="72" height="36"')
	})

	it("prints the bitmap a metafile carries, as a picture on the sheet and in the header", async () => {
		const bytes = withMedia(
			buildFixture({
				sheets: [
					{
						name: "S",
						body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><headerFooter><oddHeader>&amp;C&amp;G</oddHeader></headerFooter><legacyDrawingHF r:id="rId1"/>',
						rels: relationship("rId1", "vmlDrawing", "../drawings/vmlDrawing1.vml")
					}
				],
				parts: {
					"xl/drawings/vmlDrawing1.vml": {
						text: `${VML_HEAD}<v:shape id="CH" o:spid="_x0000_s1025" type="#_x0000_t75" style="position:absolute;margin-left:0;margin-top:0;width:72pt;height:36pt;z-index:1"><v:imagedata o:relid="rId1" o:title="logo"/></v:shape></xml>`,
						type: TYPES.vml
					},
					"xl/drawings/_rels/vmlDrawing1.vml.rels": {
						text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "image", "../media/image1.emf")}</Relationships>`,
						type: TYPES.relationships
					}
				}
			}),
			{ "xl/media/image1.emf": bitmapEmf() }
		)
		const model = await openModel(bytes)
		const inserted = await model.command({
			type: "drawing.insertImage",
			sheet: 0,
			placement: { from: { row: 1, col: 1, rowOff: 0, colOff: 0 } },
			bytes: bitmapEmf(),
			name: "",
			alt: ""
		})

		expect(inserted.ok).toBe(true)

		const settings = await model.session.query("print.settings", { sheet: 0 })

		if (settings === null) throw new Error("no settings")

		const job = await layOutPrint(
			model,
			[{ sheet: 0, name: "S", setup: settings.setup, ranges: settings.used === null ? [] : [settings.used], used: settings.used }],
			MEASURE
		)
		const page = (await renderPrintPage({ job, values: VALUES, id: "m" }, 0)) ?? ""

		job.dispose()
		// One in the header band, one over the cells.
		expect(page.match(/<image href="blob:/g)).toHaveLength(2)
	})
})

describe("a page with many cells", () => {
	const column = (index: number): string =>
		(index >= 26 ? column(Math.floor(index / 26) - 1) : "") + String.fromCharCode(65 + (index % 26))

	function dense(rows: number, cols: number, extra = ""): Uint8Array {
		const parts: string[] = []

		for (let row = 1; row <= rows; row++) {
			parts.push(`<row r="${String(row)}">`)

			for (let col = 0; col < cols; col++) parts.push(`<c r="${column(col)}${String(row)}"><v>${String(row * 1000 + col)}</v></c>`)

			parts.push("</row>")
		}

		return buildFixture({ sheets: [{ name: "Data", body: `<sheetData>${parts.join("")}</sheetData>${extra}` }] })
	}

	const BIG: SheetPageSetup = { ...DEFAULT_PAGE_SETUP, paper: { width: 14_400, height: 14_400 }, customPaper: true, scale: 10 }

	async function bigJob(bytes: Uint8Array, rows: number, cols: number) {
		const model = await openModel(bytes)
		const ranges = [{ startRow: 0, startCol: 0, endRow: rows - 1, endCol: cols - 1 }]
		const job = await layOutPrint(model, [{ sheet: 0, name: "Data", setup: BIG, ranges, used: ranges[0] ?? null }], MEASURE)

		return { model, job }
	}

	it("draws it in slices, every cell's text once and each slice below the last", async () => {
		const { job } = await bigJob(dense(1_000, 120), 1_000, 120)

		expect(pageCount(job)).toBe(1)

		const page = (await renderPrintPage({ job, values: VALUES, id: "big" }, 0)) ?? ""
		const texts = [...page.matchAll(/<text [^>]*>(\d+)<\/text>/g)].map(match => Number(match[1]))

		expect(texts).toHaveLength(120_000)
		expect(new Set(texts).size).toBe(120_000)

		const offsets = [...page.matchAll(/<g transform="translate\(0 ([\d.]+)\)">/g)].map(match => Number(match[1]))

		expect(offsets.length).toBeGreaterThan(10)
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
		job.dispose()
	}, 120_000)

	it("cuts slices only between rows no merged cell crosses, drawing each block once", async () => {
		const merges = Array.from({ length: 30 }, (_, k) => `<mergeCell ref="A${String(k * 30 + 2)}:B${String(k * 30 + 25)}"/>`).join("")
		const { job } = await bigJob(dense(1_000, 120, `<mergeCells count="30">${merges}</mergeCells>`), 1_000, 120)
		const page = (await renderPrintPage({ job, values: VALUES, id: "merged" }, 0)) ?? ""

		// Each block's anchor (A2, A32, ...) drawn once, its covered cells' values not at all.
		for (let k = 0; k < 30; k++) expect(page.split(`>${String((k * 30 + 2) * 1000)}</text>`)).toHaveLength(2)
		expect(page).not.toContain(`>${String(3 * 1000)}</text>`)
		job.dispose()
	}, 120_000)

	it("gives the page up between slices once cancelled", async () => {
		const { job } = await bigJob(dense(1_000, 120), 1_000, 120)
		const signal = { aborted: false }
		const drawing = renderPrintPage({ job, values: VALUES, id: "gone", signal }, 0)

		signal.aborted = true
		await expect(drawing).rejects.toMatchObject({ name: "AbortError" })
		job.dispose()
	}, 120_000)

	it("refuses a page holding more cells than any real sheet prints on one, without drawing it", async () => {
		const { job } = await bigJob(dense(1_100, 2_000), 1_100, 2_000)

		expect(pageCount(job)).toBe(1)
		await expect(renderPrintPage({ job, values: VALUES, id: "huge" }, 0)).rejects.toBeInstanceOf(PrintPageTooLarge)
		job.dispose()
	}, 300_000)
})
