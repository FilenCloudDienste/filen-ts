import { describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import { bytesSource } from "@filen/office/core/opc"
import { convertSheet, canConvertSheet, sheetSourceFormat, type SheetConversion } from "../core/ods/convert/index"
import { openOds } from "../core/ods/open"
import { openXlsx } from "../core/xlsx/package/open"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { RenderStyleTable } from "../core/sheet/session"
import { CellKind, RowFlag, rowRunAt, type XlsxSheetModel } from "../core/xlsx/model/types"
import type { SheetStore } from "../core/xlsx/model/store"
import type { XlsxWorkbook } from "../core/xlsx/model/workbook"
import { buildWorkbook } from "./xlsxReadFixtures"
import { odsBytes, shownRows, table } from "./odsFixtures"
import { inThreadSheetHost } from "../dom/sheet/host"
import { IMMEDIATE } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"
import { cellRef } from "../core/xlsx/write/text"
import { renameSheetInFormula } from "../core/sheet/refs/formulaRefs"

function converted(result: SheetConversion): Extract<SheetConversion, { ok: true }> {
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result
}

async function readOds(bytes: Uint8Array): Promise<XlsxDocument> {
	const opened = await openOds(bytesSource(bytes))

	if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

	return new XlsxDocument(opened.workbook, new RenderStyleTable(), { kind: "ods" })
}

async function readXlsx(bytes: Uint8Array): Promise<XlsxDocument> {
	const opened = await openXlsx(bytesSource(bytes))

	if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

	for (const entry of opened.workbook.sheets) await opened.workbook.load(entry.id)

	return new XlsxDocument(opened.workbook, new RenderStyleTable(), { kind: "xlsx" })
}

function model(workbook: XlsxWorkbook, index: number): XlsxSheetModel {
	const entry = workbook.sheets[index]

	if (entry?.model === null || entry?.model === undefined) throw new Error(`No sheet ${index}`)

	return entry.model
}

// The formula text a cell holds (shared children expanded), null for none.
function formulaAt(document: XlsxDocument, sheet: number, row: number, col: number): string | null {
	const sheetModel = model(document.workbook, sheet)
	const store = sheetModel.store as SheetStore
	const slot = store.locate(row, col)

	if (slot < 0) return null

	const id = store.formula(slot)

	return id < 0 ? null : document.formulaText(sheetModel, id, row, col)
}

function rowHidden(document: XlsxDocument, sheet: number, row: number): boolean {
	const sheetModel = model(document.workbook, sheet)
	const store = sheetModel.store as SheetStore
	const block = store.blocks[store.blockOf(row)]
	const index = block === undefined || row < block.firstRow ? -1 : block.rowIndex(row)
	const flags = block !== undefined && index >= 0 ? (block.rowFlags[index] ?? 0) : (rowRunAt(sheetModel.rowRuns, row)?.flags ?? 0)

	return (flags & RowFlag.HIDDEN) !== 0
}

const NUMBER_CELLS =
	'<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="s"><v>0</v></c><c r="C1"><f>A1+A2</f><v>3</v></c><c r="D1" t="b"><v>1</v></c></row>' +
	'<row r="2"><c r="A2"><v>2</v></c><c r="C2"><f t="shared" ref="C2:C3" si="0">A2*2</f><v>4</v></c></row>' +
	'<row r="3"><c r="A3"><v>5</v></c><c r="C3"><f t="shared" si="0"/><v>10</v></c><c r="D3"><f>[1]Other!A1</f><v>7</v></c></row>'

const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const CHART_SHEET =
	'<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="rId1"/></chartsheet>'

// A chart sheet's drawing (one chart, absolutely placed) and its bar chart of Data!A1:A2, from the sheet's rels part.
function CHART_PARTS(sheetRels: string): Record<string, string> {
	return {
		[`xl/${sheetRels}`]: `${RELS}<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
		"xl/drawings/_rels/drawing1.xml.rels": `${RELS}<Relationship Id="rId1" Type="${REL}/chart" Target="../charts/chart1.xml"/></Relationships>`,
		"xl/drawings/drawing1.xml":
			'<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
			'<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="5400000" cy="3600000"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
			'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>',
		"xl/charts/chart1.xml":
			'<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p><a:p><a:r><a:t>2026</a:t></a:r></a:p></c:rich></c:tx></c:title>' +
			'<c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>Data!$A$1:$A$2</c:f></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>' +
			'<c:catAx><c:axId val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>'
	}
}

describe("sheet conversion: what converts to what", () => {
	it("converts each family to the other one only", () => {
		expect(canConvertSheet("xlsx", "ods")).toBe(true)
		expect(canConvertSheet("ods", "xlsx")).toBe(true)
		expect(canConvertSheet("xlsx", "xlsx")).toBe(false)
		expect(canConvertSheet("ods", "ods")).toBe(false)
	})

	it("names the source family by extension", () => {
		expect(sheetSourceFormat("a.XLSX")).toBe("xlsx")
		expect(sheetSourceFormat("a.xlsm")).toBe("xlsx")
		expect(sheetSourceFormat("a.xltx")).toBe("xlsx")
		expect(sheetSourceFormat("a.xltm")).toBe("xlsx")
		expect(sheetSourceFormat("a.ods")).toBe("ods")
		expect(sheetSourceFormat("a.ots")).toBe("ods")
		expect(sheetSourceFormat("a.xls")).toBeUndefined()
		expect(sheetSourceFormat("a.csv")).toBeUndefined()
	})

	it("refuses bytes that are not the named family", async () => {
		const result = await convertSheet(new Uint8Array([1, 2, 3]), "xlsx", "ods")

		expect(result.ok).toBe(false)
		expect(result.ok ? null : result.reason).toBe("notSource")
	})

	it("refuses a conversion to its own family", async () => {
		const result = await convertSheet(buildWorkbook({ sheets: [{ body: "<sheetData/>" }] }), "xlsx", "xlsx")

		expect(result.ok ? null : result.reason).toBe("unsupported")
	})
})

describe("xlsx to ods", () => {
	it("keeps sheets, values and formulas, shared formulas each written out", async () => {
		const source = buildWorkbook({
			sheets: [
				{ name: "Data", body: `<sheetData>${NUMBER_CELLS}</sheetData>` },
				{ name: "Two words", body: "<sheetData/>" }
			],
			sharedStrings: ["text"]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)

		expect(back.workbook.sheets.map(entry => entry.name)).toEqual(["Data", "Two words"])
		expect(shownRows(back, 0)).toEqual([
			["1", "text", "3", "TRUE"],
			["2", "", "4"],
			["5", "", "10", "7"]
		])
		expect(formulaAt(back, 0, 0, 2)).toBe("A1+A2")
		expect(formulaAt(back, 0, 1, 2)).toBe("A2*2")
		expect(formulaAt(back, 0, 2, 2)).toBe("A3*2")
	})

	it("writes a formula OpenFormula cannot say as its cached value and reports it", async () => {
		const source = buildWorkbook({
			sheets: [{ name: "Data", body: `<sheetData>${NUMBER_CELLS}</sheetData>` }],
			sharedStrings: ["text"]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)

		expect(formulaAt(back, 0, 2, 3)).toBeNull()
		expect(shownRows(back, 0)[2]?.[3]).toBe("7")
		expect(result.lossy).toContainEqual({
			kind: "formula",
			count: 1,
			sheets: ["Data"],
			formulas: [{ sheet: "Data", cell: "D3", formula: "[1]Other!A1" }]
		})
	})

	it("carries conditional formats over as LibreOffice's", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData>' +
						'<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>0</formula></cfRule><cfRule type="expression" dxfId="0" priority="2"><formula>B1&gt;A1</formula></cfRule></conditionalFormatting>' +
						'<conditionalFormatting sqref="B1:B3"><cfRule type="colorScale" priority="3"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule></conditionalFormatting>' +
						'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup orientation="landscape"/>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)
		const formats = model(back.workbook, 0)
			.sections.filter(section => section.name === "conditionalFormatting")
			.map(section => new TextDecoder().decode(section.bytes ?? new Uint8Array(0)))
			.join("")

		expect(formats).toContain('sqref="A1:A3"')
		expect(formats).toMatch(/type="cellIs"[^>]*operator="greaterThan"><formula>0<\/formula>/)
		expect(formats).toMatch(/type="expression"[^>]*><formula>B1&gt;A1<\/formula>/)
		expect(back.workbook.styles.dxfs.some(dxf => dxf.font?.bold === true)).toBe(true)
		expect(formats).toMatch(
			/<colorScale><cfvo type="min"\/><cfvo type="max"\/><color rgb="FFFF0000"\/><color rgb="FF00FF00"\/><\/colorScale>/
		)
		expect(result.lossy).toEqual([])
	})

	it("carries an A Date Occurring rule over as LibreOffice's date-is and back with its period and look", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1"><v>45000</v></c></row></sheetData>' +
						'<conditionalFormatting sqref="A1:A3"><cfRule type="timePeriod" dxfId="0" priority="1" timePeriod="last7Days"><formula>AND(TODAY()-FLOOR(A1,1)&lt;=6,FLOOR(A1,1)&lt;=TODAY())</formula></cfRule><cfRule type="timePeriod" dxfId="0" priority="2" timePeriod="someday"/></conditionalFormatting>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).toMatch(/<calcext:date-is calcext:date="last-7-days" calcext:style="ConditionalStyle_1"\/>/)

		const back = await readOds(result.bytes)
		const formats = model(back.workbook, 0)
			.sections.filter(section => section.name === "conditionalFormatting")
			.map(section => new TextDecoder().decode(section.bytes ?? new Uint8Array(0)))
			.join("")
		const dxf = /type="timePeriod"[^>]*dxfId="(\d+)"[^>]*timePeriod="last7Days"/.exec(formats)

		expect(dxf).not.toBeNull()
		expect(back.workbook.styles.dxfs[Number(dxf?.[1])]?.font?.bold).toBe(true)
		expect(result.lossy).toContainEqual({ kind: "conditionalFormat", count: 1, sheets: ["S"] })
	})

	it("carries the page over as a master page: paper, margins, scale, headers with their fields, breaks and print titles", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "Page",
					body:
						'<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="12"><c r="A12"><v>2</v></c></row></sheetData>' +
						'<printOptions gridLines="1" horizontalCentered="1"/>' +
						'<pageMargins left="0.5" right="0.5" top="1" bottom="1" header="0.25" footer="0.25"/>' +
						'<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0" pageOrder="overThenDown" horizontalDpi="300" verticalDpi="300"/>' +
						'<headerFooter alignWithMargins="0"><oddHeader>&amp;L&amp;"Arial,Bold"Report &amp;A&amp;RPage &amp;P of &amp;N</oddHeader><oddFooter>&amp;C&amp;F</oddFooter></headerFooter>' +
						'<rowBreaks count="1" manualBreakCount="1"><brk id="10" max="16383" man="1"/></rowBreaks>'
				},
				{ name: "Plain", body: '<sheetData><row r="1"><c r="A1"><v>3</v></c></row></sheetData>' }
			],
			workbookTail: '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">Page!$1:$2</definedName></definedNames>'
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const files = unzipSync(result.bytes)
		const styles = strFromU8(files["styles.xml"] ?? new Uint8Array(0))
		const content = strFromU8(files["content.xml"] ?? new Uint8Array(0))
		const layout = /<style:page-layout style:name="([^"]+)"><style:page-layout-properties([^>]*)\/>/.exec(styles)
		const props = layout?.[2] ?? ""

		expect(result.lossy).toEqual([])
		expect(props).toContain('fo:page-width="841.89pt"')
		expect(props).toContain('fo:page-height="595.276pt"')
		expect(props).toContain('style:print-orientation="landscape"')
		expect(props).toContain('fo:margin-top="0.25in"')
		expect(props).toContain('fo:margin-left="0.5in"')
		expect(props).toContain('style:print="objects charts drawings zero-values grid"')
		expect(props).toContain('style:print-page-order="ltr"')
		expect(props).toContain('style:scale-to-X="1"')
		expect(props).not.toContain("scale-to-Y")
		expect(props).toContain('style:table-centering="horizontal"')
		// Not aligned with the margins: across the paper.
		expect(styles).toMatch(
			/<style:header-style><style:header-footer-properties fo:min-height="0.75in" fo:margin-left="-0.5in" fo:margin-right="-0.5in"/
		)
		expect(styles).toMatch(
			/<style:header><style:region-left><text:p><text:span text:style-name="HF1">Report<text:s\/><text:sheet-name\/><\/text:span><\/text:p><\/style:region-left><style:region-center><text:p><\/text:p><\/style:region-center><style:region-right><text:p>Page<text:s\/><text:page-number>1<\/text:page-number><text:s\/>of<text:s\/><text:page-count>1<\/text:page-count><\/text:p><\/style:region-right><\/style:header>/
		)
		expect(styles).toMatch(
			/<style:style style:name="HF\d+" style:family="text"><style:text-properties fo:font-family="Arial" fo:font-weight="bold"\/>/
		)
		expect(styles).toContain('<text:file-name text:display="name-and-extension"/>')
		// Each sheet's own master page; the plain sheet's without header or footer, as Excel prints it.
		expect(styles.match(/<style:master-page /g)?.length).toBe(2)
		expect(styles).toMatch(/<style:master-page style:name="Sheet2" style:page-layout-name="pm2"><\/style:master-page>/)
		expect(content).toMatch(/style:master-page-name="Sheet1"/)
		// The break: row 11 starts a page, alone.
		expect(content).toMatch(
			/<style:style style:name="(ro[^"]+)" style:family="table-row"><style:table-row-properties[^>]*fo:break-before="page"/
		)
		expect(content).toContain("<table:table-header-rows>")

		const back = await readOds(result.bytes)

		expect(back.workbook.definedNames.find(name => name.name === "_xlnm.Print_Titles")?.formula).toBe("Page!$1:$2")
	})

	it("reports what a page cannot hold: draft quality, errors printed otherwise, a header picture", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "D",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
						'<pageSetup paperSize="9" draft="1" errors="blank"/><headerFooter><oddHeader>&amp;C&amp;G</oddHeader></headerFooter>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))

		expect(result.lossy).toEqual([{ kind: "pageSetup", count: 1, sheets: ["D"] }])
	})

	it("reports print titles across outline levels, which table:table-header-rows cannot hold, and writes no name for them", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "T",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2" outlineLevel="1"><c r="A2"><v>2</v></c></row></sheetData>'
				}
			],
			workbookTail: '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">T!$1:$2</definedName></definedNames>'
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)

		expect(result.lossy).toEqual([{ kind: "pageSetup", count: 1, sheets: ["T"] }])
		expect(back.workbook.definedNames.some(name => name.name === "_xlnm.Print_Titles")).toBe(false)
	})

	it("keeps a sheet's protection without its password, and its print area", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "P",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
						'<sheetProtection algorithmName="SHA-512" hashValue="aGFzaA==" saltValue="c2FsdA==" spinCount="100000" sheet="1" objects="1" scenarios="1"/>'
				}
			],
			workbookTail: '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">P!$A$1:$B$2</definedName></definedNames>'
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)
		const protection = model(back.workbook, 0).protection

		expect(protection).not.toBeNull()
		expect(protection?.hash).toEqual({})
		expect(back.workbook.definedNames.find(name => name.name === "_xlnm.Print_Area")?.formula).toBe("'P'!$A$1:$B$2")
		expect(result.lossy).toEqual([{ kind: "protectionPassword", count: 1, sheets: ["P"] }])
	})

	it("reports nothing for a plain workbook", async () => {
		const source = buildWorkbook({ sheets: [{ body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] })
		const result = converted(await convertSheet(source, "xlsx", "ods"))

		expect(result.lossy).toEqual([])
	})

	it("writes the language it is given as the default cell style's, so numbers read in that language", async () => {
		const source = buildWorkbook({ sheets: [{ body: '<sheetData><row r="1"><c r="A1"><v>1.5</v></c></row></sheetData>' }] })
		const styles = async (language?: string): Promise<string> => {
			const result = converted(await convertSheet(source, "xlsx", "ods", language === undefined ? {} : { language }))

			return strFromU8(unzipSync(result.bytes)["styles.xml"] ?? new Uint8Array(0))
		}

		expect(await styles("de-DE")).toMatch(/<style:default-style style:family="table-cell">.*fo:language="de" fo:country="DE"/)
		expect(await styles("fr")).toMatch(/fo:language="fr" fo:country="FR"/)
		expect(await styles()).toMatch(/fo:language="en" fo:country="US"/)
	})

	it("keeps the 1904 date system and row outline levels", async () => {
		const source = buildWorkbook({
			workbookHead: '<workbookPr date1904="1"/>',
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1" s="0"><v>0</v></c></row><row r="2" outlineLevel="1"><c r="A2"><v>2</v></c></row>' +
						'<row r="3" outlineLevel="2"><c r="A3"><v>3</v></c></row></sheetData>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)
		const store = model(back.workbook, 0).store as SheetStore
		const level = (row: number): number => {
			const block = store.blocks[store.blockOf(row)]
			const index = block === undefined ? -1 : block.rowIndex(row)

			return block === undefined || index < 0 ? 0 : ((block.rowFlags[index] ?? 0) & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT
		}

		expect(back.workbook.date1904).toBe(true)
		expect([level(0), level(1), level(2)]).toEqual([0, 1, 2])
	})

	it("leaves out characters XML cannot hold and carriage returns, and reports them; the line still ends at a carriage return before a line feed", async () => {
		const source = buildWorkbook({
			sheets: [
				{ name: "S", body: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>' }
			],
			sharedStrings: ["a_x000D__x000A_b", "c_x0001_d"]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))

		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["a\nb", "cd"]])
		expect(result.lossy).toEqual([{ kind: "other", count: 2, sheets: ["S"] }])
	})

	it("writes a chart sheet as a sheet holding its chart, as a chart object reading the cells", async () => {
		const source = buildWorkbook({
			workbookHead: '<bookViews><workbookView activeTab="1"/></bookViews>',
			sheets: [
				{
					name: "Data",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>'
				},
				{ name: "Chart", type: "chartsheet", xml: CHART_SHEET }
			],
			extra: CHART_PARTS("worksheets/_rels/sheet2.xml.rels")
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const files = unzipSync(result.bytes)
		const content = strFromU8(files["content.xml"] ?? new Uint8Array(0))
		const object = strFromU8(files["Object 1/content.xml"] ?? new Uint8Array(0))
		const manifest = strFromU8(files["META-INF/manifest.xml"] ?? new Uint8Array(0))
		const back = await readOds(result.bytes)

		expect(back.workbook.sheets.map(entry => entry.name)).toEqual(["Data", "Chart"])
		expect(back.workbook.sheets[back.workbook.activeTab]?.name).toBe("Chart")
		expect(content).toMatch(
			/<table:table table:name="Chart"[\s\S]*<draw:frame [^>]*svg:width="15cm" svg:height="10cm" svg:x="0cm" svg:y="0cm"><draw:object draw:notify-on-update-of-ranges="Data\.A1:Data\.A2" xlink:href="\.\/Object 1"/
		)
		expect(object).toContain('chart:class="chart:bar"')
		expect(object).toContain(
			'<chart:series chart:style-name="ch1" chart:values-cell-range-address="Data.A1:Data.A2" chart:class="chart:bar" chart:attached-axis="primary-y">'
		)
		// One paragraph, as chart:title holds.
		expect(object).toMatch(/<chart:title><text:p>Sales<text:line-break\/>2026<\/text:p><\/chart:title>/)
		expect(manifest).toContain(
			'manifest:full-path="Object 1/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"'
		)
		expect(result.lossy.filter(feature => feature.kind === "chart")).toEqual([])
	})

	it("writes a workbook of a chart sheet alone as that sheet", async () => {
		const source = buildWorkbook({
			sheets: [{ name: "Chart", type: "chartsheet", xml: CHART_SHEET }],
			extra: CHART_PARTS("worksheets/_rels/sheet1.xml.rels")
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)

		expect(back.workbook.sheets.map(entry => entry.name)).toEqual(["Chart"])
		expect(strFromU8(unzipSync(result.bytes)["Object 1/content.xml"] ?? new Uint8Array(0))).toContain("chart:bar")
	})

	it("keeps a series' own name as LibreOffice's label string and an axis' own number format as a data style", async () => {
		const parts = CHART_PARTS("worksheets/_rels/sheet2.xml.rels")
		const chart = (parts["xl/charts/chart1.xml"] ?? "")
			.replace('<c:idx val="0"/><c:order val="0"/>', '<c:idx val="0"/><c:order val="0"/><c:tx><c:v>Say "hi"</c:v></c:tx>')
			.replace('<c:axPos val="l"/>', '<c:axPos val="l"/><c:numFmt formatCode="0%" sourceLinked="0"/>')
		const source = buildWorkbook({
			sheets: [
				{
					name: "Data",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>'
				},
				{ name: "Chart", type: "chartsheet", xml: CHART_SHEET }
			],
			extra: { ...parts, "xl/charts/chart1.xml": chart }
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const object = strFromU8(unzipSync(result.bytes)["Object 1/content.xml"] ?? new Uint8Array(0))

		expect(object).toContain('loext:label-string="&quot;Say &quot;&quot;hi&quot;&quot;&quot;"')
		expect(object).toMatch(/<number:percentage-style style:name="N1">/)
		expect(object).toMatch(
			/style:data-style-name="N1"><style:chart-properties chart:display-label="true" chart:link-data-style-to-source="false"/
		)
		expect(result.lossy.filter(feature => feature.kind === "chart")).toEqual([])
	})

	it("writes shapes, text boxes, connectors and groups as ODF shapes in their cells, with their text", async () => {
		const sp = (id: number, name: string, off: string, ext: string, inner: string, box = ""): string =>
			`<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${String(id)}" name="${name}"/><xdr:cNvSpPr${box}/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off ${off}/><a:ext ${ext}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${inner}</xdr:spPr>` +
			'<xdr:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-GB" sz="1400" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Hello  there</a:t></a:r></a:p></xdr:txBody></xdr:sp>'
		const drawing =
			'<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
			`<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="720000" cy="360000"/>${sp(2, "Box", 'x="0" y="0"', 'cx="720000" cy="360000"', '<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>', ' txBox="1"')}<xdr:clientData/></xdr:oneCellAnchor>` +
			'<xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="360000" cy="0"/><xdr:cxnSp macro=""><xdr:nvCxnSpPr><xdr:cNvPr id="3" name="Line"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="360000" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></xdr:spPr></xdr:cxnSp><xdr:clientData/></xdr:oneCellAnchor>' +
			'<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="720000" cy="360000"/><xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="4" name="Group"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="720000" cy="360000"/><a:chOff x="0" y="0"/><a:chExt cx="1440000" cy="720000"/></a:xfrm></xdr:grpSpPr>' +
			`${sp(5, "A", 'x="0" y="0"', 'cx="720000" cy="720000"', "")}${sp(6, "B", 'x="720000" y="0"', 'cx="720000" cy="720000"', "")}</xdr:grpSp><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`
		const source = buildWorkbook({
			sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><drawing r:id="rId1"/>' }],
			extra: {
				"xl/worksheets/_rels/sheet1.xml.rels": `${RELS}<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
				"xl/drawings/drawing1.xml": drawing
			}
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const files = unzipSync(result.bytes)
		const content = strFromU8(files["content.xml"] ?? new Uint8Array(0))
		const styles = strFromU8(files["styles.xml"] ?? new Uint8Array(0))

		expect(content).toMatch(
			/<table:table-cell[^>]*><draw:custom-shape draw:z-index="0" draw:name="Box" draw:style-name="(Shape\d+)" svg:width="2cm" svg:height="1cm" svg:x="0cm" svg:y="0cm"><text:p text:style-name="ShapeP\d+"><text:span text:style-name="ShapeT\d+">Hello <text:s\/>there<\/text:span><\/text:p><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"\/><\/draw:custom-shape>/
		)
		expect(content).toMatch(
			/<draw:line draw:z-index="1" draw:name="Line" draw:style-name="Shape\d+" svg:x1="0cm" svg:y1="0cm" svg:x2="1cm" svg:y2="0cm"><text:p\/><\/draw:line>/
		)
		expect(content).toMatch(
			/<draw:g draw:z-index="2" draw:name="Group"><draw:custom-shape draw:name="A"[^>]*svg:width="1cm" svg:height="1cm" svg:x="0cm"[\s\S]*<draw:custom-shape draw:name="B"[^>]*svg:x="1cm"/
		)
		expect(styles).toMatch(
			/style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#00ff00"[^>]*draw:textarea-vertical-align="middle"/
		)
		expect(styles).toMatch(
			/style:family="graphic"><style:graphic-properties draw:stroke="solid" svg:stroke-color="#0000ff" svg:stroke-width="0.035cm"/
		)
		expect(styles).toMatch(
			/style:family="text"><style:text-properties[^>]*fo:font-size="14pt" fo:font-weight="bold"[^>]*fo:color="#ff0000"/
		)
		expect(styles).toContain('<style:paragraph-properties fo:text-align="center"/>')
		expect(result.lossy).toEqual([])
	})

	it("writes a trapezoid as ODF's turned upside down, its inset measured on the width, and keeps a preset's adjustments", async () => {
		const trapezoid = (id: number, name: string, flip: string, prst = "trapezoid", avLst = ""): string =>
			`<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${String(id)}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="720000" cy="360000"/>` +
			`<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${String(id)}" name="${name}"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm${flip}><a:off x="0" y="0"/><a:ext cx="720000" cy="360000"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst>${avLst}</a:avLst></a:prstGeom></xdr:spPr></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>`
		const source = buildWorkbook({
			sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><drawing r:id="rId1"/>' }],
			extra: {
				"xl/worksheets/_rels/sheet1.xml.rels": `${RELS}<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
				"xl/drawings/drawing1.xml":
					'<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
					`${trapezoid(2, "Plain", "")}${trapezoid(3, "Flipped", ' flipV="1"')}${trapezoid(4, "Rounded", "", "roundRect", '<a:gd name="adj" fmla="val 40000"/>')}</xdr:wsDr>`
			}
		})
		const content = strFromU8(unzipSync(converted(await convertSheet(source, "xlsx", "ods")).bytes)["content.xml"] ?? new Uint8Array(0))
		const geometry = (name: string): string =>
			new RegExp(`draw:name="${name}"[\\s\\S]*?(<draw:enhanced-geometry [^>]*>)`, "u").exec(content)?.[1] ?? ""

		// 25000 of the shorter side (half the width) is 2700 of 21600 across.
		expect(geometry("Plain")).toContain('draw:type="trapezoid" draw:modifiers="2700" draw:mirror-vertical="true"')
		expect(geometry("Flipped")).toContain('draw:modifiers="2700"')
		expect(geometry("Flipped")).not.toContain("draw:mirror-vertical")
		// 40000 of the 1 cm short side: the outline's first line starts 0.4 cm (400 hundredths of a millimetre) down.
		expect(geometry("Rounded")).toContain('draw:type="ooxml-roundRect" draw:modifiers="40000"')
		expect(geometry("Rounded")).toContain('draw:enhanced-path="M 0 400 C')
	})

	it("writes a picture as a frame in its cell, its image in the package", async () => {
		const png = Uint8Array.from(
			atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
			c => c.charCodeAt(0)
		)
		const source = buildWorkbook({
			sheets: [{ name: "P", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><drawing r:id="rId1"/>' }],
			extra: {
				"[Content_Types].xml":
					'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
					'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
				"xl/worksheets/_rels/sheet1.xml.rels": `${RELS}<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
				"xl/drawings/_rels/drawing1.xml.rels": `${RELS}<Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`,
				"xl/drawings/drawing1.xml":
					'<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
					'<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>360000</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="720000" cy="360000"/>' +
					'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo" descr="The logo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>',
				"xl/media/image1.png": png
			}
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const files = unzipSync(result.bytes)
		const content = strFromU8(files["content.xml"] ?? new Uint8Array(0))

		expect(content).toMatch(
			/<table:table-row[^>]*>(?:<table:table-cell[^>]*\/>)?<table:table-cell[^>]*><draw:frame draw:z-index="0" draw:name="Logo" svg:width="2cm" svg:height="1cm" svg:x="1cm" svg:y="0cm"><draw:image xlink:href="Pictures\/1_image1\.png" [^>]*draw:mime-type="image\/png"\/><svg:desc>The logo<\/svg:desc><\/draw:frame><\/table:table-cell>/
		)
		expect(files["Pictures/1_image1.png"]).toEqual(png)
		expect(strFromU8(files["META-INF/manifest.xml"] ?? new Uint8Array(0))).toContain(
			'manifest:full-path="Pictures/1_image1.png" manifest:media-type="image/png"'
		)
		expect(result.lossy).toEqual([])
	})

	it("writes a link on a formula cell nowhere and reports it", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1" t="str"><f>"x"</f><v>x</v></c><c r="B1" t="s"><v>0</v></c></row></sheetData>' +
						'<hyperlinks><hyperlink ref="A1" location="S!B1"/><hyperlink ref="B1" location="S!A1"/></hyperlinks>'
				}
			],
			sharedStrings: ["y"]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))

		expect(result.lossy).toEqual([{ kind: "other", count: 1, sheets: ["S"] }])
	})

	it("keeps the first of two validations on one cell and reports the other", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><dataValidations count="2">' +
						'<dataValidation type="whole" allowBlank="1" sqref="A1:A3 A2"><formula1>1</formula1><formula2>9</formula2></dataValidation>' +
						'<dataValidation type="list" allowBlank="1" sqref="A2"><formula1>"a,b"</formula1></dataValidation></dataValidations>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))

		expect(result.lossy).toEqual([{ kind: "dataValidation", count: 1, sheets: ["S"] }])
	})

	it("writes an error as that error's formula, which LibreOffice shows, and an error OpenFormula has no name for as its text", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1" t="e"><v>#DIV/0!</v></c><c r="B1" t="e"><v>#N/A</v></c><c r="C1" t="e"><f>FOO(1)</f><v>#NAME?</v></c>' +
						'<c r="D1" t="e"><f>[1]X!A1</f><v>#N/A</v></c><c r="E1" t="e"><v>#NULL!</v></c><c r="F1" t="e"><v>#SPILL!</v></c></row></sheetData>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))
		const cells = content.match(/<table:table-cell[^>]*>(?:<text:p>[^<]*<\/text:p>)?<\/table:table-cell>/g) ?? []

		// An error with no formula of its own (a constant, a formula written as its cached result) is that error's formula.
		expect(cells[0]).toContain('table:formula="of:=#DIV/0!"')
		expect(cells[1]).toContain('table:formula="of:=#N/A"')
		expect(cells[3]).toContain('table:formula="of:=#N/A"')
		for (const cell of cells.slice(0, 4)) expect(cell).toContain('calcext:value-type="error"')
		expect(cells[4]).toMatch(/office:value-type="string" office:string-value="#NULL!"/)
		expect(cells[5]).toMatch(/office:value-type="string" office:string-value="#SPILL!"/)
		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["#DIV/0!", "#N/A", "#NAME?", "#N/A", "#NULL!", "#SPILL!"]])
		expect(result.lossy.map(feature => [feature.kind, feature.count])).toEqual([
			["formula", 1],
			["other", 2]
		])
	})

	it("reads a text-typed error result without a formula as LibreOffice shows it, its paragraph's text", async () => {
		const back = await readOds(
			odsBytes({
				body: table(
					"S",
					'<table:table-row><table:table-cell office:value-type="string" office:string-value="" calcext:value-type="error"><text:p>#DIV/0!</text:p></table:table-cell></table:table-row>'
				)
			})
		)

		expect(shownRows(back, 0)).toEqual([["#DIV/0!"]])
	})

	it("reads an error result without a formula as LibreOffice shows it, its value", async () => {
		const back = await readOds(
			odsBytes({
				body: table(
					"S",
					'<table:table-row><table:table-cell office:value-type="float" office:value="0" calcext:value-type="error"><text:p>#N/A</text:p></table:table-cell></table:table-row>'
				)
			})
		)

		expect(shownRows(back, 0)).toEqual([["0"]])
	})

	it("shows a zero through the zero section of a four-section format", async () => {
		const styles =
			'<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;\\-#,##0;&quot;-&quot;;@"/></numFmts>' +
			'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
			'<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
		const source = buildWorkbook({
			styles,
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>1234</v></c><c r="C1" s="1"><v>-5</v></c></row></sheetData>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))
		// A reader takes the first map whose condition holds (ODF 1.3 Part 3 §16.3): none before the zero one holds for 0.
		const conditions = [...content.matchAll(/style:condition="([^"]*)"/g)].map(match => match[1])

		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["-", "1,234", "-5"]])
		expect(conditions.slice(0, conditions.indexOf("value()=0"))).not.toContain("value()>=0")
		expect(conditions).toContain("value()=0")
	})

	it("writes a link on formatted text inside each span, where LibreOffice reads its text", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData><hyperlinks><hyperlink ref="A1" r:id="rId9"/></hyperlinks>'
				}
			],
			sharedStrings: [
				'<r><rPr><b/><sz val="11"/><name val="Calibri"/></rPr><t>Bold</t></r><r><t xml:space="preserve"> plain</t></r>'
			],
			extra: {
				"xl/worksheets/_rels/sheet1.xml.rels":
					'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>'
			}
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).toMatch(
			/<text:span text:style-name="[^"]+"><text:a xlink:href="https:\/\/example.com\/" xlink:type="simple">Bold<\/text:a><\/text:span>/
		)
		expect(content).not.toMatch(/<text:a [^>]*><text:span/)
		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["Bold plain"]])
	})

	it("gives text starting with # its string value, which LibreOffice 7.5 otherwise reads as an error name and aborts on", async () => {
		const source = buildWorkbook({
			sheets: [
				{ name: "S", body: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>' }
			],
			sharedStrings: ["#", "#tag"]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).toContain('office:value-type="string" office:string-value="#"><text:p>#</text:p>')
		expect(content).toContain('office:string-value="#tag"')
		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["#", "#tag"]])
	})

	it("writes tabs and kept spaces outside spans and links, where LibreOffice 7.5 shows them", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData><hyperlinks><hyperlink ref="B1" location="S!A1"/></hyperlinks>'
				}
			],
			sharedStrings: ['<r><rPr><b/><sz val="11"/><name val="Calibri"/></rPr><t xml:space="preserve">•\tBold  </t></r>', "Link   "]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).not.toMatch(/<text:span[^>]*>[^<]*<text:(?:tab|s)\b/)
		expect(content).not.toMatch(/<text:a [^>]*>[^<]*<text:s\b/)
		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["•\tBold  ", "Link   "]])
	})

	it("holds a zero section's blank padding as spaces", async () => {
		const styles =
			'<numFmts count="1"><numFmt numFmtId="164" formatCode="_-* #,##0_-;\\-* #,##0_-;_-* &quot;-&quot;??_-;_-@_-"/></numFmts>' +
			'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
			'<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
		const source = buildWorkbook({
			styles,
			sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1" s="1"><v>0</v></c></row></sheetData>' }]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).toMatch(/<number:text>- {2,}<\/number:text>/)
		expect(result.lossy).toEqual([])
	})

	it("carries Excel's Special formats and [ColorN] colours of the workbook's palette over", async () => {
		const formats = ["00000-0000", "000-00-0000", "###-####", "[&lt;=9999999]###-####;(###) ###-####", "[Magenta]0;[Color10]-0"]
		// [Color10] (index 17) recoloured blue: it reads back as [Blue].
		const colors = Array.from({ length: 64 }, (_, k) => `<rgbColor rgb="${k === 17 ? "FF0000FF" : "FF000000"}"/>`).join("")
		const styles =
			`<numFmts count="${formats.length}">${formats.map((format, k) => `<numFmt numFmtId="${164 + k}" formatCode="${format}"/>`).join("")}</numFmts>` +
			'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
			'<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			`<cellXfs count="${formats.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${formats.map((_, k) => `<xf numFmtId="${164 + k}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join("")}</cellXfs>` +
			`<colors><indexedColors>${colors}</indexedColors></colors>`
		const values = [123456789, 123456789, 5551234, 2065551234, -3]
		const source = buildWorkbook({
			styles,
			sheets: [
				{
					name: "S",
					body: `<sheetData><row r="1">${values.map((value, k) => `<c r="${cellRef(0, k)}" s="${k + 1}"><v>${value}</v></c>`).join("")}</row></sheetData>`
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(result.lossy).toEqual([])
		expect(content).toContain('<number:embedded-text number:position="4">-</number:embedded-text>')
		expect(content).toContain('<style:text-properties fo:color="#0000ff"/>')
		expect(shownRows(await readOds(result.bytes), 0)).toEqual([["12345-6789", "123-45-6789", "555-1234", "(206) 555-1234", "-3"]])
	})

	it("writes a link on an empty cell nowhere and reports it, so no empty field shows", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1" s="0"/></row></sheetData><hyperlinks><hyperlink ref="A1" location="S!B1"/></hyperlinks>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).not.toContain("<text:a")
		expect(result.lossy).toEqual([{ kind: "other", count: 1, sheets: ["S"] }])
	})

	it("writes a structured reference as the range it names and a sheet's #REF! as #REF!, as LibreOffice reads them", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "Data",
					body:
						'<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>10</v></c></row>' +
						'<row r="3"><c r="A3"><v>2</v></c><c r="B3"><v>20</v></c></row><row r="4"><c r="D4"><f>SUM(Sales[Amount])</f><v>30</v></c><c r="E4"><f>Gone!#REF!+1</f><v>0</v></c></row></sheetData>' +
						'<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'
				},
				{
					name: "Other",
					body: '<sheetData><row r="1"><c r="A1"><f>COUNT(Sales[[#All],[Item]:[Amount]])</f><v>4</v></c></row></sheetData>'
				}
			],
			sharedStrings: ["Item", "Amount"],
			extra: {
				"xl/worksheets/_rels/sheet1.xml.rels":
					'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
				"xl/tables/table1.xml":
					'<?xml version="1.0" encoding="UTF-8"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Sales" displayName="Sales" ref="A1:B3"><tableColumns count="2"><tableColumn id="1" name="Item"/><tableColumn id="2" name="Amount"/></tableColumns></table>'
			}
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)

		expect(formulaAt(back, 0, 3, 3)).toBe("SUM($B$2:$B$3)")
		expect(formulaAt(back, 0, 3, 4)).toBe("#REF!+1")
		expect(formulaAt(back, 1, 0, 0)).toBe("COUNT(Data!$A$1:$B$3)")
		expect(result.lossy.find(feature => feature.kind === "formula")).toBeUndefined()
	})

	it("writes tables as database ranges, the first filtered one the sheet's filter, and reports table styles and other tables' buttons", async () => {
		const rels =
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>' +
			'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table2.xml"/></Relationships>'
		const part = (name: string, ref: string, inner: string, attributes = ""): string =>
			`<?xml version="1.0" encoding="UTF-8"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="${name}" displayName="${name}" ref="${ref}"${attributes}>${inner}<tableColumns count="2"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/></tableColumns></table>`
		const source = buildWorkbook({
			sheets: [
				{
					name: "T",
					body:
						'<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>0</v></c><c r="E1" t="s"><v>1</v></c></row>' +
						'<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="D2"><v>3</v></c><c r="E2"><v>4</v></c></row><row r="3"><c r="B3"><v>2</v></c></row></sheetData>' +
						'<tableParts count="2"><tablePart r:id="rId1"/><tablePart r:id="rId2"/></tableParts>'
				}
			],
			sharedStrings: ["A", "B"],
			extra: {
				"xl/worksheets/_rels/sheet1.xml.rels": rels,
				"xl/tables/table1.xml": part(
					"First",
					"A1:B3",
					'<autoFilter ref="A1:B2"><filterColumn colId="0"><filters><filter val="1"/></filters></filterColumn></autoFilter>',
					' totalsRowCount="1"'
				),
				"xl/tables/table2.xml": part("Second", "D1:E2", '<autoFilter ref="D1:E2"/>') + ""
			}
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).toMatch(
			/<table:database-range table:name="__Anonymous_Sheet_DB__0" table:target-range-address="T\.A1:T\.B2" table:display-filter-buttons="true"><table:filter><table:filter-condition table:field-number="0"[^>]*table:value="1"/
		)
		expect(content).toContain(
			'<table:database-range table:name="Second" table:target-range-address="T.D1:T.E2" table:contains-header="true"/>'
		)
		expect(result.lossy).toEqual([
			{ kind: "filter", count: 1, sheets: ["T"] },
			{ kind: "table", count: 1, sheets: ["T"] }
		])
	})

	it("keeps a table's totals row as LibreOffice's footer", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "T",
					body: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>1</v></c></row><row r="3"><c r="A3"><v>1</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts>'
				}
			],
			sharedStrings: ["A"],
			extra: {
				"xl/worksheets/_rels/sheet1.xml.rels":
					'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
				"xl/tables/table1.xml":
					'<?xml version="1.0" encoding="UTF-8"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Sums" displayName="Sums" ref="A1:A3" totalsRowCount="1"><tableColumns count="1"><tableColumn id="1" name="A"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>'
			}
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content).toContain(
			'<table:database-range table:name="Sums" table:target-range-address="T.A1:T.A3" table:contains-header="true" calcext:contains-footer="true"/>'
		)
		expect(result.lossy).toEqual([{ kind: "table", count: 1, sheets: ["T"] }])
	})

	it("writes a sheet's #REF! as #REF! outside text only, a string that spells one kept", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1" t="str"><f>IFERROR(Other!#REF!,"Other!#REF!")&amp;\'It\'\'s\'!#REF!&amp;"\'x\'!#REF!"</f><v>a</v></c></row></sheetData>'
				},
				{ name: "Other", body: "<sheetData/>" }
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const back = await readOds(result.bytes)

		expect(formulaAt(back, 0, 0, 0)).toBe('IFERROR(#REF!,"Other!#REF!")&#REF!&"\'x\'!#REF!"')
	})

	describe("hostile drawings and validations, each in a bounded time", () => {
		const head =
			'<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
		const shape =
			'<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="2" name="B"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:sp>'
		const withDrawing = (drawing: string): Uint8Array =>
			buildWorkbook({
				sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><drawing r:id="rId1"/>' }],
				extra: {
					"xl/worksheets/_rels/sheet1.xml.rels": `${RELS}<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
					"xl/drawings/drawing1.xml": drawing
				}
			})
		const timed = async (source: Uint8Array): Promise<{ result: SheetConversion; ms: number }> => {
			const started = cpuMs()
			const result = await convertSheet(source, "xlsx", "ods")

			return { result, ms: cpuMs() - started }
		}

		it("places 1,000 anchors across the whole grid at once each", { timeout: 120_000 }, async () => {
			const anchor =
				`<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>16383</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1048575</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${shape}<xdr:clientData/></xdr:twoCellAnchor>` +
				`<xdr:absoluteAnchor><xdr:pos x="999999999999" y="999999999999999"/><xdr:ext cx="1" cy="1"/>${shape}<xdr:clientData/></xdr:absoluteAnchor>`
			const { result, ms } = await timed(withDrawing(head + anchor.repeat(500) + "</xdr:wsDr>"))

			expect(result.ok).toBe(true)
			expect(ms).toBeLessThan(budget(3000))
		})

		it("refuses groups nested past a depth, before going down them", { timeout: 120_000 }, async () => {
			const open =
				'<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="4" name="G"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/><a:chOff x="0" y="0"/><a:chExt cx="10" cy="10"/></a:xfrm></xdr:grpSpPr>'
			const nested = (depth: number): Uint8Array =>
				withDrawing(
					head +
						`<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="720000" cy="360000"/>${open.repeat(depth)}${shape}${"</xdr:grpSp>".repeat(depth)}<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`
				)

			expect((await timed(nested(50))).result.ok).toBe(true)

			const deep = await timed(nested(20_000))

			expect(deep.result.ok ? null : deep.result.reason).toBe("tooLarge")
			expect(deep.ms).toBeLessThan(budget(3000))
		})

		const rule = (sqref: string, k: number): string =>
			`<dataValidation type="whole" operator="greaterThan" allowBlank="1" showErrorMessage="1" sqref="${sqref}"><formula1>${String(k)}</formula1></dataValidation>`
		const validations = (rules: string[]): Uint8Array =>
			buildWorkbook({
				sheets: [
					{
						name: "S",
						body: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><dataValidations count="${String(rules.length)}">${rules.join("")}</dataValidations>`
					}
				]
			})

		it("holds 3,200 whole-column validations in linear time", { timeout: 120_000 }, async () => {
			const rules = Array.from({ length: 3200 }, (_, k) => {
				const col = cellRef(0, k).replace(/\d+/, "")

				return rule(`${col}1:${col}1048576`, k)
			})
			const { result, ms } = await timed(validations(rules))

			expect(result.ok).toBe(true)
			expect(ms).toBeLessThan(budget(4000))
		})

		it("holds 6,000 whole-row validations in linear time", { timeout: 120_000 }, async () => {
			const { result, ms } = await timed(
				validations(Array.from({ length: 6000 }, (_, k) => rule(`A${String(k + 1)}:XFD${String(k + 1)}`, k)))
			)

			expect(result.ok).toBe(true)
			expect(ms).toBeLessThan(budget(4000))
		})

		it("names 16,384 new validations in linear time, and answers an abort within about 100 ms", { timeout: 120_000 }, async () => {
			const rules = Array.from({ length: 16_384 }, (_, k) => {
				const col = cellRef(0, k).replace(/\d+/, "")

				return rule(`${col}1:${col}1048576`, k)
			})
			const source = validations(rules)
			// CPU time, the least of two runs: what the conversion spent, whatever else shares the machine.
			const runs = [await timed(source), await timed(source)]

			expect(runs.every(run => run.result.ok)).toBe(true)
			expect(Math.min(...runs.map(run => run.ms))).toBeLessThan(budget(1000))

			// Aborted part way: the CPU time spent after the abort, at most a slice or two.
			const signal = { aborted: false }
			const slicing = {
				sliceMs: 20,
				now: () => performance.now(),
				pause: () => new Promise<void>(resolve => setTimeout(resolve, 0))
			}
			let abortedAt = Number.NaN

			setTimeout(() => {
				signal.aborted = true
				abortedAt = cpuMs()
			}, 300)

			const aborted = await convertSheet(source, "xlsx", "ods", { turns: { signal, slicing } })

			expect(aborted.ok ? null : aborted.reason).toBe("aborted")
			expect(cpuMs() - abortedAt).toBeLessThan(budget(100))
		})

		it("stops a long conversion when aborted midway", { timeout: 120_000 }, async () => {
			const signal = { aborted: false }
			let pauses = 0
			const anchor = `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="1" cy="1"/>${shape}<xdr:clientData/></xdr:absoluteAnchor>`
			const result = await convertSheet(withDrawing(head + anchor.repeat(20_000) + "</xdr:wsDr>"), "xlsx", "ods", {
				turns: {
					signal,
					slicing: {
						sliceMs: 0,
						now: () => 0,
						pause: () => {
							// Aborted once the drawings are under way.
							if (++pauses === 200) signal.aborted = true

							return Promise.resolve()
						}
					}
				}
			})

			expect(result.ok ? null : result.reason).toBe("aborted")
		})
	})

	it("stops when aborted", async () => {
		const source = buildWorkbook({ sheets: [{ body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] })
		const result = await convertSheet(source, "xlsx", "ods", {
			turns: { signal: { aborted: true }, slicing: { sliceMs: 16, now: () => 0, pause: () => Promise.resolve() } }
		})

		expect(result.ok ? null : result.reason).toBe("aborted")
	})
})

