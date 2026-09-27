import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { openXlsx, writeXlsx } from "hucre/xlsx"
import type { Cell, CellValue, Workbook } from "hucre"
import type { EditResult } from "@/features/spreadsheet/lib/edits"
import { engineFormula, formulaTranslator, renameSheetInFormula, shiftFormula } from "@/features/spreadsheet/lib/formulaRefs"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import { sniffSpreadsheetKind } from "@/features/spreadsheet/lib/spreadsheetClient"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { proven } from "@/tests/spreadsheetProven"
import { checkZipLimits } from "@/features/spreadsheet/lib/zipLimits"

const FIXTURES = new URL("./fixtures/spreadsheet/", import.meta.url)

type Sheets = { name: string; rows: CellValue[][]; cells?: Map<string, Cell> }[]

async function open(sheets: Sheets, namedRanges?: Workbook["namedRanges"]): Promise<XlsxDocument> {
	const bytes = await writeXlsx(namedRanges === undefined ? { sheets } : { sheets, namedRanges })

	return await proven(await openXlsx(bytes, { readStyles: true }))
}

async function reopen(document: XlsxDocument): Promise<XlsxDocument> {
	return await proven(await openXlsx((await document.serialize()).bytes, { readStyles: true }))
}

function formula(formula: string, result: CellValue = null): Cell {
	return { value: result, type: "formula", formula, formulaResult: result }
}

function view(result: EditResult, row: number, col: number, sheet = 0): CellView | null | undefined {
	if (result.type === "cells") {
		return result.patches.find(patch => patch.sheet === sheet)?.cells.find(([key]) => key === cellKey(row, col))?.[1]
	}

	if (result.type === "sheets") {
		return result.sheets[sheet]?.cells.get(cellKey(row, col)) ?? null
	}

	return undefined
}

function shown(document: XlsxDocument, row: number, col: number, sheet = 0): CellView | undefined {
	return document.doc().sheets[sheet]?.cells.get(cellKey(row, col))
}

describe("formula references", () => {
	const insertRow = { type: "insert", axis: "rows", at: 1, count: 2 } as const
	const deleteRow = { type: "delete", axis: "rows", at: 1, count: 1 } as const

	it("moves references for inserts and deletes, whatever surrounds them", () => {
		const cases: [string, string, string][] = [
			["SUM(A1:A3)", "SUM(A1:A5)", "SUM(A1:A2)"],
			["_xlfn.XLOOKUP(A2,A1:A3,B1:B3)", "_xlfn.XLOOKUP(A4,A1:A5,B1:B5)", "_xlfn.XLOOKUP(#REF!,A1:A2,B1:B2)"],
			['IF(A3>0,"say ""A2""","no")', 'IF(A5>0,"say ""A2""","no")', 'IF(A2>0,"say ""A2""","no")'],
			["LOG10(A2)+ATAN2(1,2)", "LOG10(A4)+ATAN2(1,2)", "LOG10(#REF!)+ATAN2(1,2)"],
			["$A$3+A$3+$A3", "$A$5+A$5+$A5", "$A$2+A$2+$A2"],
			["SUM(3:4)+SUM(B:C)", "SUM(5:6)+SUM(B:C)", "SUM(2:3)+SUM(B:C)"],
			["'Bob''s'!A3+S!A3+Other!A3", "'Bob''s'!A3+S!A5+Other!A3", "'Bob''s'!A3+S!A2+Other!A3"],
			["Table1[Col]+[1]S!A3+Jan:Mar!A3", "Table1[Col]+[1]S!A3+Jan:Mar!A3", "Table1[Col]+[1]S!A3+Jan:Mar!A3"],
			["1E+3+TAX2023", "1E+3+TAX2025", "1E+3+TAX2022"]
		]

		for (const [before, inserted, deleted] of cases) {
			expect(shiftFormula(before, "S", "S", insertRow).formula).toBe(inserted)
			expect(shiftFormula(before, "S", "S", deleteRow).formula).toBe(deleted)
		}

		// A formula on another sheet moves only what names the edited one.
		expect(shiftFormula("A3+S!A3", "Other", "S", insertRow).formula).toBe("A3+S!A5")
		expect(shiftFormula("SUM(A:A)+A1", "S", "S", { type: "delete", axis: "cols", at: 0, count: 1 }).formula).toBe("SUM(#REF!)+#REF!")
		// Cut: an end of a reference falls in the deleted run.
		expect(shiftFormula("SUM(A1:A5)+A9", "S", "S", deleteRow).cut).toBe(false)
		expect(shiftFormula("SUM(A2:A5)", "S", "S", deleteRow).cut).toBe(true)
	})

	it("fills a shared formula, renames sheets and spells formulas for the engine", () => {
		const fill = formulaTranslator("A1*$B$1+SUM(A$1:A1)")

		expect(fill(3, 1)).toBe("B4*$B$1+SUM(B$1:B4)")
		expect(fill(-1, 0)).toBe("#REF!*$B$1+SUM(#REF!)")
		expect(renameSheetInFormula("'Bob''s'!A1+'bob''s'!A2+'[1]Bob''s'!A1+'Jan:Bob''s'!A1", "Bob's", "New Name")).toBe(
			"'New Name'!A1+'New Name'!A2+'[1]Bob''s'!A1+'Jan:New Name'!A1"
		)
		expect(engineFormula('_xlfn._xlws.SORT(A1:A3)+_xlfn.XLOOKUP(1,A1:A3,B1:B3)&"a""b"&IF(TRUE,1E+3,FALSE)')).toBe(
			'SORT(A1:A3)+XLOOKUP(1,A1:A3,B1:B3)&("a"&CHAR(34)&"b")&IF(TRUE(),1e+3,FALSE())'
		)
	})
})

