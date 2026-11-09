import { mkdirSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync, inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { MAX_PRINT_PAGES } from "../core/sheet/print/paginate"
import { DEFAULT_PAGE_SETUP, type SheetPageSetup } from "../core/sheet/print/setup"
import type { SheetSessionApi, SheetWorkbookInfo } from "../core/sheet/protocol"
import { exportSheetPdf, type SheetPdfRequest } from "../react/sheet/print/pdfExport"
import { readSfnt } from "../core/fonts/sfnt"
import type { PdfByteStream, PdfFontAssets } from "../core/pdfwrite/fonts/assets"
import { directoryRecord, gsubTable, multiply } from "./pdfFontLimitsFixtures"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"
import { openFixture } from "./sheetSessionFixtures"
import { buildFixture } from "./xlsxWriteFixtures"
import { KEPT, SOLD, barChart, chartFixture, withChartsheet } from "./sheetChartFixtures"
import { unzipSync, zipSync } from "fflate"

const VALUES = { date: "1/2/2026", time: "10:00", file: "book.xlsx", path: "" }

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

async function opened(body: string): Promise<{ session: SheetSessionApi; info: SheetWorkbookInfo }> {
	const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "Data", body }] }))

	for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

	return { session, info }
}

function request(info: SheetWorkbookInfo, count: number, setup: SheetPageSetup = SETUP): SheetPdfRequest {
	const ranges = [{ startRow: 0, startCol: 0, endRow: count - 1, endCol: 1 }]

	return {
		sheets: [{ sheet: 0, name: "Data", setup, ranges, used: ranges[0] ?? null }],
		values: VALUES,
		title: "book.xlsx",
		lang: "en",
		kind: info.kind,
		summaries: info.sheets,
		date1904: info.date1904,
		showFormulas: false
	}
}

// The PDF's bytes with every Flate stream inflated after it, so tests can read content and object streams.
function readable(bytes: Uint8Array): string {
	const text = Buffer.from(bytes).toString("latin1")
	let out = text

	for (const match of text.matchAll(/stream\r?\n/g)) {
		const start = (match.index ?? 0) + match[0].length
		const end = text.indexOf("endstream", start)

		try {
			out += `\n${inflateSync(Buffer.from(bytes.subarray(start, end))).toString("latin1")}`
		} catch {
			// Not deflated (or not a stream of ours).
		}
	}

	return out
}

