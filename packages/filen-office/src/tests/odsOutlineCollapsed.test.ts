import { describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import { convertSheet, type SheetConversion } from "../core/ods/convert/index"
import { ColFlag, RowFlag, rowRunAt, type XlsxSheetModel } from "../core/xlsx/model/types"
import type { SheetStore } from "../core/xlsx/model/store"
import { buildWorkbook } from "./xlsxReadFixtures"
import { odsBytes, openOdsFixture, table } from "./odsFixtures"

function converted(result: SheetConversion): Extract<SheetConversion, { ok: true }> {
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result
}

async function firstModel(parts: Parameters<typeof openOdsFixture>[0]): Promise<XlsxSheetModel> {
	const opened = await openOdsFixture(parts)
	const sheet = opened.workbook.sheets[0]

	if (sheet?.model === null || sheet?.model === undefined) throw new Error("No sheet")

	return sheet.model
}

function rowFlags(sheet: XlsxSheetModel, row: number): number {
	const store = sheet.store as SheetStore
	const block = store.blocks[store.blockOf(row)]
	const index = block === undefined ? -1 : block.rowIndex(row)

	return block !== undefined && index >= 0 ? (block.rowFlags[index] ?? 0) : (rowRunAt(sheet.rowRuns, row)?.flags ?? 0)
}

function colFlags(sheet: XlsxSheetModel, col: number): number {
	return sheet.cols.find(range => range.first <= col && col <= range.last)?.flags ?? 0
}

const collapsedRow = (sheet: XlsxSheetModel, row: number): boolean => (rowFlags(sheet, row) & RowFlag.COLLAPSED) !== 0
const collapsedCol = (sheet: XlsxSheetModel, col: number): boolean => (colFlags(sheet, col) & ColFlag.COLLAPSED) !== 0

const value = (n: number): string =>
	`<table:table-cell office:value-type="float" office:value="${String(n)}"><text:p>${String(n)}</text:p></table:table-cell>`
const row = (n: number, attributes = ""): string => `<table:table-row${attributes}>${value(n)}</table:table-row>`
const hiddenRow = (n: number): string => row(n, ' table:visibility="collapse"')

describe("collapsed outline groups (table:display)", () => {
	it("marks the summary row after a collapsed row group, not its members", async () => {
		const rows =
			row(1) +
			`<table:table-row-group table:display="false">${hiddenRow(2)}${hiddenRow(3)}</table:table-row-group>` +
			'<table:table-row table:number-rows-repeated="1000"><table:table-cell/></table:table-row>'
		const sheet = await firstModel({ body: table("S", rows) })

		expect(collapsedRow(sheet, 1)).toBe(false)
		expect(collapsedRow(sheet, 2)).toBe(false)
		// The summary is the first of the repeated rows after the group, the rest are not.
		expect(collapsedRow(sheet, 3)).toBe(true)
		expect((rowFlags(sheet, 3) & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT).toBe(0)
		expect(collapsedRow(sheet, 4)).toBe(false)
		expect(collapsedRow(sheet, 500)).toBe(false)
	})

	it("leaves an expanded group's summary row alone and marks a nested group's summary at the outer level", async () => {
		const rows =
			`<table:table-row-group>${row(1)}<table:table-row-group table:display="false">${hiddenRow(2)}</table:table-row-group>${row(3)}</table:table-row-group>` +
			row(4)
		const sheet = await firstModel({ body: table("S", rows) })

		expect(collapsedRow(sheet, 2)).toBe(true)
		expect((rowFlags(sheet, 2) & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT).toBe(1)
		expect(collapsedRow(sheet, 3)).toBe(false)
	})

	it("marks the row past the table's last when a collapsed group ends its rows", async () => {
		const sheet = await firstModel({
			body: table("S", `${row(1)}<table:table-row-group table:display="false">${hiddenRow(2)}</table:table-row-group>`)
		})

		expect(collapsedRow(sheet, 2)).toBe(true)
	})

	it("marks the summary column after a collapsed column group, the first of a repeated run only", async () => {
		const columns =
			'<table:table-column/><table:table-column-group table:display="false"><table:table-column table:visibility="collapse" table:number-columns-repeated="2"/></table:table-column-group>' +
			'<table:table-column table:number-columns-repeated="1020"/>'
		const sheet = await firstModel({ body: table("S", row(1), columns) })

		expect(collapsedCol(sheet, 1)).toBe(false)
		expect(collapsedCol(sheet, 2)).toBe(false)
		expect(collapsedCol(sheet, 3)).toBe(true)
		expect(collapsedCol(sheet, 4)).toBe(false)
		expect((colFlags(sheet, 1) & ColFlag.OUTLINE_MASK) >> ColFlag.OUTLINE_SHIFT).toBe(1)
	})

	it("marks the column past the table's last when a collapsed group ends its columns", async () => {
		const columns =
			'<table:table-column/><table:table-column-group table:display="false"><table:table-column table:visibility="collapse"/></table:table-column-group>'
		const sheet = await firstModel({ body: table("S", row(1), columns) })

		expect(collapsedCol(sheet, 2)).toBe(true)
	})

	it("converts ODS collapsed groups to XLSX collapsed summary rows and columns", async () => {
		const columns =
			'<table:table-column/><table:table-column-group table:display="false"><table:table-column table:visibility="collapse"/></table:table-column-group><table:table-column/>'
		const rows = `${row(1)}<table:table-row-group table:display="false">${hiddenRow(2)}${hiddenRow(3)}</table:table-row-group>${row(4)}`
		const result = converted(await convertSheet(odsBytes({ body: table("S", rows, columns) }), "ods", "xlsx"))
		const xml = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))

		expect(xml).toMatch(/<row r="4"[^>]*collapsed="1"/)
		expect(xml).not.toMatch(/<row r="[23]"[^>]*collapsed="1"/)
		expect(xml).toMatch(/<col min="3" max="3"[^>]*collapsed="1"/)
		expect(xml).not.toMatch(/<col min="2" max="2"[^>]*collapsed="1"/)
	})

	it("converts XLSX collapsed summary rows and columns to ODS groups with table:display false, and reads them back", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<cols><col min="2" max="2" width="9" hidden="1" outlineLevel="1" customWidth="1"/><col min="3" max="3" width="9" collapsed="1" customWidth="1"/>' +
						'<col min="5" max="5" width="9" outlineLevel="1" customWidth="1"/></cols>' +
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2" hidden="1" outlineLevel="1"><c r="A2"><v>2</v></c></row>' +
						'<row r="3" hidden="1" outlineLevel="1"><c r="A3"><v>3</v></c></row><row r="4" collapsed="1"><c r="A4"><v>4</v></c></row>' +
						'<row r="6" outlineLevel="1"><c r="A6"><v>6</v></c></row><row r="7"><c r="A7"><v>7</v></c></row></sheetData>'
				}
			]
		})
		const result = converted(await convertSheet(source, "xlsx", "ods"))
		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))

		expect(content.match(/<table:table-row-group table:display="false">/g)?.length).toBe(1)
		expect(content.match(/<table:table-row-group>/g)?.length).toBe(1)
		expect(content.match(/<table:table-column-group table:display="false">/g)?.length).toBe(1)
		expect(content.match(/<table:table-column-group>/g)?.length).toBe(1)

		const back = converted(await convertSheet(result.bytes, "ods", "xlsx"))
		const xml = strFromU8(unzipSync(back.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))

		expect(xml).toMatch(/<row r="4"[^>]*collapsed="1"/)
		expect(xml).not.toMatch(/<row r="7"[^>]*collapsed="1"/)
		expect(xml).toMatch(/<col min="3" max="3"[^>]*collapsed="1"/)
	})
})
