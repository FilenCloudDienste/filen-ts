import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { cfbBytes } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { encodeUtf8 } from "@filen/office/core/xml"
import { CellKind, ColFlag, FormulaFlag, FormulaKind, NO_SPAN, RowFlag, SLOT_BLOCK, XfApply } from "../core/xlsx/model/types"
import {
	BLOCK_ROWS,
	BUILTIN_NUMBER_FORMATS,
	FormulaTable,
	MAX_CELL_XFS,
	SheetStore,
	SheetStrings,
	StoreBuilder,
	XlsxReadError,
	decodeXstring,
	moveRelativeReferences,
	openXlsx,
	parseRange,
	type XlsxSheet,
	type XlsxWorkbook
} from "../core/xlsx/read/index"
import { saveXlsx } from "../core/xlsx/write/save"
import { buildWorkbook, R, SML, workbookFiles, type TestWorkbook } from "./xlsxReadFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"

async function open(workbook: TestWorkbook | Uint8Array): Promise<XlsxWorkbook> {
	const result = await openXlsx(bytesSource(workbook instanceof Uint8Array ? workbook : buildWorkbook(workbook)))

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result.workbook
}

async function sheetOf(workbook: TestWorkbook, index = 0): Promise<{ workbook: XlsxWorkbook; sheet: XlsxSheet; store: SheetStore }> {
	const opened = await open(workbook)
	const sheet = (await opened.load(opened.sheets[index]?.id ?? -1)) as XlsxSheet

	return { workbook: opened, sheet, store: sheet.store }
}

function cell(store: SheetStore, row: number, col: number): { kind: number; value: number; style: number; formula: number } | null {
	const slot = store.locate(row, col)

	return slot < 0 ? null : { kind: store.kind(slot), value: store.value(slot), style: store.style(slot), formula: store.formula(slot) }
}