describe("ods to xlsx", () => {
	const body = table(
		"Data",
		'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>text</text:p></table:table-cell><table:table-cell table:formula="of:=[.A1]+[.A2]" office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell></table:table-row>' +
			'<table:table-row><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell><table:table-cell/><table:table-cell table:formula="of:=FORMULA([.A1])" office:value-type="string" office:string-value="=1"><text:p>=1</text:p></table:table-cell></table:table-row>'
	)

	it("keeps sheets, values and formulas", async () => {
		const result = converted(await convertSheet(odsBytes({ body }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)

		expect(back.workbook.sheets.map(entry => entry.name)).toEqual(["Data"])
		expect(shownRows(back, 0)).toEqual([
			["1", "text", "3"],
			["2", "", "=1"]
		])
		expect(formulaAt(back, 0, 0, 2)).toBe("A1+A2")
	})

	it("writes a formula Excel cannot say as its cached value and reports it", async () => {
		const result = converted(await convertSheet(odsBytes({ body }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)

		expect(formulaAt(back, 0, 1, 2)).toBeNull()
		const store = model(back.workbook, 0).store as SheetStore

		expect(store.kind(store.locate(1, 2))).not.toBe(CellKind.EMPTY)
		expect(result.lossy).toContainEqual({
			kind: "formula",
			count: 1,
			sheets: ["Data"],
			formulas: [{ sheet: "Data", cell: "C2", formula: "of:=FORMULA([.A1])" }]
		})
	})

	it("writes LibreOffice's own error results as the Excel errors LibreOffice exports them as, and reports them", async () => {
		const cell = (attributes: string, text: string): string =>
			`<table:table-cell ${attributes}><text:p>${text}</text:p></table:table-cell>`
		const row =
			cell(
				'table:formula="of:=EASTERSUNDAY(&quot;x&quot;)" office:value-type="string" office:string-value="" calcext:value-type="error"',
				"Err:502"
			) +
			cell('table:formula="of:=[.Z1]" office:value-type="float" office:value="0" calcext:value-type="error"', "Err:520") +
			cell('table:formula="of:=[.Z2]" office:value-type="float" office:value="0" calcext:value-type="error"', "Err:521") +
			cell('table:formula="of:=1/0" office:value-type="float" office:value="0" calcext:value-type="error"', "#DIV/0!")
		const result = converted(
			await convertSheet(odsBytes({ body: table("S", `<table:table-row>${row}</table:table-row>`) }), "ods", "xlsx")
		)
		const sheet = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))
		const values = [...sheet.matchAll(/<c [^>]*t="e"[^>]*>.*?<v>([^<]*)<\/v>/g)].map(match => match[1])

		expect(values).toEqual(["#VALUE!", "#N/A", "#NULL!", "#DIV/0!"])
		expect(result.lossy.find(feature => feature.kind === "other")).toEqual({ kind: "other", count: 3, sheets: ["S"] })
	})

	it("gives a sheet a name Excel takes, formulas naming it following, and reports it", async () => {
		const long = "A sheet name far longer than thirty-one characters"
		const body2 =
			table(
				long,
				'<table:table-row><table:table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:table-cell></table:table-row>'
			) +
			table(
				"Uses",
				`<table:table-row><table:table-cell table:formula="of:=['${long}'.A1]*2" office:value-type="float" office:value="8"><text:p>8</text:p></table:table-cell></table:table-row>`
			)
		const result = converted(await convertSheet(odsBytes({ body: body2 }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)

		expect(back.workbook.sheets.map(entry => entry.name)).toEqual(["A sheet name far longer than th", "Uses"])
		expect(formulaAt(back, 1, 0, 0)).toBe("'A sheet name far longer than th'!A1*2")
		expect(result.lossy).toContainEqual({ kind: "sheetName", count: 1, sheets: ["A sheet name far longer than th"] })
	})

	for (const [renamed, kept] of [
		["A?", "A"],
		["B:", "B_"],
		["Q:1", "Q_1"]
	] as const)
		it(`renames "${renamed}" past every name already valid ("${kept}" kept), each reference following its own sheet`, async () => {
			const number = (value: number): string =>
				`<table:table-cell office:value-type="float" office:value="${String(value)}"><text:p>${String(value)}</text:p></table:table-cell>`
			const formula = (of: string, value: number): string =>
				`<table:table-cell table:formula="${of}" office:value-type="float" office:value="${String(value)}"><text:p>${String(value)}</text:p></table:table-cell>`
			const body =
				table(renamed, `<table:table-row>${number(1)}</table:table-row>`) +
				table(kept, `<table:table-row>${number(2)}</table:table-row>`) +
				table(
					"Main",
					`<table:table-row>${formula(`of:=['${renamed}'.A1]`, 1)}${formula(`of:=['${kept}'.A1]`, 2)}` +
						`<table:table-cell table:content-validation-name="v1"/><table:table-cell office:value-type="string"><text:p><text:a xlink:href="#'${renamed}'.A1" xlink:type="simple">go</text:a></text:p></table:table-cell></table:table-row>`
				) +
				`<table:content-validations><table:content-validation table:name="v1" table:condition="of:cell-content-is-in-list(['${renamed}'.$A$1:.$A$2])" table:allow-empty-cell="true" table:base-cell-address="Main.C1"/></table:content-validations>` +
				`<table:named-expressions><table:named-range table:name="First" table:base-cell-address="$Main.$A$1" table:cell-range-address="$'${renamed}'.$A$1"/></table:named-expressions>`
			const result = converted(await convertSheet(odsBytes({ body }), "ods", "xlsx"))
			const back = await readXlsx(result.bytes)
			const names = back.workbook.sheets.map(entry => entry.name)

			// The valid name stays; the invalid one takes a name no sheet had.
			expect(names[1]).toBe(kept)
			expect(names[0]).not.toBe(kept)

			// Sheets named as written, quoted or not.
			const bare = (text: string | null | undefined): string => (text ?? "").replace(/^'(.*)'!/, "$1!")

			expect(bare(formulaAt(back, 2, 0, 0))).toBe(`${names[0] ?? ""}!A1`)
			expect(bare(formulaAt(back, 2, 0, 1))).toBe(`${kept}!A1`)
			expect(bare(back.workbook.definedNames.find(name => name.name === "First")?.formula)).toBe(`${names[0] ?? ""}!$A$1`)

			// The validation's list and the link name the renamed sheet too.
			const sheet = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet3.xml"] ?? new Uint8Array(0))
			const escaped = (names[0] ?? "").replace(/[()]/g, "\\$&")

			expect(sheet).toMatch(new RegExp(`<formula1>'?${escaped}'?!\\$A\\$1:\\$A\\$2</formula1>`))
			expect(sheet).toMatch(new RegExp(`location="(?:&apos;)?${escaped}(?:&apos;)?!A1"`))
		})

	it("renames a sheet named with a colon where it is quoted, never an unquoted span of two sheets", () => {
		expect(renameSheetInFormula("SUM('a:b'!A1)+SUM(a:b!A1)", "a:b", "ab")).toBe("SUM('ab'!A1)+SUM(a:b!A1)")
		expect(renameSheetInFormula("'a:b'!A1:B2", "a:b", "a (2)")).toBe("'a (2)'!A1:B2")
	})

	it("renames a sheet a chart reads, the chart's ranges following it", async () => {
		const object =
			'<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3">' +
			'<office:body><office:chart><chart:chart svg:width="10cm" svg:height="6cm" chart:class="chart:bar"><chart:plot-area table:cell-range-address="\'D:ata\'.A1:\'D:ata\'.A2">' +
			'<chart:axis chart:dimension="x" chart:name="primary-x"/><chart:axis chart:dimension="y" chart:name="primary-y"/>' +
			"<chart:series chart:values-cell-range-address=\"'D:ata'.A1:'D:ata'.A2\" chart:class=\"chart:bar\"/></chart:plot-area></chart:chart></office:chart></office:body></office:document-content>"
		const frame =
			'<table:shapes><draw:frame draw:z-index="0" draw:name="Chart 1" svg:width="10cm" svg:height="6cm" svg:x="1cm" svg:y="2cm">' +
			'<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></table:shapes>'
		const rows =
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>' +
			'<table:table-row><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row>'
		const source = odsBytes({
			body: table("D:ata", rows, `${frame}<table:table-column/>`),
			extra: [{ name: "Object 1/content.xml", data: new TextEncoder().encode(object) }],
			manifestEntries:
				'<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/>'
		})
		const result = converted(await convertSheet(source, "ods", "xlsx"))
		const files = unzipSync(result.bytes)
		const chart = Object.entries(files).find(([name]) => /charts\/chart\d+\.xml$/.test(name))?.[1]

		const name = (await readXlsx(result.bytes)).workbook.sheets[0]?.name

		expect(name).toBe("Data")
		expect(strFromU8(chart ?? new Uint8Array(0))).toMatch(/<c:f>Data!\$A\$1:\$A\$2<\/c:f>/)
		expect(strFromU8(chart ?? new Uint8Array(0))).not.toContain("D:ata")
	})

	it(
		"writes the commonest row run as the sheet's default row, a 1.5 KB file of 16 hidden sheets' worth of rows in under a second",
		{ timeout: 120_000 },
		async () => {
			const value =
				'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
			// Hidden rows up to one before the grid's last, a visible one after them.
			const hidden =
				'<table:table-row table:visibility="collapse" table:number-rows-repeated="1048574"><table:table-cell/></table:table-row>' +
				value
			const source = odsBytes({ body: Array.from({ length: 16 }, (_, k) => table(`S${String(k)}`, value + hidden)).join("") })
			const started = cpuMs()
			const result = converted(await convertSheet(source, "ods", "xlsx"))

			expect(cpuMs() - started).toBeLessThan(budget(1000))
			expect(result.bytes.length).toBeLessThan(64 * 1024)

			const back = await readXlsx(result.bytes)

			// The hidden rows hidden by default, the two value rows shown.
			expect(model(back.workbook, 0).format.zeroHeight).toBe(true)
			expect(rowHidden(back, 0, 0)).toBe(false)
			expect(rowHidden(back, 0, 1_048_575)).toBe(false)

			// No row written for the hidden ones: the default hides them.
			const sheet = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))

			expect(sheet.match(/<row /g)?.length).toBe(2)
		}
	)

	it("marks a default row height the source's rows set as set (customHeight), so it survives a reimport", async () => {
		const automatic =
			'<style:style style:name="ro30" style:family="table-row"><style:table-row-properties style:row-height="30pt" style:use-optimal-row-height="false"/></style:style>' +
			'<style:style style:name="ro10" style:family="table-row"><style:table-row-properties style:row-height="10pt" style:use-optimal-row-height="false"/></style:style>'
		const value = (n: number): string =>
			`<table:table-cell office:value-type="float" office:value="${String(n)}"><text:p>${String(n)}</text:p></table:table-cell>`
		const rows =
			`<table:table-row>${value(1)}</table:table-row><table:table-row table:style-name="ro30" table:number-rows-repeated="1048573"><table:table-cell/></table:table-row>` +
			`<table:table-row table:style-name="ro10">${value(2)}</table:table-row><table:table-row>${value(3)}</table:table-row>`
		const result = converted(await convertSheet(odsBytes({ automatic, body: table("S", rows) }), "ods", "xlsx"))
		const sheet = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))

		expect(sheet).toMatch(
			/<sheetFormatPr[^>]*defaultRowHeight="30"[^>]*customHeight="1"|<sheetFormatPr[^>]*customHeight="1"[^>]*defaultRowHeight="30"/
		)
	})

	it("refuses rows of their own past a budget before laying them out", { timeout: 120_000 }, async () => {
		// Rows in an outline group: no default row holds a level, so each is a row of its own.
		const grouped =
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>' +
			'<table:table-row-group><table:table-row table:number-rows-repeated="600000"><table:table-cell/></table:table-row></table:table-row-group>'
		const source = odsBytes({ body: Array.from({ length: 4 }, (_, k) => table(`S${String(k)}`, grouped)).join("") })
		const started = cpuMs()
		const result = await convertSheet(source, "ods", "xlsx")

		expect(result.ok ? null : result.reason).toBe("tooLarge")
		expect(cpuMs() - started).toBeLessThan(budget(3000))
	})

	it(
		"writes rows formatted across the sheet as the columns' format, the few other rows their own, in bounded time and memory",
		{ timeout: 120_000 },
		async () => {
			const automatic =
				'<style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#ff0000"/></style:style>'
			const value =
				'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
			const source = odsBytes({
				automatic,
				body: table(
					"S",
					`${value}<table:table-row table:number-rows-repeated="1048574"><table:table-cell table:style-name="ce1" table:number-columns-repeated="16384"/></table:table-row>${value}`
				)
			})
			const before = process.memoryUsage()
			const started = cpuMs()
			const result = converted(await convertSheet(source, "ods", "xlsx"))
			const after = process.memoryUsage()

			expect(cpuMs() - started).toBeLessThan(budget(1000))
			expect(after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers).toBeLessThan(64 * 1024 * 1024)

			const sheet = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))

			// Every column red, the two value rows (unformatted) their own format.
			expect(sheet).toMatch(/<cols><col min="1" max="16384"[^>]*style="(\d+)"/)
			expect(sheet.match(/<row /g)?.length).toBe(2)
			expect(sheet).toMatch(/<row r="1"[^>]*s="0"[^>]*customFormat="1"/)
			expect(sheet).toMatch(/<row r="1048576"[^>]*s="0"[^>]*customFormat="1"/)

			const back = await readXlsx(result.bytes)
			const red = back.workbook.styles.cellXfs[back.workbook.sheets[0]?.model?.cols[0]?.style ?? 0]

			expect(back.workbook.styles.fills[red?.fillId ?? 0]?.kind).not.toBe("none")
		}
	)

	it("refuses rows formatted across the sheet past the row budget before laying them out", { timeout: 120_000 }, async () => {
		const automatic =
			'<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>'
		// One value row, then a formatted run of every column of 600,000 rows.
		const rows =
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>' +
			'<table:table-row table:number-rows-repeated="600000"><table:table-cell table:style-name="ce1" table:number-columns-repeated="16384"/></table:table-row>'
		const source = odsBytes({ automatic, body: Array.from({ length: 4 }, (_, k) => table(`S${String(k)}`, rows)).join("") })
		const started = cpuMs()
		const result = await convertSheet(source, "ods", "xlsx")

		expect(result.ok ? null : result.reason).toBe("tooLarge")
		expect(cpuMs() - started).toBeLessThan(budget(3000))
	})

	it("writes a workbook without sheets as one of an empty sheet", async () => {
		const result = converted(await convertSheet(odsBytes({ body: "" }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)

		expect(back.workbook.sheets.map(entry => entry.name)).toEqual(["Sheet1"])
	})

	it("keeps a list validation that names a range as that name", async () => {
		const named =
			'<table:content-validations><table:content-validation table:name="val1" table:condition="of:cell-content-is-in-list(Months)" table:allow-empty-cell="true" table:display-list="unsorted" table:base-cell-address="S.A1"/></table:content-validations>' +
			table(
				"S",
				'<table:table-row><table:table-cell office:value-type="string"><text:p>Jan</text:p></table:table-cell><table:table-cell table:content-validation-name="val1"/></table:table-row>'
			) +
			'<table:named-expressions><table:named-range table:name="Months" table:base-cell-address="$S.$A$1" table:cell-range-address="$S.$A$1:.$A$1"/></table:named-expressions>'
		const result = converted(await convertSheet(odsBytes({ body: named }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)
		const sheetModel = model(back.workbook, 0)
		const part = new TextDecoder().decode(await back.workbook.parts.read(sheetModel.part))

		expect(part).toMatch(/<dataValidation[^>]*type="list"[^>]*sqref="B1"[^>]*>\s*<formula1>Months<\/formula1>/)
	})

	it("keeps a validation message's spaces where they are", async () => {
		const spaced =
			'<table:content-validations><table:content-validation table:name="val1" table:allow-empty-cell="true"><table:help-message table:title="T" table:display="true"><text:p>One.<text:s/> Two <text:s text:c="2"/>three</text:p></table:help-message></table:content-validation></table:content-validations>' +
			table("S", '<table:table-row><table:table-cell table:content-validation-name="val1"/></table:table-row>')
		const result = converted(await convertSheet(odsBytes({ body: spaced }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)
		const part = new TextDecoder().decode(await back.workbook.parts.read(model(back.workbook, 0).part))

		expect(part).toContain('prompt="One.  Two   three"')
	})

	it("keeps the line ends before a cell's first span as the cell's own text", async () => {
		const parts = {
			automatic: '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>',
			body: table(
				"S",
				'<table:table-row><table:table-cell office:value-type="string"><text:p/><text:p><text:span text:style-name="T1">bold</text:span></text:p></table:table-cell></table:table-row>'
			)
		}
		const result = converted(await convertSheet(odsBytes(parts), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)
		const store = model(back.workbook, 0).store as SheetStore
		const index = store.value(store.locate(0, 0))

		expect(back.workbook.sharedStrings.runs(index)?.map(run => [run.text, run.font?.bold ?? null])).toEqual([
			["\n", null],
			["bold", true]
		])
	})

	it("writes a format's literal spaces escaped, as LibreOffice reads them before a fill", async () => {
		const parts = {
			automatic:
				'<number:number-style style:name="N1"><number:text> </number:text><number:fill-character> </number:fill-character><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text></number:number-style>' +
				'<style:style style:name="ce1" style:family="table-cell" style:data-style-name="N1"/>',
			body: table(
				"S",
				'<table:table-row><table:table-cell table:style-name="ce1" office:value-type="float" office:value="1497"><text:p> 1,497 </text:p></table:table-cell></table:table-row>'
			)
		}
		const result = converted(await convertSheet(odsBytes(parts), "ods", "xlsx"))
		const styles = strFromU8(unzipSync(result.bytes)["xl/styles.xml"] ?? new Uint8Array(0))

		expect(styles).toContain('formatCode="\\ * #,##0\\ "')
	})

	it("escapes a minus sign beside a fill and quotes a digitless section's text after it, as LibreOffice writes them", async () => {
		const parts = {
			automatic:
				'<number:number-style style:name="N1P0"><number:text> </number:text><number:fill-character> </number:fill-character><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text></number:number-style>' +
				'<number:number-style style:name="N1P1"><number:text>-</number:text><number:fill-character> </number:fill-character><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text></number:number-style>' +
				'<number:text-style style:name="N1P2"><number:text> </number:text><number:fill-character> </number:fill-character><number:text>- </number:text></number:text-style>' +
				'<number:text-style style:name="N1"><number:text> </number:text><number:text-content/><number:text> </number:text><style:map style:condition="value()&gt;0" style:apply-style-name="N1P0"/><style:map style:condition="value()&lt;0" style:apply-style-name="N1P1"/><style:map style:condition="value()=0" style:apply-style-name="N1P2"/></number:text-style>' +
				'<style:style style:name="ce1" style:family="table-cell" style:data-style-name="N1"/>',
			body: table(
				"S",
				'<table:table-row><table:table-cell table:style-name="ce1" office:value-type="float" office:value="0"><text:p>-</text:p></table:table-cell></table:table-row>'
			)
		}
		const result = converted(await convertSheet(odsBytes(parts), "ods", "xlsx"))
		const styles = strFromU8(unzipSync(result.bytes)["xl/styles.xml"] ?? new Uint8Array(0))

		expect(styles).toMatch(/formatCode="\\ \* #,##0\\ ;\\-\* #,##0\\ ;\\ \* &quot;- &quot;;[^"]*"/)
	})

	it("never expands repeated rows of nothing but a format", async () => {
		const repeated = table(
			"S",
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>'
		)
		const result = converted(await convertSheet(odsBytes({ body: repeated }), "ods", "xlsx"))

		expect(result.bytes.length).toBeLessThan(16 * 1024)
		expect(shownRows(await readXlsx(result.bytes), 0)).toEqual([["1"]])
	})

	it("keeps hidden rows hidden without writing the rows after them", async () => {
		const hidden = table(
			"S",
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>' +
				'<table:table-row table:visibility="collapse" table:number-rows-repeated="3"><table:table-cell/></table:table-row>' +
				'<table:table-row><table:table-cell office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell></table:table-row>'
		)
		const result = converted(await convertSheet(odsBytes({ body: hidden }), "ods", "xlsx"))
		const back = await readXlsx(result.bytes)

		expect(rowHidden(back, 0, 1)).toBe(true)
		expect(rowHidden(back, 0, 3)).toBe(true)
		expect(rowHidden(back, 0, 4)).toBe(false)
		expect(shownRows(back, 0)).toEqual([["1"], [], [], [], ["5"]])
	})
})

describe("saveAs.format on an open workbook", () => {
	it("converts the workbook as edited, the session left as it was", async () => {
		const source = buildWorkbook({ sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] })
		const opened = await inThreadSheetHost().open(source, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const session = opened.session

		try {
			const sheet = opened.info.sheets[0]?.id ?? 0

			expect(
				(
					await session.command({
						type: "cells.set",
						sheet,
						cells: { rows: Uint32Array.of(1), cols: Uint16Array.of(0), inputs: ["edited"] }
					})
				).ok
			).toBe(true)

			const result = converted(await session.query("saveAs.format", { format: "ods" }))

			expect(shownRows(await readOds(result.bytes), 0)).toEqual([["1"], ["edited"]])
			expect((await session.query("saveAs.format", { format: "ods" })).ok).toBe(true)

			const own = converted(await session.query("saveAs.format", { format: "xlsx" }))

			expect(shownRows(await readXlsx(own.bytes), 0)).toEqual([["1"], ["edited"]])
			expect(own.lossy).toEqual([])
		} finally {
			session.close()
		}
	})

	it("converts an open ods to xlsx", async () => {
		const opened = await inThreadSheetHost().open(
			odsBytes({
				body: table(
					"S",
					'<table:table-row><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row>'
				)
			}),
			{ kind: "ods", slicing: IMMEDIATE },
			() => undefined
		)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		try {
			const result = converted(await opened.session.query("saveAs.format", { format: "xlsx" }))

			expect(shownRows(await readXlsx(result.bytes), 0)).toEqual([["2"]])
		} finally {
			opened.session.close()
		}
	})
})