describe("XlsxDocument formulas", () => {
	it("expands shared formulas into ordinary ones, keeping their results, and saves them valid", async () => {
		// B1 stores A1*2 for B1:B10 (as Excel writes a fill-down); B2:B10 hold only their results.
		const document = await proven(await openXlsx(readFileSync(new URL("shared.xlsx", FIXTURES)), { readStyles: true }))

		expect(shown(document, 2, 1)).toMatchObject({ text: "6", input: "=A3*2" })
		expect(shown(document, 1, 0, 1)).toMatchObject({ text: "10", input: "=S1!B5" })

		const edited = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 4, col: 0, input: "100" }] })

		expect(view(edited, 4, 1)).toMatchObject({ text: "200" })
		expect(view(edited, 1, 0, 1)).toMatchObject({ text: "200" })

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "=A1*3" }] })
		document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 1 })

		const reopened = await reopen(document)

		expect(shown(reopened, 0, 1)).toMatchObject({ text: "3", input: "=A1*3" })
		expect(shown(reopened, 3, 1)).toMatchObject({ text: "6", input: "=A4*2" })
		expect(shown(reopened, 5, 1)).toMatchObject({ text: "200", input: "=A6*2" })
		expect(shown(reopened, 1, 0, 1)).toMatchObject({ text: "200", input: "=S1!B6" })
	})

	it("hands text to the engine as text", async () => {
		const document = await open([{ name: "S", rows: [[null]] }])
		const result = document.apply({
			type: "setCells",
			sheet: 0,
			cells: [
				{ row: 0, col: 0, input: "'007" },
				{ row: 0, col: 1, input: "=LEN(A1)" },
				{ row: 1, col: 0, input: "'=1+1" },
				{ row: 1, col: 1, input: "=A2" },
				{ row: 2, col: 0, input: "'true" },
				{ row: 2, col: 1, input: "=ISTEXT(A3)" },
				{ row: 3, col: 0, input: "10" },
				{ row: 3, col: 1, input: "'20" },
				{ row: 3, col: 2, input: "=SUM(A4:B4)" }
			]
		})

		expect(view(result, 0, 1)).toMatchObject({ text: "3" })
		expect(view(result, 1, 1)).toMatchObject({ text: "=1+1" })
		expect(view(result, 2, 1)).toMatchObject({ text: "TRUE" })
		expect(view(result, 3, 2)).toMatchObject({ text: "10" })
	})

	it("calculates dates the same in every timezone and shows date results as dates", async () => {
		const document = await open([
			{
				name: "S",
				rows: [[new Date(Date.UTC(2024, 0, 15)), null]],
				cells: new Map([["0,1", { value: null, type: "empty", style: { numFmt: "yyyy-mm-dd" } }]])
			}
		])
		const result = document.apply({
			type: "setCells",
			sheet: 0,
			cells: [
				{ row: 0, col: 1, input: "=A1+1" },
				{ row: 0, col: 2, input: "=DAY(A1)" },
				{ row: 0, col: 3, input: "=A1-DATE(2024,1,15)" }
			]
		})

		expect(view(result, 0, 1)).toMatchObject({ text: "2024-01-16" })
		expect(view(result, 0, 2)).toMatchObject({ text: "15" })
		expect(view(result, 0, 3)).toMatchObject({ text: "0" })
	})

	it("keeps the file's results for formulas the engine cannot read, and calculates what depends on them", async () => {
		const document = await open([
			{
				name: "S",
				rows: [
					[1, "ab", 3],
					[null, 'say "hi"', 10]
				],
				cells: new Map([
					["0,1", formula('_xlfn.CONCAT("a","b")', "ab")],
					["0,2", formula("LEN(B1)+A1", 3)],
					["1,1", formula('IF(A1>0,"say ""hi""","no")', 'say "hi"')],
					["1,2", formula("SUM(A1:A2 A1:C1)", 10)]
				])
			}
		])
		const result = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "-1" }] })

		expect(view(result, 0, 2)).toMatchObject({ text: "1" })
		expect(view(result, 1, 1)).toMatchObject({ text: "no" })
		// An intersection it has no syntax for: the stored result stays, the reference still moves.
		expect(shown(document, 1, 2)).toMatchObject({ text: "10" })

		const inserted = document.apply({ type: "insert", sheet: 0, axis: "rows", at: 0, count: 1 })

		expect(view(inserted, 2, 2)).toMatchObject({ text: "10", input: "=SUM(A2:A3 A2:C2)" })
		expect(view(inserted, 1, 1)).toMatchObject({ input: '=_xlfn.CONCAT("a","b")' })
	})

	it("keeps a legacy array formula's stored result rather than the engine's #SPILL!", async () => {
		const document = await open([
			{
				name: "S",
				rows: [
					[1, null, 2, 3],
					[2, null, 4, null],
					[3, null, 6, null]
				],
				cells: new Map<string, Cell>([
					["0,2", { ...formula("A1:A3*2", 2), formulaType: "array", formulaRef: "C1:C3" }],
					["0,3", formula("C1+1", 3)]
				])
			}
		])

		expect(shown(document, 0, 2)).toMatchObject({ text: "2", input: "=A1:A3*2" })

		const edited = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 0, input: "20" }] })

		expect(view(edited, 0, 2) ?? shown(document, 0, 2)).toMatchObject({ text: "2" })
		expect(shown(document, 0, 3)).toMatchObject({ text: "3" })
		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 2, col: 3, input: "=C1*10" }] }), 2, 3)).toMatchObject({
			text: "20"
		})
	})

	it("calculates formulas that named a sheet once it is added, and puts their results back on undo", async () => {
		const document = await open([
			{
				name: "S",
				rows: [["#REF!", "#REF!"]],
				cells: new Map([
					["0,0", formula("New!A1+1", "#REF!")],
					["0,1", formula("A1*2", "#REF!")]
				])
			}
		])
		const added = document.apply({ type: "addSheet", name: "New" })

		expect(view(added, 0, 0)).toMatchObject({ text: "1", input: "=New!A1+1" })
		expect(view(added, 0, 1)).toMatchObject({ text: "2" })
		expect(view(document.apply({ type: "setCells", sheet: 1, cells: [{ row: 0, col: 0, input: "5" }] }), 0, 1)).toMatchObject({
			text: "12"
		})

		document.undo()
		document.undo()

		expect(shown(document, 0, 0)).toMatchObject({ text: "#REF!", error: true })
		expect(shown(document, 0, 1)).toMatchObject({ text: "#REF!" })
		expect(document.doc().sheets).toHaveLength(1)
	})

	it("moves hyperlinks into a sheet for inserts and deletes, and back on undo", async () => {
		const link = (location: string) => ({ value: "go", type: "string" as const, hyperlink: { target: "", location } })
		const document = await open([
			{ name: "S", rows: [["go"], [null], [null], [null]], cells: new Map([["0,0", link("S!A4")]]) },
			{
				name: "Other",
				rows: [["go", "go", "go"]],
				cells: new Map([
					["0,0", link("'S'!B3")],
					["0,1", link("A3")],
					["0,2", link("S!A2")]
				])
			}
		])
		const locations = async () =>
			(await openXlsx((await document.serialize()).bytes)).sheets.map(sheet =>
				[...(sheet.cells?.values() ?? [])].map(cell => cell.hyperlink?.location)
			)

		document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 2 })

		expect(await locations()).toEqual([["S!A6"], ["'S'!B5", "A3", "S!A4"]])

		document.undo()
		document.apply({ type: "delete", sheet: 0, axis: "rows", at: 1, count: 1 })

		expect(await locations()).toEqual([["S!A3"], ["'S'!B2", "A3", "S!#REF!"]])

		document.undo()

		expect(await locations()).toEqual([["S!A4"], ["'S'!B3", "A3", "S!A2"]])
	})

	it("keeps recalculating after sheet steps and their undo, in a file that had no formulas", async () => {
		const document = await open([{ name: "S", rows: [[1, null]] }])

		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "=A1*2" }] }), 0, 1)).toMatchObject({
			text: "2"
		})

		document.apply({ type: "addSheet", name: "X" })
		document.apply({ type: "renameSheet", sheet: 0, name: "T" })

		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "5" }] }), 0, 1)).toMatchObject({
			text: "10"
		})
		expect(view(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 0, count: 1 }), 1, 1)).toMatchObject({
			text: "10",
			input: "=A2*2"
		})

		document.undo()
		document.undo()
		document.undo()

		const undone = document.undo()

		expect(undone.type).toBe("sheets")
		expect(shown(document, 0, 1)).toMatchObject({ text: "2" })
		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "7" }] }), 0, 1)).toMatchObject({
			text: "14"
		})
	})

	it("renames the sheet in defined names and hyperlinks, and undoes it", async () => {
		const document = await open(
			[
				{
					name: "Bob's Data",
					rows: [[1, 2, 3]],
					cells: new Map([["0,0", { value: 1, type: "number", hyperlink: { target: "", location: "'Bob''s Data'!C1" } }]])
				},
				{ name: "Sum", rows: [[6]], cells: new Map([["0,0", formula("SUM(Total)", 6)]]) }
			],
			[{ name: "Total", range: "'Bob''s Data'!$A$1:$C$1" }]
		)

		document.apply({ type: "renameSheet", sheet: 0, name: "Bobs" })

		const reopened = await reopen(document)
		const edited = reopened.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 2, input: "10" }] })

		expect(view(edited, 0, 0, 1)).toMatchObject({ text: "13" })

		const workbook = await openXlsx((await document.serialize()).bytes)

		expect(workbook.namedRanges).toEqual([{ name: "Total", range: "Bobs!$A$1:$C$1" }])
		expect(workbook.sheets[0]?.cells?.get("0,0")?.hyperlink?.location).toBe("Bobs!C1")

		document.undo()

		const undone = await openXlsx((await document.serialize()).bytes)

		expect(undone.namedRanges).toEqual([{ name: "Total", range: "'Bob''s Data'!$A$1:$C$1" }])
	})

	it("scopes sheet-level names to their sheets", async () => {
		const document = await open(
			[
				{ name: "A", rows: [[1, 2]], cells: new Map([["0,1", formula("Rate*2", 2)]]) },
				{ name: "B", rows: [[2, 4]], cells: new Map([["0,1", formula("Rate*2", 4)]]) }
			],
			[
				{ name: "Rate", range: "A!$A$1", scope: "A" },
				{ name: "Rate", range: "B!$A$1", scope: "B" }
			]
		)
		const result = document.apply({ type: "setCells", sheet: 1, cells: [{ row: 0, col: 0, input: "5" }] })

		expect(view(result, 0, 1, 1)).toMatchObject({ text: "10" })
		expect(shown(document, 0, 1, 0)).toMatchObject({ text: "2" })
	})

	it("opens a sheet named __proto__", async () => {
		const document = await open([{ name: "__proto__", rows: [[1, 2]], cells: new Map([["0,1", formula("A1*2", 2)]]) }])

		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "5" }] }), 0, 1)).toMatchObject({
			text: "10"
		})
	})
})