describe("xlsx reader: cells", () => {
	it("reads every cell type as written", async () => {
		const { workbook, store } = await sheetOf({
			sharedStrings: [
				"zero",
				"one &amp; two",
				'<r><t>rich </t></r><r><rPr><b/><sz val="12"/></rPr><t>run</t></r><rPh sb="0" eb="1"><t>skip</t></rPh>'
			],
			sheets: [
				{
					body:
						"<sheetData>" +
						'<row r="1"><c r="A1"><v>12.5</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="b"><v>0</v></c>' +
						'<c r="E1" t="e"><v>#DIV/0!</v></c><c r="F1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="G1" t="inlineStr"><is><t>in</t><r><t>line</t></r><rPh><t>x</t></rPh></is></c>' +
						'<c r="H1" t="d"><v>2024-01-02T00:00:00</v></c><c r="I1" s="1"/><c r="J1"><v>-1.5E-3</v></c><c r="K1" t="s"><v>2</v></c><c r="L1" t="s"><v>9</v></c>' +
						'<c r="M1"><v>&#49;7</v></c><c r="N1"><v><![CDATA[42]]></v></c><c r="O1"><v/></c><c r="P1" t="b"><v>true</v></c></row>' +
						"</sheetData>"
				}
			]
		})

		expect(cell(store, 0, 0)).toEqual({ kind: CellKind.NUMBER, value: 12.5, style: 0, formula: -1 })
		expect(workbook.sharedStrings.text(cell(store, 0, 1)?.value ?? -1)).toBe("one & two")
		expect(cell(store, 0, 2)).toMatchObject({ kind: CellKind.BOOLEAN, value: 1 })
		expect(cell(store, 0, 3)).toMatchObject({ kind: CellKind.BOOLEAN, value: 0 })
		expect(store.strings.text(cell(store, 0, 4)?.value ?? -1)).toBe("#DIV/0!")
		expect(cell(store, 0, 4)?.kind).toBe(CellKind.ERROR)

		const formulaString = cell(store, 0, 5)

		expect(formulaString?.kind).toBe(CellKind.FORMULA_STRING)
		expect(store.strings.text(formulaString?.value ?? -1)).toBe("ab")
		expect(store.formulas.text(formulaString?.formula ?? -1)).toBe('"a"&"b"')
		expect(cell(store, 0, 6)?.kind).toBe(CellKind.INLINE_STRING)
		expect(store.strings.text(cell(store, 0, 6)?.value ?? -1)).toBe("inline")
		expect(cell(store, 0, 7)?.kind).toBe(CellKind.DATE)
		expect(store.strings.text(cell(store, 0, 7)?.value ?? -1)).toBe("2024-01-02T00:00:00")
		expect(cell(store, 0, 8)).toEqual({ kind: CellKind.EMPTY, value: 0, style: 1, formula: -1 })
		expect(cell(store, 0, 9)?.value).toBe(-1.5e-3)
		expect(workbook.sharedStrings.text(2)).toBe("rich run")
		expect(workbook.sharedStrings.runs(2)).toEqual([
			{ text: "rich ", font: null },
			{ text: "run", font: { bold: true, size: 12 } }
		])
		expect(workbook.sharedStrings.runs(0)).toBeNull()
		// An index past the table reads as no value; the cell stays.
		expect(cell(store, 0, 11)?.kind).toBe(CellKind.EMPTY)
		expect(cell(store, 0, 12)?.value).toBe(17)
		expect(cell(store, 0, 13)?.value).toBe(42)
		expect(cell(store, 0, 14)?.kind).toBe(CellKind.EMPTY)
		expect(cell(store, 0, 15)?.value).toBe(1)
		expect(store.cellCount).toBe(16)
		expect(store.colExtent).toBe(16)
		expect(store.rowExtent).toBe(1)
	})

	it("reads numbers exactly as Number() does", async () => {
		const texts = [
			"0.1",
			"60.11",
			"123456789012345",
			"1234567890123456789",
			"-0",
			"1e308",
			"4.9E-324",
			".5",
			"5.",
			" 7 ",
			"0x10",
			"1,5",
			"Infinity",
			"0.000000000000000000001"
		]
		const { store } = await sheetOf({
			sheets: [
				{
					body: `<sheetData><row r="1">${texts.map((text, col) => `<c r="${String.fromCharCode(65 + col)}1"><v>${text}</v></c>`).join("")}</row></sheetData>`
				}
			]
		})

		texts.forEach((text, col) => {
			const expected = Number(text)
			const found = cell(store, 0, col)

			if (Number.isNaN(expected)) expect(found?.kind).toBe(CellKind.EMPTY)
			else expect(Object.is(found?.value, expected), text).toBe(true)
		})
	})

	it("places cells without references after the previous one, and rows without numbers after the previous row", async () => {
		const { store } = await sheetOf({
			sheets: [
				{
					body: '<sheetData><row><c><v>1</v></c><c><v>2</v></c><c r="E1"><v>3</v></c><c><v>4</v></c></row><row r="5"><c><v>5</v></c></row><row><c r="C6"><v>6</v></c></row></sheetData>'
				}
			]
		})

		expect([cell(store, 0, 0)?.value, cell(store, 0, 1)?.value, cell(store, 0, 4)?.value, cell(store, 0, 5)?.value]).toEqual([
			1, 2, 3, 4
		])
		expect(cell(store, 4, 0)?.value).toBe(5)
		expect(cell(store, 5, 2)?.value).toBe(6)
	})

	it("sorts rows and cells written out of order, merging repeated rows", async () => {
		const { store } = await sheetOf({
			sheets: [
				{
					body: '<sheetData><row r="3"><c r="B3"><v>3</v></c><c r="A3"><v>2</v></c><c r="B3"><v>4</v></c></row><row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="C3"><v>5</v></c></row></sheetData>'
				}
			]
		})
		const block = store.blocks[0]

		expect(cell(store, 0, 0)?.value).toBe(1)
		expect([cell(store, 2, 0)?.value, cell(store, 2, 1)?.value, cell(store, 2, 2)?.value]).toEqual([2, 4, 5])
		expect(store.cellCount).toBe(4)
		expect(block?.rowSpans[2]).toBe(NO_SPAN)
		expect((block?.rowFlags[1] ?? 0) & RowFlag.DIRTY).not.toBe(0)
	})

	it("keeps each row's byte span, attributes and style", async () => {
		const row1 =
			'<row r="1" spans="1:2" ht="20.25" customHeight="1" hidden="1" s="2" customFormat="1" outlineLevel="3" collapsed="true" x14ac:dyDescent="0.25"><c r="A1"><v>1</v></c></row>'
		const body = `<sheetData>${row1}<row r="2"/></sheetData>`
		const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet xmlns="${SML}" xmlns:x14ac="urn:x">${body}</worksheet>`
		const { sheet, store } = await sheetOf({ sheets: [{ xml }] })
		const block = store.blocks[0]
		const source = encodeUtf8(xml)

		expect(new TextDecoder().decode(source.subarray(block?.rowSpans[0], block?.rowSpans[1]))).toBe(row1)
		expect(new TextDecoder().decode(source.subarray(block?.rowSpans[2], block?.rowSpans[3]))).toBe('<row r="2"/>')
		expect(block?.rowHeights[0]).toBe(20.25)
		expect(block?.rowStyles[0]).toBe(2)
		expect(block?.rowFlags[0]).toBe(
			RowFlag.HIDDEN | RowFlag.CUSTOM_HEIGHT | RowFlag.CUSTOM_FORMAT | RowFlag.COLLAPSED | (3 << RowFlag.OUTLINE_SHIFT)
		)
		expect(Number.isNaN(block?.rowHeights[1])).toBe(true)
		expect(sheet.section("sheetData")).toMatchObject({ bytes: null, start: xml.indexOf("<sheetData>") })
		expect(store.rowExtent).toBe(2)
	})

	it("reads SpreadsheetML under a prefix", async () => {
		const xml = `<x:worksheet xmlns:x="${SML}"><x:sheetPr><x:tabColor rgb="FF112233"/></x:sheetPr><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>p</x:t></x:is></x:c><x:c r="B1"><x:f>A1</x:f><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`
		const { sheet, store } = await sheetOf({ sheets: [{ xml }] })

		expect(store.strings.text(cell(store, 0, 0)?.value ?? -1)).toBe("p")
		expect(store.formulas.text(cell(store, 0, 1)?.formula ?? -1)).toBe("A1")
		expect(sheet.prefix).toBe("x")
		expect(sheet.sections.map(section => section.name)).toEqual(["sheetPr", "sheetData"])
		expect(sheet.tabColor).toEqual({ argb: 0xff112233 })
	})

	it("reads a UTF-16 part", async () => {
		const xml = `<?xml version="1.0" encoding="UTF-16"?><worksheet xmlns="${SML}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Grüße 🙂</t></is></c></row></sheetData></worksheet>`
		const bytes = new Uint8Array(2 + xml.length * 2)

		bytes[0] = 0xff
		bytes[1] = 0xfe

		for (let k = 0; k < xml.length; k++) {
			bytes[2 + k * 2] = xml.charCodeAt(k) & 0xff
			bytes[3 + k * 2] = xml.charCodeAt(k) >> 8
		}

		const { sheet, store } = await sheetOf({ sheets: [{ bytes }] })

		expect(sheet.utf16).toBe(true)
		expect(store.strings.text(cell(store, 0, 0)?.value ?? -1)).toBe("Grüße 🙂")
	})
})

