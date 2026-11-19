import { afterEach, describe, expect, it, vi } from "vitest"
import { XLSX_FEATURES } from "../core/sheet/commands"
import { parseHeaderFooter, runText, type HeaderFooterValues } from "../core/sheet/print/headerFooter"
import { fitScale, paginate, type PrintAxis, type PrintSheet } from "../core/sheet/print/paginate"
import { paperPoints, universalMeasure } from "../core/sheet/print/paper"
import { DEFAULT_PAGE_SETUP, readPageSetup, type SheetPageSetup, type SheetPrintNames } from "../core/sheet/print/setup"
import { xlsxPrintFeature } from "../core/sheet/print/xlsx"
import type { SheetSessionApi } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { transferables } from "../dom/sheet/messages"
import { ZipArchive } from "../core/opc/zipReader"
import { MAX_METAFILE_BYTES } from "../core/metafile/index"
import { withMedia } from "./sheetDrawingsFixtures"
import { brush, emf, rectangle } from "./metafileFixtures"
import { VML_HEAD, changeOf } from "./sheetNotesFixtures"
import { IMMEDIATE, cells, openFixture, savedBytes } from "./sheetSessionFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"
import { buildFixture, parts, type Fixture } from "./xlsxWriteFixtures"

const VALUES: HeaderFooterValues = { page: 3, pages: 9, date: "D", time: "T", file: "book.xlsx", sheet: "Data", path: "/p/" }

function texts(runs: readonly Parameters<typeof runText>[0][]): string {
	return runs.map(run => runText(run, VALUES)).join("")
}

describe("header and footer codes", () => {
	it("splits the three sections and fills in the fields", () => {
		const sections = parseHeaderFooter("&LLeft &A&CPage &P of &N&R&F &D")

		expect(texts(sections.left)).toBe("Left Data")
		expect(texts(sections.center)).toBe("Page 3 of 9")
		expect(texts(sections.right)).toBe("book.xlsx D")
	})

	it("reads text before any section code as the center's", () => {
		expect(texts(parseHeaderFooter("Confidential").center)).toBe("Confidential")
	})

	it("keeps a doubled ampersand as one and offsets the page number", () => {
		const sections = parseHeaderFooter("&CR&&D &P+10 &P-1")

		expect(texts(sections.center)).toBe("R&D 13 2")
	})

	it("toggles bold and italic, and reads a font, a size and a colour", () => {
		const [first, second] = parseHeaderFooter('&C&"Arial,Bold Italic"&14&KFF0000Big&B plain').center

		expect(first).toMatchObject({
			kind: "text",
			text: "Big",
			style: { font: "Arial", bold: true, italic: true, size: 14, color: 0xff0000 }
		})
		expect(second).toMatchObject({ kind: "text", text: " plain", style: { bold: false, italic: true } })
	})

	it("ignores a picture and a theme colour without dropping the text after them", () => {
		const sections = parseHeaderFooter("&L&G&K01+050Logo")

		expect(texts(sections.left)).toBe("Logo")
	})
})

const NO_PRINT: SheetPrintNames = { printArea: null, printTitles: null }

function setupOf(markup: Partial<Parameters<typeof readPageSetup>[0]>, names = NO_PRINT): SheetPageSetup {
	return readPageSetup(
		{ pageSetup: "", pageMargins: "", printOptions: "", headerFooter: "", rowBreaks: "", colBreaks: "", sheetPr: "", ...markup },
		names
	)
}