describe("XlsxDocument edits", () => {
	it("patches the sheets a formula reaches instead of sending the workbook", async () => {
		const document = await open([
			{ name: "Data", rows: [[1, 2]] },
			{ name: "Sum", rows: [[2]], cells: new Map([["0,0", formula("Data!A1*2", 2)]]) }
		])
		const result = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "7" }] })

		expect(result.type).toBe("cells")
		expect(result.type === "cells" ? result.patches.map(patch => patch.sheet).sort() : null).toEqual([0, 1])
		expect(view(result, 0, 0, 1)).toMatchObject({ text: "14" })
		// No new format: no style table.
		expect(result.type === "cells" ? result.styles : null).toEqual([])
	})

	it("inserts and deletes many rows, and undoes a deletion with what it took", async () => {
		const document = await open([
			{
				name: "S",
				rows: [
					[1, null],
					[2, null],
					[3, null]
				],
				cells: new Map([["2,1", formula("SUM(A1:A3)", 6)]])
			}
		])

		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 300_000 }).type).toBe("sheets")
		expect(shown(document, 300_002, 1)).toMatchObject({ text: "6", input: "=SUM(A1:A300003)" })

		document.undo()
		document.apply({ type: "delete", sheet: 0, axis: "rows", at: 0, count: 1 })

		expect(shown(document, 1, 1)).toMatchObject({ text: "5", input: "=SUM(A1:A2)" })

		document.undo()

		expect(shown(document, 0, 0)).toMatchObject({ text: "1" })
		expect(shown(document, 2, 1)).toMatchObject({ text: "6", input: "=SUM(A1:A3)" })
		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "10" }] }), 2, 1)).toMatchObject({
			text: "15"
		})
	})

	it("recalculates through ranges a deletion shrank, once it is undone", async () => {
		const document = await open([
			{
				name: "S",
				rows: [[1], [2], [3], [4], [10]],
				cells: new Map([["4,0", formula("SUM(A1:A4)", 10)]])
			},
			{ name: "T", rows: [[3]], cells: new Map([["0,0", formula("S!A3", 3)]]) }
		])

		document.apply({ type: "delete", sheet: 0, axis: "rows", at: 1, count: 2 })

		expect(shown(document, 2, 0)).toMatchObject({ text: "5", input: "=SUM(A1:A2)" })
		expect(shown(document, 0, 0, 1)).toMatchObject({ text: "#REF!", input: "=S!#REF!" })

		document.undo()

		const edited = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 2, col: 0, input: "30" }] })

		expect(view(edited, 4, 0)).toMatchObject({ text: "37", input: "=SUM(A1:A4)" })
		expect(view(edited, 0, 0, 1)).toMatchObject({ text: "30", input: "=S!A3" })
	})

	it("keeps undo history within a cell budget", async () => {
		const rows = Array.from({ length: 10 }, (_, row) => Array.from({ length: 10 }, (_, col) => row * 10 + col))
		const workbook = await openXlsx(await writeXlsx({ sheets: [{ name: "S", rows }] }))
		// Room for two deletions of 30 cells, not three.
		const document = await proven(workbook, 70)

		for (let step = 0; step < 3; step++) {
			document.apply({ type: "delete", sheet: 0, axis: "rows", at: 0, count: 3 })
		}

		let undone = 0

		while (document.undo().type !== "none") undone++

		expect(undone).toBe(2)
		expect(shown(document, 0, 0)).toMatchObject({ text: "30" })
	})

	it("tracks the saved state across undo and redo", async () => {
		const document = await open([{ name: "S", rows: [[1]] }])

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "2" }] })

		const saved = await document.serialize()

		// An edit made while the save uploads stays unsaved.
		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "3" }] })

		expect(document.markSaved(saved.version)).toMatchObject({ dirty: true })
		expect(document.undo().state.dirty).toBe(false)
		expect(document.undo().state.dirty).toBe(true)
		expect(document.redo().state.dirty).toBe(false)

		// Another edit from the saved state is a different state, even at the same depth.
		document.undo()
		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "9" }] })

		expect(document.markSaved(saved.version).dirty).toBe(true)
	})
})

