import { describe, expect, it } from "vitest"
import { readSheetTable, resolveStructured, type SheetTable } from "../core/ods/convert/structured"
import { rewriteStructured, specifierColumns } from "../core/xlsx/refs/index"

// A structured reference's column is the table column of that name exactly, letter case aside (ECMA-376 Part 1
// §18.17.6): a bracketed name keeps the spaces it has, so "Total " and "Total" are two columns.

const TABLE: SheetTable = {
	name: "Data",
	sheet: "S",
	ref: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
	headerRows: 1,
	totalsRows: 0,
	columns: ["Total", "Total ", "Funded"]
}
const TABLES = new Map([["DATA", TABLE]])
const HERE = { sheet: "S", row: 2, col: 5 }

describe("a structured reference's column", () => {
	it("is the column named with the same spaces", () => {
		expect(resolveStructured("SUM(Data[[Total ]])", TABLES, HERE)).toBe("SUM($B$2:$B$4)")
		expect(resolveStructured("SUM(Data[[Total]])", TABLES, HERE)).toBe("SUM($A$2:$A$4)")
		expect(resolveStructured('SUMIF(Data[Funded],"Yes",Data[[Total ]])', TABLES, HERE)).toBe('SUMIF($C$2:$C$4,"Yes",$B$2:$B$4)')
	})

	it("matches the name in any letter case", () => {
		expect(resolveStructured("SUM(Data[[TOTAL ]])", TABLES, HERE)).toBe("SUM($B$2:$B$4)")
		expect(resolveStructured("SUM(Data[total])", TABLES, HERE)).toBe("SUM($A$2:$A$4)")
	})

	it("takes the spaces just inside a reference's own brackets as spacing", () => {
		expect(resolveStructured("SUM(Data[ Funded ])", TABLES, HERE)).toBe("SUM($C$2:$C$4)")
		expect(resolveStructured("SUM(Data[ [Total ] ])", TABLES, HERE)).toBe("SUM($B$2:$B$4)")
	})

	it("names no column when no name matches with its spaces", () => {
		expect(resolveStructured("SUM(Data[[Funded ]])", TABLES, HERE)).toBeNull()
	})

	it("is this row's cell of the column, with a bracketed name after @", () => {
		expect(resolveStructured("Data[@[Total ]]*2", TABLES, HERE)).toBe("$B$3*2")
		expect(resolveStructured("Data[@Funded]*2", TABLES, HERE)).toBe("$C$3*2")
		expect(resolveStructured("[@[Total]]", TABLES, { sheet: "S", row: 1, col: 1 })).toBe("$A$2")
	})

	it("breaks on an edit only when the column of that exact name went", () => {
		const tables = new Map([["DATA", { deleted: false as const, columns: new Set(["TOTAL "]) }]])

		expect(specifierColumns("[Total ]")).toEqual(["Total "])
		expect(specifierColumns("[#Headers],[Total ]:[Funded]")).toEqual(["Total ", "Funded"])
		expect(specifierColumns(" Funded ")).toEqual(["Funded"])
		expect(rewriteStructured("SUM(Data[[Total ]])+SUM(Data[[Total]])", null, tables)).toBe("SUM(#REF!)+SUM(Data[[Total]])")
	})
})

describe("a table part's column names", () => {
	const part = (root: string, columns: readonly string[]): Uint8Array =>
		new TextEncoder().encode(
			`<?xml version="1.0" encoding="UTF-8"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${root}>` +
				`<autoFilter ref="A1:B4"/><tableColumns count="${String(columns.length)}">${columns.join("")}</tableColumns></table>`
		)
	const resolved = (bytes: Uint8Array, formula: string): string | null => {
		const table = readSheetTable(bytes, "S")

		return table === null ? null : resolveStructured(formula, new Map([[table.name.toUpperCase(), table]]), HERE)
	}

	it("undoes a name's _xHHHH_ escapes, as a header with a line break is stored", () => {
		const bytes = part('id="1" name="Table1" displayName="Table1" ref="A1:B4"', [
			'<tableColumn id="1" name="Item"/>',
			'<tableColumn id="2" name="Net_x000a_price"/>'
		])

		expect(readSheetTable(bytes, "S")?.columns).toEqual(["Item", "Net\nprice"])
		expect(resolved(bytes, "SUM(Table1[Net\nprice])")).toBe("SUM($B$2:$B$4)")
	})

	it("decodes character references in names", () => {
		const bytes = part('id="1" name="Table1" displayName="Table1" ref="A1:B4"', [
			'<tableColumn id="1" name="A&amp;B"/>',
			'<tableColumn id="2" name="Net&#10;price"/>'
		])

		expect(resolved(bytes, "SUM(Table1[Net\nprice])")).toBe("SUM($B$2:$B$4)")
		expect(resolved(bytes, "SUM(Table1[A&B])")).toBe("SUM($A$2:$A$4)")
	})

	it("reads single-quoted attributes", () => {
		const bytes = part("id='1' name='Table1' displayName='Table1' ref='A1:B4'", [
			"<tableColumn id='1' name='Item'/>",
			"<tableColumn id='2' name='Price'/>"
		])

		expect(resolved(bytes, "SUM(Table1[Price])")).toBe("SUM($B$2:$B$4)")
	})

	it("is no table when the part does not read", () => {
		expect(readSheetTable(new TextEncoder().encode("<table ref="), "S")).toBeNull()
	})
})