describe("page setup", () => {
	it("takes the schema's defaults and Excel's normal margins when the sheet has none", () => {
		expect(setupOf({})).toEqual(DEFAULT_PAGE_SETUP)
	})

	it("reads pageSetup, margins, options and fitToPage", () => {
		const setup = setupOf({
			pageSetup:
				'<pageSetup paperSize="9" orientation="landscape" scale="85" fitToWidth="2" fitToHeight="0" pageOrder="overThenDown" useFirstPageNumber="1" firstPageNumber="5" r:id="rId1"/>',
			pageMargins: '<pageMargins left="0.25" right="0.25" top="1" bottom="1" header="0.5" footer="0.5"/>',
			printOptions: '<printOptions gridLines="1" headings="true" horizontalCentered="1"/>',
			sheetPr: '<sheetPr><tabColor rgb="FFFF0000"/><pageSetUpPr fitToPage="1"/></sheetPr>'
		})

		expect(setup).toMatchObject({
			paperSize: 9,
			paper: paperPoints(9),
			orientation: "landscape",
			scale: 85,
			fitToPage: true,
			fitToWidth: 2,
			fitToHeight: 0,
			pageOrder: "overThenDown",
			firstPageNumber: 5,
			margins: { left: 0.25, right: 0.25, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
			gridLines: true,
			headings: true,
			horizontalCentered: true,
			verticalCentered: false
		})
	})

	it("prefers custom paper to paperSize", () => {
		const setup = setupOf({ pageSetup: '<pageSetup paperSize="9" paperWidth="100mm" paperHeight="5in"/>' })

		expect(setup.customPaper).toBe(true)
		expect(setup.paper.width).toBeCloseTo((100 * 72) / 25.4)
		expect(setup.paper.height).toBe(360)
		expect(universalMeasure("0mm")).toBeNull()
		expect(universalMeasure("12 parsecs")).toBeNull()
	})

	it("keeps manual breaks only, as the rows and columns new pages start at", () => {
		const setup = setupOf({
			rowBreaks:
				'<rowBreaks count="3" manualBreakCount="2"><brk id="40" max="16383" man="1"/><brk id="20" max="16383" man="1"/><brk id="60"/></rowBreaks>',
			colBreaks: '<colBreaks count="1" manualBreakCount="1"><brk id="5" max="1048575" man="1"/></colBreaks>'
		})

		expect(setup.rowBreaks).toEqual([20, 40])
		expect(setup.colBreaks).toEqual([5])
	})

	it("reads the print area's ranges and the print titles, sheet names quoted with commas included", () => {
		const setup = setupOf({}, { printArea: "'a, b'!$A$1:$C$10,'a, b'!$E$2:$F$3", printTitles: "'a, b'!$A:$B,'a, b'!$1:$2" })

		expect(setup.printArea).toEqual([
			{ startRow: 0, startCol: 0, endRow: 9, endCol: 2 },
			{ startRow: 1, startCol: 4, endRow: 2, endCol: 5 }
		])
		expect(setup.titleRows).toEqual({ first: 0, last: 1 })
		expect(setup.titleCols).toEqual({ first: 0, last: 1 })
	})

	it("prints the used range when the print area lost its cells", () => {
		expect(setupOf({}, { printArea: "Data!#REF!", printTitles: null }).printArea).toBeNull()
	})

	it("reads the header and footer texts", () => {
		const setup = setupOf({
			headerFooter:
				'<headerFooter differentFirst="1"><oddHeader>&amp;CTitle</oddHeader><oddFooter>&amp;P</oddFooter><firstFooter>first</firstFooter></headerFooter>'
		})

		expect(setup.headerFooter).toMatchObject({
			differentFirst: true,
			odd: { header: "&CTitle", footer: "&P" },
			first: { footer: "first" }
		})
	})
})

function axis(count: number, size: number, sizes: Readonly<Record<number, number>> = {}): PrintAxis {
	return { count, size: index => sizes[index] ?? size }
}

// Letter portrait with no margins: 612 by 792 points.
const BARE: SheetPageSetup = { ...DEFAULT_PAGE_SETUP, margins: { left: 0, right: 0, top: 0, bottom: 0, header: 0, footer: 0 } }

function sheet(setup: Partial<SheetPageSetup>, rows: PrintAxis, cols: PrintAxis, endRow: number, endCol: number): PrintSheet {
	return { setup: { ...BARE, ...setup }, rows, cols, ranges: [{ startRow: 0, startCol: 0, endRow, endCol }] }
}

describe("pagination", () => {
	it("fills each page with whole rows and columns", () => {
		// 792 / 15 = 52.8 rows, 612 / 48 = 12.75 columns.
		const laid = paginate(sheet({}, axis(1000, 15), axis(100, 48), 99, 19))

		expect(laid.pages.map(page => [page.rows.first, page.rows.last, page.cols.first, page.cols.last])).toEqual([
			[0, 51, 0, 11],
			[52, 99, 0, 11],
			[0, 51, 12, 19],
			[52, 99, 12, 19]
		])
	})

	it("goes over then down when asked", () => {
		const laid = paginate(sheet({ pageOrder: "overThenDown" }, axis(1000, 15), axis(100, 48), 99, 19))

		expect(laid.pages.map(page => [page.rows.first, page.cols.first])).toEqual([
			[0, 0],
			[0, 12],
			[52, 0],
			[52, 12]
		])
	})

	it("starts a page at each manual break and skips hidden rows", () => {
		const laid = paginate(sheet({ rowBreaks: [10] }, axis(100, 15, { 3: 0, 4: 0 }), axis(10, 48), 30, 2))

		expect(laid.pages.map(page => [page.rows.first, page.rows.last])).toEqual([
			[0, 9],
			[10, 30]
		])
	})

	it("repeats the title rows on the pages after them and leaves room for them", () => {
		const laid = paginate(sheet({ titleRows: { first: 0, last: 1 } }, axis(1000, 15), axis(10, 48), 199, 2))

		expect(laid.pages[0]).toMatchObject({ rows: { first: 0, last: 51 }, titleRows: null })
		// 52.8 rows less two title rows.
		expect(laid.pages[1]).toMatchObject({ rows: { first: 52, last: 101 }, titleRows: { first: 0, last: 1 } })
	})

	it("scales the content", () => {
		const laid = paginate(sheet({ scale: 50 }, axis(1000, 15), axis(10, 48), 199, 2))

		expect(laid.scale).toBe(0.5)
		expect(laid.pages[0]?.rows).toEqual({ first: 0, last: 104 })
	})

	it("fits to one page wide by any number tall at the largest whole percent, ignoring manual breaks", () => {
		const fitted = sheet({ fitToPage: true, fitToWidth: 1, fitToHeight: 0, colBreaks: [5] }, axis(1000, 15), axis(100, 48), 199, 19)

		// 20 columns of 48 points on 612: 63.75 %.
		expect(fitScale(fitted)).toBe(63)

		const laid = paginate(fitted)

		expect(new Set(laid.pages.map(page => page.cols.first))).toEqual(new Set([0]))
	})

	it("lays out no more pages than asked, walking only the rows they hold, and says more would follow", () => {
		let walked = 0
		const rows: PrintAxis = {
			count: 1_048_576,
			size: () => {
				walked++

				return 15
			}
		}

		for (const setup of [{}, { fitToPage: true, fitToWidth: 1, fitToHeight: 0 }]) {
			walked = 0

			const laid = paginate(sheet(setup, rows, axis(10, 48), 1_048_575, 3), 500)

			expect(laid.pages).toHaveLength(500)
			expect(laid.more).toBe(true)
			expect(walked).toBeLessThan(60_000)
		}

		expect(paginate(sheet({}, axis(1000, 15), axis(10, 48), 99, 3), 500).more).toBe(false)
		// The cap reached exactly: nothing more.
		expect(paginate(sheet({}, axis(1000, 15), axis(10, 48), 103, 3), 2)).toMatchObject({ pages: { length: 2 }, more: false })
		expect(paginate(sheet({}, axis(1000, 15), axis(10, 48), 104, 3), 2)).toMatchObject({ pages: { length: 2 }, more: true })
	})

	it("never fits larger than 100 % nor smaller than 10 %", () => {
		expect(fitScale(sheet({ fitToPage: true }, axis(10, 15), axis(10, 48), 3, 3))).toBe(100)
		expect(fitScale(sheet({ fitToPage: true }, axis(1_000_000, 15), axis(10, 48), 999_999, 3))).toBe(10)
	})

	it("turns the paper for landscape and keeps the margins and headings off the content", () => {
		const laid = paginate({
			setup: { ...DEFAULT_PAGE_SETUP, orientation: "landscape", headings: true },
			rows: axis(100, 15),
			cols: axis(100, 48),
			ranges: [{ startRow: 0, startCol: 0, endRow: 99, endCol: 2 }]
		})

		expect(laid.paper).toEqual({ width: 792, height: 612 })
		expect(laid.area).toEqual({ x: 0.7 * 72, y: 0.75 * 72, width: 792 - 1.4 * 72, height: 612 - 1.5 * 72 })
		expect(laid.headingHeight).toBe(15)
		// (504 - 15) / 15 = 32.6 rows.
		expect(laid.pages[0]?.rows).toEqual({ first: 0, last: 31 })
	})
})

const FEATURES = XLSX_FEATURES.includes(xlsxPrintFeature) ? [] : [xlsxPrintFeature]

async function open(fixture: Fixture): Promise<{ session: SheetSessionApi; bytes: Uint8Array }> {
	const bytes = buildFixture(fixture)
	const host = inThreadSheetHost({ features: FEATURES })
	const result = await host.open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`${result.kind}: ${"message" in result ? result.message : ""}`)

	await result.session.intent()

	return { session: result.session, bytes }
}