describe("XlsxDocument locks", () => {
	it("opens a workbook with a chart sheet view-only, and locks rows and renames around its charts", async () => {
		const workbook = await openXlsx(readFileSync(new URL("chartsheet.xlsx", FIXTURES)), { readStyles: true })
		const document = await proven(workbook)
		const doc = document.doc()

		expect(doc.writable).toBe(false)
		expect(doc.sheets.map(sheet => sheet.name)).toEqual(["Data"])
		expect(doc.sheets[0]?.structureLocked).toBe(true)
		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 0, count: 1 })).toMatchObject({ reason: "structureLocked" })
		expect(document.apply({ type: "renameSheet", sheet: 0, name: "Numbers" })).toMatchObject({ reason: "structureLocked" })
		await expect(document.serialize()).rejects.toThrow()
	})

	it("opens a workbook whose tab order is not its part order view-only when parts ride on positions", async () => {
		const reordered = await proven(await openXlsx(readFileSync(new URL("reordered.xlsx", FIXTURES)), { readStyles: true }))

		expect(reordered.writable).toBe(false)

		const plain = await open([
			{ name: "A", rows: [[1]] },
			{ name: "B", rows: [[2]] }
		])

		expect(plain.writable).toBe(true)
	})

	it("refuses to save a workbook whose parts saving would drop", async () => {
		const workbook = await openXlsx(await writeXlsx({ sheets: [{ name: "A", rows: [[1]] }] }))
		const state = Object.getOwnPropertySymbols(workbook).map(
			symbol => Reflect.get(workbook, symbol) as { rawEntries: Map<string, Uint8Array> }
		)[0]
		const rels = state?.rawEntries.get("xl/_rels/workbook.xml.rels")

		expect(rels).toBeDefined()

		state?.rawEntries.set(
			"xl/_rels/workbook.xml.rels",
			new TextEncoder().encode(
				new TextDecoder()
					.decode(rels)
					.replace(
						"</Relationships>",
						'<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/connections" Target="connections.xml"/></Relationships>'
					)
			)
		)

		expect((await proven(workbook)).writable).toBe(false)
	})
})

