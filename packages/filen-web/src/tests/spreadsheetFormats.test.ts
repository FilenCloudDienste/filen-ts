import { beforeEach, describe, expect, it } from "vitest"
import { openXlsx, writeXlsx } from "hucre/xlsx"
import { csvDoc, parseCsvFile, serializeCsv } from "@/features/spreadsheet/lib/csvView"
import { cellKey } from "@/features/spreadsheet/lib/model"
import { displayText, workbookDoc, WorkbookViews } from "@/features/spreadsheet/lib/xlsxView"
import { cssColor } from "@/features/spreadsheet/lib/styleTable"
import { standardWindows1252Decoding } from "@/tests/whatwgWindows1252"

const encoder = new TextEncoder()

describe("CSV", () => {
	beforeEach(standardWindows1252Decoding)

	it("reads the separator, line ends, BOM and final line end, and writes them back byte for byte", () => {
		const source = '﻿name;amount\r\n"Smith; J";012\r\n'
		const bytes = encoder.encode(source)
		const { rows, format } = parseCsvFile(bytes, false)

		expect(format).toEqual({
			delimiter: ";",
			lineSeparator: "\r\n",
			bom: true,
			trailingNewline: true,
			encoding: "utf-8",
			writable: true
		})
		expect(rows).toEqual([
			["name", "amount"],
			["Smith; J", "012"]
		])
		expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(serializeCsv(rows, format))).toBe(source)
	})

	it("keeps values as their text, leading zeros and all", () => {
		const { rows, format } = parseCsvFile(encoder.encode("id,zip\n1,007\n"), false)
		const doc = csvDoc(rows, format.writable)

		expect(doc.sheets[0]?.cells.get(cellKey(1, 1))).toEqual({ text: "007", numeric: true })
	})

	it("decodes a legacy Windows-1252 export and writes it back in the same encoding", () => {
		const { rows, format } = parseCsvFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80]), false)

		expect(rows).toEqual([["café", "€"]])
		expect(format.encoding).toBe("windows-1252")
		expect(Array.from(serializeCsv(rows, format))).toEqual([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80])
	})

	it("throws rather than fall back to UTF-8 when asked to write a character windows-1252 cannot hold", () => {
		// serializeCsv no longer falls back to UTF-8: CsvDocument.apply refuses such an edit before it ever
		// reaches here (see spreadsheetCsv.test.ts), so this only guards the direct call staying loud.
		const { rows, format } = parseCsvFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), false)

		rows[0]?.push("日本語")

		expect(() => serializeCsv(rows, format)).toThrow()
	})

	it("reads tab-separated files as such", () => {
		expect(parseCsvFile(encoder.encode("a\tb,c\n"), true).rows).toEqual([["a", "b,c"]])
	})

	it("opens a non-windows-1252 legacy encoding read-only instead of mangling it on save", () => {
		// 0x81 is undefined in windows-1252; a non-fatal decode still returns it rather than throwing, so
		// this is the only signal that the bytes are some other single-byte encoding (Shift-JIS, GBK, ...).
		const { format } = parseCsvFile(new Uint8Array([0x63, 0x61, 0x81, 0x2c, 0x62]), false)

		expect(format.encoding).toBe("windows-1252")
		expect(format.writable).toBe(false)
	})

	it("keeps a genuine windows-1252 export writable", () => {
		const { format } = parseCsvFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80]), false)

		expect(format.encoding).toBe("windows-1252")
		expect(format.writable).toBe(true)
	})

	it("does not mistake a newline inside a quoted field for the row separator", () => {
		const source = '"x\ny",b\r\n1,2\r\n'
		const { rows, format } = parseCsvFile(encoder.encode(source), false)

		expect(format.lineSeparator).toBe("\r\n")
		expect(rows).toEqual([
			["x\ny", "b"],
			["1", "2"]
		])
	})
})

describe("xlsx view", () => {
	it("shows values through their formats, formulas by result with the formula to edit", async () => {
		const bytes = await writeXlsx({
			sheets: [
				{
					name: "Budget",
					rows: [
						["Item", "Cost"],
						["Rent", 1200]
					],
					cells: new Map([
						["1,1", { value: 1200, type: "number", style: { numFmt: '"$"#,##0.00', font: { bold: true } } }],
						["2,1", { value: 1200, type: "formula", formula: "SUM(B2)", formulaResult: 1200 }]
					]),
					merges: [{ startRow: 3, startCol: 0, endRow: 3, endCol: 1 }],
					freezePane: { rows: 1 }
				}
			]
		})
		const workbook = await openXlsx(bytes, { readStyles: true })
		const doc = workbookDoc(workbook, new WorkbookViews(workbook.themeColors), true)
		const sheet = doc.sheets[0]

		expect(sheet?.cells.get(cellKey(1, 1))).toMatchObject({ text: "$1,200.00", input: "1200", numeric: true })
		expect(doc.styles[sheet?.cells.get(cellKey(1, 1))?.style ?? -1]).toMatchObject({ bold: true, numFmt: '"$"#,##0.00' })
		expect(sheet?.cells.get(cellKey(2, 1))).toMatchObject({ text: "1200", input: "=SUM(B2)" })
		expect(sheet?.merges).toEqual([{ startRow: 3, startCol: 0, endRow: 3, endCol: 1 }])
		expect(sheet?.frozenRows).toBe(1)
		expect(sheet?.rowCount).toBeGreaterThanOrEqual(4)
	})

	it("shows dates, booleans and empties plainly", () => {
		expect(displayText(new Date(Date.UTC(2026, 0, 5)), undefined)).toBe("2026-01-05")
		expect(displayText(true, undefined)).toBe("TRUE")
		expect(displayText(null, undefined)).toBe("")
	})

	it("resolves workbook colours to CSS", () => {
		expect(cssColor({ rgb: "FF1F4E79" }, undefined)).toBe("#1f4e79")
		expect(cssColor({ indexed: 2 }, undefined)).toBe("#ff0000")
		expect(cssColor({ theme: 9 }, ["FFFFFF"])).toBeUndefined()
	})
})