const PRINTED: Fixture = {
	sheets: [
		{
			name: "Data",
			body:
				'<sheetPr><tabColor rgb="FF00FF00"/></sheetPr><sheetData><row r="2"><c r="C2"><v>1</v></c></row><row r="5"><c r="E5"><v>2</v></c></row></sheetData>' +
				'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
				'<pageSetup paperSize="9" orientation="portrait" r:id="rId1"/>',
			rels: '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/>'
		}
	],
	workbookTail: '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$1</definedName></definedNames>',
	parts: {
		"xl/printerSettings/printerSettings1.bin": {
			text: "devmode",
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"
		}
	}
}

describe("print settings in a session", () => {
	it("answers the rows at the heights the file stores, each answer owning its buffers (a worker transfers them)", async () => {
		const { session } = await open({
			sheets: [
				{
					name: "Data",
					body: '<sheetFormatPr defaultRowHeight="15.5"/><sheetData><row r="2" ht="12.8" customHeight="1"><c r="A2"><v>1</v></c></row><row r="3" hidden="1"><c r="A3"><v>2</v></c></row><row r="4"><c r="A4"><v>3</v></c></row></sheetData>'
				}
			]
		})
		const rows = await session.query("print.rows", { sheet: 0 })

		expect(rows?.defaultSize).toBeCloseTo(20.667, 3)
		expect(Array.from(rows?.indices ?? [])).toEqual([1, 2])
		expect(rows?.sizes[0]).toBeCloseTo(17.067, 3)
		expect(Array.from(rows?.flags ?? [])).toEqual([0, 1])
		const again = await session.query("print.rows", { sheet: 0 })

		expect(again).toEqual(rows)
		expect(again?.indices.buffer).not.toBe(rows?.indices.buffer)

		changeOf(await session.command({ type: "cells.set", sheet: 0, cells: cells([[1, 0, "4"]]) }))
		changeOf(
			await session.command({ type: "axis.resize", sheet: 0, axis: "rows", indices: Uint32Array.of(3), sizes: Float32Array.of(40) })
		)
		expect(Array.from((await session.query("print.rows", { sheet: 0 }))?.indices ?? [])).toEqual([1, 2, 3])
	})

	it("builds the rows in slices, giving the host a turn between them", async () => {
		let rows = ""

		for (let row = 1; row <= 20_000; row++)
			rows += `<row r="${String(row)}" ht="12.8" customHeight="1"><c r="A${String(row)}"><v>1</v></c></row>`

		let clock = 0
		let turns = 0
		const slicing = {
			sliceMs: 1,
			// Every look at the clock finds the slice used up.
			now: () => (clock += 10),
			pause: () => {
				turns++

				return Promise.resolve()
			}
		}
		const host = inThreadSheetHost({ features: FEATURES })
		const opened = await host.open(
			buildFixture({ sheets: [{ name: "S", body: `<sheetData>${rows}</sheetData>` }] }),
			{ kind: "xlsx", slicing },
			() => undefined
		)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		await opened.session.intent()

		const before = turns
		const built = await opened.session.query("print.rows", { sheet: 0 })

		expect(built?.indices.length).toBe(20_000)
		expect(turns - before).toBeGreaterThan(2)
	})

	it("answers the sheet's setup and the used range from A1", async () => {
		const { session } = await open(PRINTED)
		const answer = await session.query("print.settings", { sheet: 0 })

		expect(answer?.setup).toMatchObject({ paperSize: 9, titleRows: { first: 0, last: 0 }, printArea: null })
		expect(answer?.used).toEqual({ startRow: 0, startCol: 0, endRow: 4, endCol: 4 })
	})

	it("writes the dialog's choices into the sheet's elements, keeping the printer settings link, and undoes to the source", async () => {
		const { session, bytes } = await open(PRINTED)
		const result = await session.command({
			type: "print.setup",
			sheet: 0,
			patch: { orientation: "landscape", fit: { width: 1, height: 0 }, gridLines: true, headings: true }
		})

		expect(result.ok).toBe(true)

		const answer = await session.query("print.settings", { sheet: 0 })

		expect(answer?.setup).toMatchObject({
			orientation: "landscape",
			fitToPage: true,
			fitToWidth: 1,
			fitToHeight: 0,
			gridLines: true,
			headings: true
		})

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain('<sheetPr><tabColor rgb="FF00FF00"/><pageSetUpPr fitToPage="1"/></sheetPr>')
		expect(sheetXml).toContain('<printOptions gridLines="1" headings="1"/><pageMargins')
		expect(sheetXml).toContain('<pageSetup paperSize="9" orientation="landscape" r:id="rId1" fitToHeight="0"/>')

		await session.undo()

		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])

		await session.redo()

		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(sheetXml)
	})

	it("scaling turns fitting off, and a chosen paper replaces a custom one", async () => {
		const { session } = await open({
			sheets: [
				{
					name: "S",
					body: '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetData/><pageSetup paperWidth="100mm" paperHeight="200mm"/>'
				}
			]
		})

		await session.command({ type: "print.setup", sheet: 0, patch: { scale: 75, paperSize: 1 } })

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain("<sheetPr><pageSetUpPr/></sheetPr>")
		expect(sheetXml).toContain('<pageSetup paperSize="1" scale="75"/>')
		expect((await session.query("print.settings", { sheet: 0 }))?.setup).toMatchObject({
			fitToPage: false,
			scale: 75,
			customPaper: false
		})
	})

	it("adds the margins element in schema order when the sheet had none, and refuses settings out of range", async () => {
		const { session } = await open({ sheets: [{ name: "S", body: "<sheetData/>" }] })

		await session.command({
			type: "print.setup",
			sheet: 0,
			patch: { margins: { left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5 }, verticalCentered: true }
		})

		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain(
			'<sheetData/><printOptions verticalCentered="1"/><pageMargins left="1" right="1" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>'
		)

		for (const patch of [
			{ scale: 5 },
			{ paperSize: 48 },
			{ fit: { width: -1, height: 1 } },
			{ scale: 50, fit: { width: 1, height: 1 } }
		]) {
			const refused = await session.command({ type: "print.setup", sheet: 0, patch })

			expect(refused.ok).toBe(false)
		}
	})

	it("changes nothing when the choices are what the file has", async () => {
		const { session, bytes } = await open(PRINTED)

		// Accepted, not refused: a refusal leaves the same state.
		changeOf(
			await session.command({
				type: "print.setup",
				sheet: 0,
				patch: { orientation: "portrait", paperSize: 9, scale: 100, gridLines: false }
			})
		)

		expect((await session.query("print.settings", { sheet: 0 }))?.setup.orientation).toBe("portrait")
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
	})

	it("keeps the written settings through a structure edit and its undo, with the manual breaks moved", async () => {
		const { session } = await open({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><rowBreaks count="1" manualBreakCount="1"><brk id="10" max="16383" man="1"/></rowBreaks>'
				}
			]
		})

		await session.command({ type: "print.setup", sheet: 0, patch: { orientation: "landscape" } })

		const inserted = await session.command({ type: "axis.insert", sheet: 0, axis: "rows", at: 2, count: 3 })

		expect(inserted.ok).toBe(true)
		expect((await session.query("print.settings", { sheet: 0 }))?.setup).toMatchObject({ orientation: "landscape", rowBreaks: [13] })

		await session.undo()

		expect((await session.query("print.settings", { sheet: 0 }))?.setup).toMatchObject({ orientation: "landscape", rowBreaks: [10] })
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<pageSetup orientation="landscape"/>')
	})
})