describe("spreadsheet files", () => {
	it("tells a workbook from text by its first bytes", () => {
		expect(sniffSpreadsheetKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("xlsx")
		expect(sniffSpreadsheetKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("xls")
		expect(sniffSpreadsheetKind(new TextEncoder().encode("a,b\n"))).toBe("csv")
	})

	// A central directory and its end record, sizes as declared: nothing here is ever inflated.
	function zipDirectory(entries: { compressed: number; uncompressed: number; method?: number; flags?: number }[]): Uint8Array {
		const bytes = new Uint8Array(entries.length * 47 + 22)
		const view = new DataView(bytes.buffer)

		entries.forEach((entry, index) => {
			const at = index * 47

			view.setUint32(at, 0x02014b50, true)
			view.setUint16(at + 8, entry.flags ?? 0, true)
			view.setUint16(at + 10, entry.method ?? 8, true)
			view.setUint32(at + 20, entry.compressed, true)
			view.setUint32(at + 24, entry.uncompressed, true)
			view.setUint16(at + 28, 1, true)
		})

		const end = entries.length * 47

		view.setUint32(end, 0x06054b50, true)
		view.setUint16(end + 10, entries.length, true)
		view.setUint32(end + 16, 0, true)

		return bytes
	}

	it("refuses a zip whose entries inflate too large together, or could inflate past what they declare", () => {
		const check = (entries: Parameters<typeof zipDirectory>[0]) => () => {
			checkZipLimits(zipDirectory(entries), { maxEntries: 100, maxBytes: 1000 })
		}
		const large = { compressed: 10, uncompressed: 600 }

		expect(check([large])).not.toThrow()
		expect(check([large, large])).toThrow()
		expect(check([{ compressed: 10, uncompressed: 0 }])).toThrow()
		expect(check([{ compressed: 0, uncompressed: 0, flags: 8 }])).toThrow()
		expect(check(Array.from({ length: 101 }, () => ({ compressed: 0, uncompressed: 0 })))).toThrow()
	})
})