describe("xlsx reader: formulas", () => {
	it("keeps shared, array and data-table formulas as written, with ids", async () => {
		const { store } = await sheetOf({
			sheets: [
				{
					body:
						"<sheetData>" +
						'<row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2+$C$1+SUM(B$1:C1)</f><v>2</v></c><c r="D1" cm="1"><f t="array" ref="D1:D2" aca="1">SEQUENCE(2)</f><v>1</v></c></row>' +
						'<row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c><c r="D2"><v>2</v></c></row>' +
						'<row r="3"><c r="A3"><f t="shared" si="0"></f><v>6</v></c><c r="E3"><f t="dataTable" ref="E3:F4" dt2D="1" dtr="1" r1="A1" r2="B1" ca="1"/></c></row>' +
						"</sheetData>"
				}
			]
		})
		const master = store.formula(store.locate(0, 0))
		const child = store.formula(store.locate(2, 0))
		const array = store.formula(store.locate(0, 3))
		const table = store.formula(store.locate(2, 4))

		expect(store.formulas.formula(master)).toEqual({
			kind: FormulaKind.SHARED_MASTER,
			text: "B1*2+$C$1+SUM(B$1:C1)",
			sharedIndex: 0,
			ref: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
			flags: 0,
			cellMetadata: -1
		})
		expect(store.formulas.kind(child)).toBe(FormulaKind.SHARED_CHILD)
		expect(store.formulas.text(child)).toBe("")
		expect(store.formulas.expanded(child, 2, 0)).toBe("B3*2+$C$1+SUM(B$1:C3)")
		expect(store.formulas.expanded(master, 0, 0)).toBe("B1*2+$C$1+SUM(B$1:C1)")
		expect(store.formulas.formula(array)).toMatchObject({ kind: FormulaKind.ARRAY, cellMetadata: 1, flags: FormulaFlag.ALWAYS_ARRAY })
		expect(store.formula(store.locate(1, 3))).toBe(-1)
		expect(store.formulas.formula(table)).toEqual({
			kind: FormulaKind.DATA_TABLE,
			text: "",
			sharedIndex: -1,
			ref: { startRow: 2, startCol: 4, endRow: 3, endCol: 5 },
			flags: FormulaFlag.TWO_D | FormulaFlag.ROW_INPUT | FormulaFlag.ALWAYS,
			cellMetadata: -1,
			r1: "A1",
			r2: "B1"
		})
	})

	it("moves relative references only", () => {
		const cases: [string, number, number, string][] = [
			["A1+B2", 1, 1, "B2+C3"],
			["$A$1+A$1+$A1", 2, 3, "$A$1+D$1+$A3"],
			["SUM(A1:B2)*Sheet2!C3", 1, 0, "SUM(A2:B3)*Sheet2!C4"],
			["'My Sheet'!A1&\"A1\"", 1, 1, "'My Sheet'!B2&\"A1\""],
			["SUM(A:A)+SUM(1:1)+SUM($B:$B)", 1, 1, "SUM(B:B)+SUM(2:2)+SUM($B:$B)"],
			[
				"Table1[[#This Row],[A1]]+LOG10(A1)+_xlfn.XLOOKUP(A1,B:B,C:C)",
				1,
				0,
				"Table1[[#This Row],[A1]]+LOG10(A2)+_xlfn.XLOOKUP(A2,B:B,C:C)"
			],
			["A1048576+XFD1", 1, 1, "#REF!+#REF!"],
			["1.5E+3*A1+#REF!+TRUE", 1, 0, "1.5E+3*A2+#REF!+TRUE"],
			["[1]Sheet1!A1", 0, 1, "[1]Sheet1!B1"],
			["myName+A1B", 1, 1, "myName+A1B"]
		]

		for (const [text, rows, cols, expected] of cases) expect(moveRelativeReferences(text, rows, cols), text).toBe(expected)
	})
})