// A sheet whose header shows the metafile `media` as its picture.
function headerPicture(media: Uint8Array): Uint8Array {
	return withMedia(
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
		{ "xl/media/image1.emf": media }
	)
}

describe("header pictures", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	// The names of the zip entries inflated from now on.
	function inflated(): string[] {
		const names: string[] = []
		const read = ZipArchive.prototype.read
		const readSliced = ZipArchive.prototype.readSliced

		vi.spyOn(ZipArchive.prototype, "read").mockImplementation(function (this: ZipArchive, entry) {
			names.push(entry.name)

			return read.call(this, entry)
		})
		vi.spyOn(ZipArchive.prototype, "readSliced").mockImplementation(function (this: ZipArchive, entry, slicing) {
			names.push(entry.name)

			return readSliced.call(this, entry, slicing)
		})

		return names
	}

	it("refuses a metafile larger than the limit by its stored size, without inflating it", async () => {
		const { session } = await openFixture(headerPicture(new Uint8Array(MAX_METAFILE_BYTES + 1)))
		const names = inflated()

		expect(await session.query("print.headerImages", { sheet: 0 })).toEqual([])
		expect(names).not.toContain("xl/media/image1.emf")
	}, 60_000)

	it("converts a metafile once however often the print is laid out", async () => {
		const { session } = await openFixture(headerPicture(rectangle(brush(emf(), 1, 0x0000ff), 0, 0, 500, 250).build()))
		const names = inflated()
		const first = await session.query("print.headerImages", { sheet: 0 })

		expect(first).toMatchObject([{ position: "CH", image: { kind: "drawing" } }])
		expect(await session.query("print.headerImages", { sheet: 0 })).toEqual(first)
		expect(names.filter(name => name === "xl/media/image1.emf")).toHaveLength(1)
	})

	it("answers every layout with buffers of its own, as a worker transfers them", async () => {
		const { session } = await openFixture(headerPicture(rectangle(brush(emf(), 1, 0x0000ff), 0, 0, 500, 250).build()))
		const posted = async () => {
			const answer = await session.query("print.headerImages", { sheet: 0 })
			const transfer = transferables(answer)

			expect(transfer.length).toBeGreaterThan(0)

			return structuredClone(answer, { transfer })
		}
		const first = await posted()

		expect(first).toMatchObject([{ position: "CH", image: { kind: "drawing" } }])
		expect(await posted()).toEqual(first)
	})
})