describe("a sheet's print as a PDF", () => {
	it("has a page per printed page, each a tagged table, with the print's header and footer", async () => {
		const { session, info } = await opened(rows(120))
		const result = await exportSheetPdf(request(info, 120), { session, assets: nodeFontAssets, deterministic: true })

		expect(result.ok).toBe(true)

		if (!result.ok) return

		expect(result.pages).toBe(3)

		const bytes = pdfBytes(result.output.parts)
		const out = process.env["FILEN_OFFICE_PDF_OUT"]

		if (out !== undefined) {
			mkdirSync(out, { recursive: true })
			writeFileSync(`${out}/rows.pdf`, bytes)
		}

		const text = readable(bytes)

		expect(text).toContain("/Count 3")
		expect(text).toContain("/StructTreeRoot")
		expect(text).toMatch(/\/S \/Table/)
		expect(text).toMatch(/\/S \/TH/)
		expect(text).toMatch(/\/Subtype \/Header/)
		session.close()
	})

	it("carries the workbook's author, subject and keywords, as Excel's Save as PDF does", async () => {
		const { session, info } = await opened(rows(2))
		const result = await exportSheetPdf(
			{ ...request(info, 2), properties: { author: "Ann", subject: "Q3", keywords: "money" } },
			{ session, assets: nodeFontAssets, deterministic: true }
		)

		expect(result.ok).toBe(true)

		if (!result.ok) return

		const text = readable(pdfBytes(result.output.parts))

		expect(text).toContain("/Author (Ann)")
		expect(text).toContain("/Subject (Q3)")
		expect(text).toContain("/Keywords (money)")
		expect(text).toContain("<dc:creator><rdf:Seq><rdf:li>Ann</rdf:li></rdf:Seq></dc:creator>")
		session.close()
	})

	it("refuses a print with nothing to print", async () => {
		const { session, info } = await opened("<sheetData/>")
		const result = await exportSheetPdf(
			{ ...request(info, 1), sheets: [{ sheet: 0, name: "Data", setup: SETUP, ranges: [], used: null }] },
			{ session, assets: nodeFontAssets, deterministic: true }
		)

		expect(result).toEqual({ ok: false, reason: "nothing" })
		session.close()
	})

	it("encrypts the PDF with the workbook's own password (AES-256)", async () => {
		const { session, info } = await opened(rows(10))
		const result = await exportSheetPdf(request(info, 10), { session, assets: nodeFontAssets, deterministic: true, password: "secret" })

		if (!result.ok) throw new Error(result.reason)

		const text = Buffer.from(pdfBytes(result.output.parts)).toString("latin1")

		expect(text).toContain("/Encrypt")
		expect(text).toContain("/AESV3")
		expect(text).not.toContain("row 1")
		session.close()
	})

	it("refuses a workbook password a PDF cannot be protected with, before laying anything out", async () => {
		const { session, info } = await opened(rows(10))
		let layouts = 0
		const watched = new Proxy(session, {
			get(target, key, receiver) {
				if (key === "layout") layouts++

				return Reflect.get(target, key, receiver) as unknown
			}
		})
		// SASLprep (RFC 4013 §6) refuses right-to-left letters mixed with left-to-right ones.
		const result = await exportSheetPdf(request(info, 10), {
			session: watched,
			assets: nodeFontAssets,
			deterministic: true,
			password: "a\u05D0"
		})

		expect(result).toEqual({ ok: false, reason: "passwordUnsupported" })
		expect(layouts).toBe(0)
		session.close()
	})

	it("counts the runs drawn without their font's shaping when a face's substitutions would pass the shaper's limits", async () => {
		const faces: string[] = []
		// Every face the export opens has a GSUB that multiplies "a" 2^24 times: past the length limit at once.
		const hostile: PdfFontAssets = {
			open: async file => {
				faces.push(file)

				const stream = await nodeFontAssets.open(file)

				if (!file.endsWith(".ttf.gz")) return stream

				const font = new Uint8Array(gunzipSync(await new Response(stream as unknown as ReadableStream<Uint8Array>).arrayBuffer()))
				const a = readSfnt(font).glyphId(0x61)
				const table = gsubTable(Array.from({ length: 24 }, () => [2, multiply(a, 2)] as const))
				// Written over the face's own GSUB: the file keeps the size its manifest records.
				const record = directoryRecord(font, "GSUB")
				const view = new DataView(font.buffer, font.byteOffset, font.byteLength)

				expect(table.length).toBeLessThanOrEqual(view.getUint32(record + 12))
				font.set(table, view.getUint32(record + 8))
				view.setUint32(record + 12, table.length)

				return new Blob([gzipSync(font)]).stream() as unknown as PdfByteStream
			}
		}
		const { session, info } = await opened(
			'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>aaaaaaaaaa</t></is></c></row></sheetData>'
		)
		const result = await exportSheetPdf(request(info, 1), { session, assets: hostile, deterministic: true })

		expect(faces.length).toBeGreaterThan(0)
		expect(result.ok && result.unshapedRuns).toBeGreaterThan(0)
		session.close()
	})

	it("refuses a print past the page cap rather than cutting it short", async () => {
		const { session, info } = await opened(rows(1))
		const breaks = Array.from({ length: MAX_PRINT_PAGES + 1 }, (_, k) => k + 1)
		const many = request(info, MAX_PRINT_PAGES + 2, {
			...SETUP,
			rowBreaks: breaks,
			titleRows: null,
			headerFooter: DEFAULT_PAGE_SETUP.headerFooter
		})
		const result = await exportSheetPdf(many, { session, assets: nodeFontAssets, deterministic: true })

		expect(result).toMatchObject({ ok: false, reason: "tooManyPages" })
		session.close()
	})

	it("stops at an abort, with the error a cancelled export throws", async () => {
		const { session, info } = await opened(rows(120))
		const signal = { aborted: false }
		const running = exportSheetPdf(request(info, 120), {
			session,
			assets: nodeFontAssets,
			deterministic: true,
			signal,
			progress: () => {
				signal.aborted = true
			}
		})

		await expect(running).rejects.toMatchObject({ name: "AbortError" })
		session.close()
	})

	it("links a hyperlinked cell through a Link element around its text and annotation", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Filen</t></is></c></row></sheetData>' +
			'<hyperlinks><hyperlink ref="A1" r:id="rId9"/></hyperlinks>'
		const bytes = buildFixture({
			sheets: [
				{
					name: "Data",
					body,
					rels: '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://filen.io/" TargetMode="External"/>'
				}
			]
		})
		const { session, info } = await openFixture(bytes)

		for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const result = await exportSheetPdf(request(info, 1, DEFAULT_PAGE_SETUP), { session, assets: nodeFontAssets, deterministic: true })

		if (!result.ok) throw new Error(result.reason)

		const text = readable(pdfBytes(result.output.parts))

		expect(text).toMatch(/\/S \/Link/)
		expect(text).toContain("(https://filen.io/)")
		expect(text).toMatch(/\/Subtype \/Link/)
		session.close()
	})

	it("loads the faces a page's text needs before drawing it: scripts the sheet's font lacks draw in their fallback", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Καλημέρα</t></is></c></row>' +
			'<row r="60"><c r="A60" t="inlineStr"><is><t>日本語のテキスト</t></is></c></row>' +
			'<row r="61"><c r="A61" t="inlineStr"><is><t>שלום עולם</t></is></c></row></sheetData>'
		const { session, info } = await opened(body)
		const result = await exportSheetPdf(request(info, 61, DEFAULT_PAGE_SETUP), { session, assets: nodeFontAssets, deterministic: true })

		if (!result.ok) throw new Error(result.reason)

		expect(result.pages).toBe(2)
		expect(result.missingGlyphs).toBe(0)
		expect(readable(pdfBytes(result.output.parts))).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans(CJK|JP|SC|TC|Hebrew)/)
		session.close()
	})

	it("prints a chartsheet's chart on a page of its own, with the chartsheet's paper, orientation and margins", async () => {
		const files: Record<string, Uint8Array> = unzipSync(
			withChartsheet(buildFixture(chartFixture(barChart([SOLD]))), barChart([SOLD, KEPT]))
		)
		const sheetXml = new TextDecoder().decode(files["xl/chartsheets/sheet9.xml"])

		files["xl/chartsheets/sheet9.xml"] = new TextEncoder().encode(
			sheetXml.replace(
				'<drawing r:id="rId1"/>',
				'<pageMargins left="1" right="1" top="1" bottom="1" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape"/><drawing r:id="rId1"/>'
			)
		)

		const { session, info } = await openFixture(zipSync(files))

		for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

		const graph = info.sheets.find(sheet => sheet.name === "Graph")

		if (graph === undefined) throw new Error("no chartsheet")

		const settings = await session.query("print.settings", { sheet: graph.id })

		expect(settings?.chart).toMatchObject({ width: 5_486_400, height: 3_657_600 })
		expect(settings?.setup).toMatchObject({ orientation: "landscape", paperSize: 9, margins: { left: 1, top: 1 } })

		const result = await exportSheetPdf(
			{
				...request(info, 1, DEFAULT_PAGE_SETUP),
				sheets: [
					{
						sheet: graph.id,
						name: "Graph",
						setup: settings?.setup ?? DEFAULT_PAGE_SETUP,
						ranges: [],
						used: null,
						...(settings?.chart !== undefined && { chart: settings.chart })
					}
				]
			},
			{ session, assets: nodeFontAssets, deterministic: true }
		)

		if (!result.ok) throw new Error(result.reason)

		const text = readable(pdfBytes(result.output.parts))

		expect(result.pages).toBe(1)
		// A4 landscape.
		expect(text).toMatch(/\/MediaBox \[0 0 841\.89 595\.27\d\]/)
		expect(text).toMatch(/\/S \/Figure/)
		expect(text).toContain("(Chart: Graph)")
		session.close()
	})
})