describe("xlsx reader: sheet sections", () => {
	it("keeps every child of the root as a section and reads the ones the model interprets", async () => {
		const body =
			'<sheetPr codeName="S"><tabColor theme="4" tint="0.4"/></sheetPr><dimension ref="A1:C3"/>' +
			'<sheetViews><sheetView tabSelected="1" zoomScale="85" showGridLines="0" rightToLeft="1" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>' +
			'<selection pane="topRight"/><selection pane="bottomRight" activeCell="C4" sqref="C4 D5:E6"/></sheetView></sheetViews>' +
			'<sheetFormatPr defaultRowHeight="14.4" defaultColWidth="9.5" outlineLevelRow="2"/>' +
			'<cols><col min="1" max="2" width="12.5" customWidth="1" style="1"/><col min="4" max="4" hidden="1" outlineLevel="1"/></cols>' +
			"<sheetData/>" +
			'<sheetProtection algorithmName="SHA-512" hashValue="h" saltValue="s" spinCount="100000" sheet="1" formatCells="0" sort="0" selectLockedCells="1"/>' +
			'<mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="C3:C4"/></mergeCells>' +
			'<mc:AlternateContent xmlns:mc="urn:mc"><mc:Choice Requires="x"/></mc:AlternateContent><extLst><ext uri="x"/></extLst>'
		const { sheet } = await sheetOf({ sheets: [{ body }] })

		expect(sheet.sections.map(section => section.name)).toEqual([
			"sheetPr",
			"dimension",
			"sheetViews",
			"sheetFormatPr",
			"cols",
			"sheetData",
			"sheetProtection",
			"mergeCells",
			"mc:AlternateContent",
			"extLst"
		])
		expect(new TextDecoder().decode(sheet.section("dimension")?.bytes ?? new Uint8Array(0))).toBe('<dimension ref="A1:C3"/>')
		expect(sheet.tabColor).toEqual({ theme: 4, tint: 0.4 })
		expect(sheet.view).toEqual({
			frozen: { rows: 2, cols: 1, topLeftRow: 2, topLeftCol: 1 },
			topRow: 0,
			leftCol: 0,
			activeRow: 3,
			activeCol: 2,
			selection: [
				{ startRow: 3, startCol: 2, endRow: 3, endCol: 2 },
				{ startRow: 4, startCol: 3, endRow: 5, endCol: 4 }
			],
			zoom: 85,
			gridLines: false,
			headings: true,
			rightToLeft: true,
			tabSelected: true,
			view: "normal"
		})
		expect(sheet.format).toMatchObject({ defaultRowHeight: 14.4, defaultColWidth: 9.5, baseColWidth: 8, outlineLevelRow: 2 })
		expect(sheet.cols).toEqual([
			{ first: 0, last: 1, width: 12.5, style: 1, flags: ColFlag.CUSTOM_WIDTH },
			{ first: 3, last: 3, width: Number.NaN, style: -1, flags: ColFlag.HIDDEN | (1 << ColFlag.OUTLINE_SHIFT) }
		])
		expect(Array.from(sheet.merges)).toEqual([0, 0, 1, 1, 2, 2, 3, 2])
		expect(sheet.protection?.hash).toEqual({ algorithmName: "SHA-512", hashValue: "h", saltValue: "s", spinCount: 100000 })
		expect([...(sheet.protection?.allows ?? [])].sort()).toEqual(["formatCells", "objects", "scenarios", "selectUnlockedCells", "sort"])
	})

	it("drops a col range past the grid, clamps one straddling it, and saves a width edit on such a sheet", async () => {
		const body =
			'<cols><col min="1" max="1" width="10" customWidth="1"/><col min="16380" max="16400" width="8" customWidth="1"/>' +
			'<col min="16385" max="16390" width="9"/></cols><sheetData/>'
		const { workbook, sheet } = await sheetOf({ sheets: [{ body }] })

		expect(sheet.cols).toEqual([
			{ first: 0, last: 0, width: 10, style: -1, flags: ColFlag.CUSTOM_WIDTH },
			{ first: 16_379, last: 16_383, width: 8, style: -1, flags: ColFlag.CUSTOM_WIDTH }
		])

		sheet.cols = [{ first: 0, last: 0, width: 20, style: -1, flags: ColFlag.CUSTOM_WIDTH }, ...sheet.cols.slice(1)]
		workbook.changes.sheetSection(0, "cols")

		const result = await saveXlsx({ opc: workbook.opc, workbook })

		expect(result.ok).toBe(true)
	})

	it("reads chartsheets and empty roots", async () => {
		const { sheet, store } = await sheetOf({
			sheets: [
				{
					type: "chartsheet",
					xml: `<chartsheet xmlns="${SML}" xmlns:r="${R}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="rId1"/></chartsheet>`
				}
			]
		})

		expect(sheet.sections.map(section => section.name)).toEqual(["sheetViews", "drawing"])
		expect(store.cellCount).toBe(0)

		const empty = await sheetOf({ sheets: [{ xml: `<worksheet xmlns="${SML}"/>` }] })

		expect(empty.sheet.sections).toEqual([])
	})
})

describe("xlsx reader: workbook", () => {
	it("reads the sheet list, names, calculation, protection and file sharing", async () => {
		const workbook = await open({
			sheets: [
				{ name: "One" },
				{ name: "Two", state: "hidden" },
				{ name: "Chart", type: "chartsheet", xml: `<chartsheet xmlns="${SML}"/>` }
			],
			workbookHead:
				'<fileSharing readOnlyRecommended="1" userName="Ann" algorithmName="SHA-512" hashValue="H" saltValue="S" spinCount="9"/><workbookPr date1904="1"/>' +
				'<workbookProtection lockStructure="1" workbookPassword="CC1A"/><bookViews><workbookView activeTab="1"/></bookViews>',
			workbookTail:
				'<definedNames><definedName name="_xlnm.Print_Area" localSheetId="1">Two!$A$1:$B$2</definedName><definedName name="Rate" hidden="1">0.2</definedName></definedNames>' +
				'<calcPr calcId="191029" calcMode="manual" fullCalcOnLoad="1" iterate="1" iterateCount="50"/>'
		})

		expect(workbook.variant).toBe("xlsx")
		expect(workbook.strict).toBe(false)
		expect(workbook.sheets.map(({ id, name, state, kind, sheetId, part }) => ({ id, name, state, kind, sheetId, part }))).toEqual([
			{ id: 0, name: "One", state: "visible", kind: "worksheet", sheetId: 1, part: "xl/worksheets/sheet1.xml" },
			{ id: 1, name: "Two", state: "hidden", kind: "worksheet", sheetId: 2, part: "xl/worksheets/sheet2.xml" },
			{ id: 2, name: "Chart", state: "visible", kind: "chartsheet", sheetId: 3, part: "xl/worksheets/sheet3.xml" }
		])
		expect(workbook.workbookSections.map(section => section.name)).toEqual([
			"fileSharing",
			"workbookPr",
			"workbookProtection",
			"bookViews",
			"sheets",
			"definedNames",
			"calcPr"
		])
		expect(workbook.definedNames.map(({ name, sheet, formula, hidden }) => ({ name, sheet, formula, hidden }))).toEqual([
			{ name: "_xlnm.Print_Area", sheet: 1, formula: "Two!$A$1:$B$2", hidden: false },
			{ name: "Rate", sheet: null, formula: "0.2", hidden: true }
		])
		expect(new TextDecoder().decode(workbook.definedNames[1]?.source ?? new Uint8Array(0))).toBe(
			'<definedName name="Rate" hidden="1">0.2</definedName>'
		)
		expect(workbook.calc).toEqual({
			calcId: 191029,
			mode: "manual",
			fullCalcOnLoad: true,
			iterate: true,
			iterateCount: 50,
			iterateDelta: 0.001
		})
		expect(workbook.date1904).toBe(true)
		expect(workbook.activeTab).toBe(1)
		expect(workbook.protection).toEqual({ structure: true, windows: false, hash: { legacy: "CC1A" } })
		expect(workbook.fileSharing).toEqual({
			readOnlyRecommended: true,
			userName: "Ann",
			hash: { algorithmName: "SHA-512", hashValue: "H", saltValue: "S", spinCount: 9 }
		})
		expect(workbook.sheets.every(sheet => sheet.model === null)).toBe(true)
		expect(workbook.allocateSheetId()).toBe(3)
		expect(workbook.allocateSheetId()).toBe(4)
	})

	it("reads styles as records and appends without reindexing", async () => {
		const workbook = await open({ sheets: [{}] })
		const styles = workbook.styles

		expect(styles.numFmts.get(164)).toBe("0.000")
		expect(styles.fonts[1]).toEqual({
			bold: true,
			italic: false,
			underline: "single",
			size: 14,
			color: { argb: 0xffff0000 },
			name: "Arial"
		})
		expect(styles.fills[2]).toEqual({ kind: "pattern", pattern: "solid", fg: { argb: 0xff00ff00 }, bg: { indexed: 64 } })
		expect(styles.borders[1]).toEqual({
			left: { style: "thin", color: { auto: true } },
			right: { style: "medium" },
			top: {},
			bottom: { style: "double", color: { theme: 4, tint: -0.25 } },
			diagonal: { style: "hair" },
			diagonalUp: true
		})
		expect(styles.cellXfs[1]).toEqual({
			numFmtId: 164,
			fontId: 1,
			fillId: 2,
			borderId: 1,
			xfId: 0,
			flags: XfApply.NUMBER_FORMAT | XfApply.FONT | XfApply.QUOTE_PREFIX,
			alignment: { horizontal: "center", vertical: "top", wrapText: true, indent: 2, textRotation: 45 },
			protection: { locked: false }
		})
		expect(styles.cellStyleXfs[0]?.xfId).toBe(-1)
		expect(styles.cellStyles).toEqual([{ name: "Normal", xfId: 0, builtinId: 0 }])
		expect(styles.dxfs[0]).toEqual({ font: { bold: true }, fill: { kind: "pattern", pattern: "none", bg: { argb: 0xffffff00 } } })
		expect(styles.sourceCounts).toEqual({ numFmts: 1, fonts: 2, fills: 3, borders: 2, cellXfs: 3, dxfs: 1 })
		expect(styles.numFmtId("0.000")).toBe(164)
		expect(styles.numFmtId("0.00%")).toBe(10)
		expect(styles.numFmtId("#,##0.000")).toBe(165)
		expect(styles.numFmtId("#,##0.000")).toBe(165)
		expect(BUILTIN_NUMBER_FORMATS.get(49)).toBe("@")

		const font = styles.appendFont({ name: "Arial", bold: true })

		expect(font).toBe(2)
		expect(styles.appendFont({ bold: true, name: "Arial" })).toBe(2)
		// An append equal to a source record finds it, so a change back gives the format the file had (a border's
		// edges without a line count as none); `copy` appends a cell format of its own all the same.
		expect(styles.appendFill({ kind: "pattern", pattern: "none" })).toBe(0)
		expect(styles.appendXf({ numFmtId: 0, fontId: 2, fillId: 0, borderId: 0, xfId: 0, flags: XfApply.FONT })).toBe(3)
		expect(styles.appendXf({ fontId: 2, numFmtId: 0, fillId: 0, borderId: 0, xfId: 0, flags: XfApply.FONT })).toBe(3)
		expect(styles.appendXf({ ...(styles.cellXfs[0] ?? { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0, flags: 0 }) })).toBe(0)
		expect(
			styles.appendXf({ ...(styles.cellXfs[0] ?? { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0, flags: 0 }) }, true)
		).toBe(4)
		expect(styles.appendDxf({ font: { italic: true } })).toBe(1)
		expect(styles.appendBorder({ top: {} })).toBe(0)
		expect(styles.appendBorder({ top: { style: "thin" } })).toBe(2)
	})

	it("reads a record wrapped in mc:AlternateContent as one record, its fallback", async () => {
		const workbook = await open({
			sheets: [{}],
			styles:
				'<fonts count="1"><font><sz val="11"/></font></fonts>' +
				'<cellXfs count="3" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:hs="urn:hancom">' +
				'<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
				'<mc:AlternateContent><mc:Choice Requires="hs"><xf numFmtId="1" fontId="0" fillId="0" borderId="0" hs:x="1"/></mc:Choice>' +
				'<mc:Fallback><xf numFmtId="2" fontId="0" fillId="0" borderId="0"/></mc:Fallback></mc:AlternateContent>' +
				'<xf numFmtId="3" fontId="0" fillId="0" borderId="0"/></cellXfs>'
		})

		expect(workbook.styles.cellXfs.map(xf => xf.numFmtId)).toEqual([0, 2, 3])
	})

	it("refuses an xf past Excel's limit", async () => {
		const workbook = await open({ sheets: [{}] })
		const styles = workbook.styles

		for (let k = styles.cellXfs.length; k < MAX_CELL_XFS; k++)
			styles.cellXfs.push({ numFmtId: k, fontId: 0, fillId: 0, borderId: 0, xfId: 0, flags: 0 })

		expect(() => styles.appendXf({ numFmtId: 1, fontId: 1, fillId: 1, borderId: 1, xfId: 0, flags: 0 })).toThrow(XlsxReadError)
	})

	it("finds and appends shared strings over pools", async () => {
		const strings = Array.from({ length: 10_000 }, (_, k) => `s${k}`)
		const workbook = await open({ sheets: [{}], sharedStrings: [...strings, "dup", "dup"] })
		const table = workbook.sharedStrings

		expect(table.sourceLength).toBe(10_002)
		expect(table.sourceCount).toBe(10_002)
		expect(table.text(0)).toBe("s0")
		expect(table.text(4095)).toBe("s4095")
		expect(table.text(4096)).toBe("s4096")
		expect(table.text(9999)).toBe("s9999")
		expect(table.find("s8191")).toBe(8191)
		expect(table.find("dup")).toBe(10_000)
		expect(table.find("absent")).toBe(-1)

		const added = table.append("absent")

		expect(added).toBe(10_002)
		expect(table.append("absent")).toBe(added)
		expect(table.find("absent")).toBe(added)
		expect(table.append("rich", [{ text: "rich", font: { bold: true } }])).toBe(10_003)
		expect(table.runs(10_003)).toEqual([{ text: "rich", font: { bold: true } }])
		table.adjustReferences(2)
		table.adjustReferences(-1)
		expect(table.referenceDelta).toBe(1)
	})

	it("decodes the text escapes Excel writes when asked", () => {
		expect(decodeXstring("a_x000D_b_x005F_x0041_")).toBe("a\rb_x0041_")
		expect(decodeXstring("plain")).toBe("plain")
	})

	it("loads a sheet once for concurrent callers, and every other sheet in idle slices", async () => {
		const workbook = await open({ sheets: [{ body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }, {}, {}] })
		const [a, b] = await Promise.all([workbook.load(1), workbook.load(1)])

		expect(a).toBe(b)

		const ready: number[] = []
		let pauses = 0
		let now = 0

		await workbook.loadAll(
			2,
			{
				sliceMs: 1,
				now: () => (now += 1),
				pause: () => {
					pauses++

					return Promise.resolve()
				}
			},
			sheet => ready.push(sheet.id)
		)

		expect(ready).toEqual([2, 0])
		expect(pauses).toBeGreaterThan(0)
		expect(workbook.sheets.every(sheet => sheet.model !== null)).toBe(true)
	})

	it("gives the host a turn within wide rows", async () => {
		const wide = Array.from({ length: 16_000 }, () => "<c><v>1</v></c>").join("")
		const workbook = await open({
			sheets: [{ body: `<sheetData>${"<row>" + wide + "</row>"}${"<row>" + wide + "</row>"}</sheetData>` }]
		})
		let pauses = 0

		const sheet = await workbook.load(0, {
			sliceMs: 0,
			now: () => 0,
			pause: () => {
				pauses++

				return Promise.resolve()
			}
		})

		expect(sheet.store.cellCount).toBe(32_000)
		expect(pauses).toBeGreaterThanOrEqual(4)
	})

	it("records changes and allocates relationship ids against the source", async () => {
		const workbook = await open({ sheets: [{}] })
		const changes = workbook.changes

		expect(changes.empty).toBe(true)
		expect(() => changes.addRelationship("xl/worksheets/sheet1.xml", { type: "t", target: "x.xml" })).toThrow(XlsxReadError)

		await workbook.parts.relationships(workbook.workbookPart)

		const added = changes.addRelationship(workbook.workbookPart, { type: "urn:t", target: "extra.xml" })

		expect(added).toEqual({ id: "rId2", type: "urn:t", target: "extra.xml", external: false, partName: "xl/extra.xml" })
		changes.removeRelationship(workbook.workbookPart, "rId2")
		expect(changes.relationships.size).toBe(0)
		expect(changes.addRelationship(workbook.workbookPart, { type: "urn:t", target: "extra.xml" }).id).toBe("rId2")
		expect(changes.addRelationship(workbook.workbookPart, { type: "urn:u", target: "http://x", external: true })).toMatchObject({
			id: "rId3",
			external: true,
			partName: undefined
		})
		changes.removeRelationship(workbook.workbookPart, "rIdStyles")
		changes.restoreRelationship(workbook.workbookPart, "rIdStyles")
		expect(changes.relationships.get(workbook.workbookPart)?.removed.size).toBe(0)
		changes.sheetRows(0)
		changes.sheetSection(0, "cols")
		changes.formulasChanged()
		expect(changes.sheets.get(0)).toEqual({ rows: true, sections: new Map([["cols", null]]) })
		expect(changes.dropCalcChain).toBe(true)
		expect(changes.empty).toBe(false)
	})

	it("tells the variant from the main content type and the macros", async () => {
		const variants: [string, string][] = [
			["application/vnd.ms-excel.sheet.macroEnabled.main+xml", "xlsm"],
			["application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml", "xltx"],
			["application/vnd.ms-excel.template.macroEnabled.main+xml", "xltm"]
		]

		for (const [contentType, variant] of variants) expect((await open({ sheets: [{}], contentType })).variant).toBe(variant)

		const macros = await open({
			sheets: [{}],
			workbookRelationships:
				'<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>'
		})

		expect([macros.variant, macros.macros]).toEqual(["xlsm", true])
	})

	it("reads Strict workbooks", async () => {
		const strictSml = "http://purl.oclc.org/ooxml/spreadsheetml/main"
		const strictR = "http://purl.oclc.org/ooxml/officeDocument/relationships"
		const files = workbookFiles({
			sheets: [{ xml: `<worksheet xmlns="${strictSml}"><sheetData><row r="1"><c r="A1"><v>3</v></c></row></sheetData></worksheet>` }]
		})
		const text = (name: string): string => new TextDecoder().decode(files[name])

		files["xl/workbook.xml"] = encodeUtf8(text("xl/workbook.xml").replaceAll(SML, strictSml).replaceAll(R, strictR))
		files["_rels/.rels"] = encodeUtf8(
			text("_rels/.rels").replaceAll("http://schemas.openxmlformats.org/officeDocument/2006/relationships", strictR)
		)
		files["xl/_rels/workbook.xml.rels"] = encodeUtf8(
			text("xl/_rels/workbook.xml.rels").replaceAll("http://schemas.openxmlformats.org/officeDocument/2006/relationships", strictR)
		)

		const workbook = await open(zipSync(files, { mtime: ZIP_ENTRY_TIME }))
		const sheet = await workbook.load(0)

		expect(workbook.strict).toBe(true)
		expect(sheet.store.locate(0, 0)).toBeGreaterThanOrEqual(0)
	})
})

describe("xlsx reader: open failures are typed", () => {
	const failureOf = async (bytes: Uint8Array): Promise<string> => {
		const result = await openXlsx(bytesSource(bytes))

		return result.ok ? "ok" : result.reason
	}

	it("names every kind of file it does not open", async () => {
		expect(await failureOf(encodeUtf8("not a zip at all, just text"))).toBe("notZip")
		expect(await failureOf(zipSync({ "a.txt": encodeUtf8("x") }, { mtime: ZIP_ENTRY_TIME }))).toBe("invalidPackage")
		expect(
			await failureOf(buildWorkbook({ sheets: [{}], contentType: "application/vnd.ms-excel.sheet.binary.macroEnabled.main" }))
		).toBe("unsupported")
		expect(
			await failureOf(
				buildWorkbook({
					sheets: [{}],
					contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
				})
			)
		).toBe("notSpreadsheet")
		expect(
			await failureOf(
				await cfbBytes([
					{ path: ["EncryptionInfo"], bytes: new Uint8Array(8) },
					{ path: ["EncryptedPackage"], bytes: new Uint8Array(16) }
				])
			)
		).toBe("encrypted")
		expect(await failureOf(await cfbBytes([{ path: ["Workbook"], bytes: new Uint8Array(16) }]))).toBe("legacyBinary")
		expect(await failureOf(await cfbBytes([{ path: ["Other"], bytes: new Uint8Array(16) }]))).toBe("compoundFile")

		const files = workbookFiles({ sheets: [{}] })

		files["xl/workbook.xml"] = encodeUtf8("<workbook><sheets>")
		expect(await failureOf(zipSync(files, { mtime: ZIP_ENTRY_TIME }))).toBe("malformed")
	})

	it("refuses a document type declaration, so no entity expands", async () => {
		const xml = `<?xml version="1.0"?><!DOCTYPE w [<!ENTITY a "aaaa">]><worksheet xmlns="${SML}"><sheetData/></worksheet>`
		const workbook = await open({ sheets: [{ xml }] })

		await expect(workbook.load(0)).rejects.toMatchObject({ code: "malformed" })
	})

	it("holds to its limits", async () => {
		const many = buildWorkbook({
			sheets: [
				{
					body: `<sheetData>${Array.from({ length: 50 }, (_, r) => `<row r="${r + 1}"><c><v>1</v></c><c><v>2</v></c></row>`).join("")}</sheetData>`
				}
			]
		})
		const small = await openXlsx(bytesSource(many), { readLimits: { maxCells: 40 } })

		expect(small.ok).toBe(true)

		if (small.ok) await expect(small.workbook.load(0)).rejects.toMatchObject({ code: "tooLarge" })

		const names = buildWorkbook({
			sheets: [{}],
			workbookTail: `<definedNames>${'<definedName name="a">1</definedName>'.repeat(5)}</definedNames>`
		})
		const tooMany = await openXlsx(bytesSource(names), { readLimits: { maxDefinedNames: 4 } })

		expect(tooMany.ok ? "ok" : tooMany.reason).toBe("tooLarge")
	})

	it("rejects a missing sheet part as missing", async () => {
		const files = workbookFiles({ sheets: [{}, {}] })

		delete files["xl/worksheets/sheet2.xml"]

		const workbook = await open(zipSync(files, { mtime: ZIP_ENTRY_TIME }))

		await expect(workbook.load(1)).rejects.toMatchObject({ code: "missingPart" })
		await expect(workbook.load(0)).resolves.toBeDefined()
	})

	it("refuses a cell outside the grid", async () => {
		const workbook = await open({ sheets: [{ body: '<sheetData><row r="1"><c r="XFE1"><v>1</v></c></row></sheetData>' }] })

		await expect(workbook.load(0)).rejects.toMatchObject({ code: "malformed" })
	})
})

describe("xlsx sheet store", () => {
	// A store of `rows` x `cols` numbers (row * cols + col) from source rows with spans, as the reader builds it.
	function storeOf(rows: number, cols: number): SheetStore {
		const builder = new StoreBuilder()

		for (let row = 0; row < rows; row++) {
			builder.beginRow()

			for (let col = 0; col < cols; col++) builder.cell(col, CellKind.NUMBER, row * cols + col, 0, -1)

			builder.endRow(row, row * 100, row * 100 + 90, 0, Number.NaN, -1)
		}

		return new SheetStore(builder.finish(), new SheetStrings(), new FormulaTable())
	}

	it("writes cells in place, adds and removes them, and keeps extents", () => {
		const store = storeOf(3000, 4)

		expect(store.cellCount).toBe(12_000)
		expect(store.blocks.length).toBe(Math.ceil(3000 / BLOCK_ROWS))
		store.setCell(10, 1, CellKind.NUMBER, 99, 0, -1)
		expect(store.value(store.locate(10, 1))).toBe(99)
		store.setCell(10, 7, CellKind.NUMBER, 5, 2, -1)
		expect([store.cellCount, store.colExtent, store.style(store.locate(10, 7))]).toEqual([12_001, 8, 2])
		store.setCell(10, 7, CellKind.EMPTY, 0, 0, -1)
		expect([store.cellCount, store.colExtent, store.locate(10, 7)]).toEqual([12_000, 4, -1])
		store.setCell(5000, 0, CellKind.BOOLEAN, 1, 0, -1)
		expect([store.rowExtent, store.kind(store.locate(5000, 0))]).toEqual([5001, CellKind.BOOLEAN])
		store.setCell(1, 2, CellKind.NUMBER, 1, 0, 7)
		expect(store.formula(store.locate(1, 2))).toBe(7)

		const block = store.blocks[Math.floor(store.locate(1, 2) / SLOT_BLOCK)]

		expect((block?.rowFlags[1] ?? 0) & RowFlag.DIRTY).not.toBe(0)
		expect(block?.rowSpans[2]).not.toBe(NO_SPAN)
		store.setRow(2, 30, 3, RowFlag.HIDDEN | RowFlag.CUSTOM_HEIGHT)
		expect(block?.rowFlags.length).toBeGreaterThan(0)
	})

	it("inserts and deletes rows and columns, keeping each block's source shift", () => {
		const store = storeOf(3000, 3)

		store.insertRows(1500, 10)
		expect(store.value(store.locate(1499, 0))).toBe(1499 * 3)
		expect(store.locate(1505, 0)).toBe(-1)
		expect(store.value(store.locate(1510, 0))).toBe(1500 * 3)
		expect(store.rowExtent).toBe(3010)

		for (const block of store.blocks) {
			if (block.sourceFirstRow >= 0) expect(block.firstRow - block.sourceFirstRow).toBe(block.firstRow >= 1510 ? 10 : 0)
			expect(block.rows[0]).toBe(0)
		}

		store.deleteRows(0, 1000)
		expect(store.value(store.locate(0, 0))).toBe(1000 * 3)
		expect(store.rowExtent).toBe(2010)
		store.insertCols(1, 2)
		expect([store.value(store.locate(0, 0)), store.value(store.locate(0, 3)), store.locate(0, 1), store.colExtent]).toEqual([
			3000, 3001, -1, 5
		])
		store.deleteCols(0, 3)
		expect([store.value(store.locate(0, 0)), store.value(store.locate(0, 1)), store.colExtent]).toEqual([3001, 3002, 2])
		expect(store.cellCount).toBe(2000 * 2)
		store.insertRows(1_048_570, 10)
		expect(store.rowExtent).toBe(2010)
	})

	it("agrees with a plain map over random edits, keeping its invariants", () => {
		let seed = 77
		const random = (n: number): number => {
			seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0

			return (seed >>> 8) % n
		}
		const store = storeOf(2500, 3)
		let reference = new Map<number, number>()

		for (let row = 0; row < 2500; row++) for (let col = 0; col < 3; col++) reference.set(row * 100 + col, row * 3 + col)

		const shiftRows = (at: number, count: number): void => {
			const next = new Map<number, number>()

			for (const [key, value] of reference) {
				const row = Math.floor(key / 100)

				if (count < 0 && row >= at && row < at - count) continue

				next.set(row >= at ? key + count * 100 : key, value)
			}

			reference = next
		}

		for (let step = 0; step < 3000; step++) {
			const row = random(3200)
			const col = random(8)

			switch (random(10)) {
				case 0:
					store.setCell(row, col, CellKind.EMPTY, 0, 0, -1)
					reference.delete(row * 100 + col)
					break
				case 1: {
					const count = 1 + random(3)

					store.insertRows(row, count)
					shiftRows(row, count)
					break
				}
				case 2: {
					const count = 1 + random(3)

					store.deleteRows(row, count)
					shiftRows(row, -count)
					break
				}
				default: {
					const value = step + 0.5

					store.setCell(row, col, CellKind.NUMBER, value, 0, random(4) === 0 ? step : -1)
					reference.set(row * 100 + col, value)
				}
			}
		}

		let cells = 0
		let previous = -1

		for (const block of store.blocks) {
			expect(block.rows[0]).toBe(0)
			expect(block.firstRow).toBeGreaterThan(previous)
			expect(block.rowCount).toBeGreaterThan(0)

			for (let i = 0; i < block.rowCount; i++) {
				if (i > 0) expect(block.rows[i]).toBeGreaterThan(block.rows[i - 1] ?? 0)

				const from = block.rowStarts[i] ?? 0
				const to = block.rowStarts[i + 1] ?? 0
				const flags = block.rowFlags[i] ?? 0

				// A new row with nothing in it is never kept (no row properties are set here).
				if ((flags & RowFlag.NEW) !== 0) expect(to - from).toBeGreaterThan(0)

				for (let k = from + 1; k < to; k++) expect(block.cols[k]).toBeGreaterThan(block.cols[k - 1] ?? 0)
			}

			previous = block.lastRow
			cells += block.cellCount
		}

		expect(store.cellCount).toBe(cells)
		expect(store.cellCount).toBe(reference.size)

		for (const [key, value] of reference) expect(store.value(store.locate(Math.floor(key / 100), key % 100)), String(key)).toBe(value)
	})

	it("estimates what it retains", () => {
		expect(storeOf(1000, 10).estimateBytes()).toBeGreaterThan(1000 * 10 * 15)
	})

	it("reads ranges as written", () => {
		expect(parseRange("$B$2:A1")).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 })
		expect(parseRange("XFD1048576")).toEqual({ startRow: 1_048_575, startCol: 16_383, endRow: 1_048_575, endCol: 16_383 })
		expect(parseRange("A0")).toBeNull()
		expect(parseRange("")).toBeNull()
	})
})
