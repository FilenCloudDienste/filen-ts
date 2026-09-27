import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { openXlsx, writeXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { EditResult } from "@/features/spreadsheet/lib/edits"
import { shownFormula, storedFormula } from "@/features/spreadsheet/lib/formulaRefs"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import type { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { readZip } from "@/features/spreadsheet/lib/zipLimits"
import { proven } from "@/tests/spreadsheetProven"

// Fixtures x365_*.xlsx: made-up workbooks shaped as Excel 365 writes them, one trait each.
const FIXTURES = new URL("./fixtures/spreadsheet/", import.meta.url)

async function fixture(name: string): Promise<RoundtripWorkbook> {
	return await openXlsx(readFileSync(new URL(name, FIXTURES)), { readStyles: true })
}

async function savedParts(document: XlsxDocument): Promise<Map<string, string>> {
	const parts = (await readZip((await document.serialize()).bytes)) ?? new Map<string, Uint8Array>()
	const decoder = new TextDecoder()

	return new Map([...parts].map(([path, bytes]) => [path, decoder.decode(bytes)]))
}

function view(result: EditResult, row: number, col: number, sheet = 0): CellView | null | undefined {
	return result.type === "cells"
		? result.patches.find(patch => patch.sheet === sheet)?.cells.find(([key]) => key === cellKey(row, col))?.[1]
		: undefined
}

describe("Excel 365 files", () => {
	it("proves what Excel writes and saving keeps: revision marks, author path, calc features, slicer style defaults", async () => {
		for (const name of [
			"x365_plain.xlsx",
			"x365_dates.xlsx",
			"x365_colstyle.xlsx",
			"x365_emptyrows.xlsx",
			"x365_cfsplit.xlsx",
			"x365_codename.xlsx",
			"x365_tabledxf.xlsx",
			"x365_calcpr.xlsx"
		]) {
			const document = await proven(await fixture(name))

			expect([name, document.losses]).toEqual([name, []])
		}
	})

	it("writes back what Excel files carry: dates as the locale's short date, column formats, formatted rows, table formats, code names", async () => {
		const dates = await savedParts(await proven(await fixture("x365_dates.xlsx")))

		expect(dates.get("xl/styles.xml")).toMatch(/<xf numFmtId="14"/)

		const columns = await savedParts(await proven(await fixture("x365_colstyle.xlsx")))

		expect(columns.get("xl/worksheets/sheet1.xml")).toMatch(/<col min="1" max="16384"[^>]*style=/)
		expect(columns.get("xl/worksheets/sheet1.xml")).not.toMatch(/<c r="A1"[^>]* s="/)

		const rows = await savedParts(await proven(await fixture("x365_emptyrows.xlsx")))

		expect(rows.get("xl/worksheets/sheet1.xml")).toMatch(/<row r="7"[^>]*customFormat/)

		const codeName = await savedParts(await proven(await fixture("x365_codename.xlsx")))

		expect(codeName.get("xl/worksheets/sheet1.xml")).toMatch(/<sheetPr codeName="Tabelle1"/)

		const table = await savedParts(await proven(await fixture("x365_tabledxf.xlsx")))
		const dxfId = /<tableColumn [^>]*name="Qty"[^>]*dataDxfId="(\d+)"/.exec(table.get("xl/tables/table1.xml") ?? "")?.[1]
		const dxfs = /<dxfs[^>]*>([\s\S]*?)<\/dxfs>/.exec(table.get("xl/styles.xml") ?? "")?.[1]?.match(/<dxf>[\s\S]*?<\/dxf>/g) ?? []

		expect(dxfs[Number(dxfId)]).toMatch(/formatCode="#,##0"/)

		const calc = await savedParts(await proven(await fixture("x365_calcpr.xlsx")))

		expect(calc.get("xl/workbook.xml")).toMatch(/<calcPr[^>]*fullPrecision="0"[^>]*refMode="R1C1"/)
	})

	it("keeps view-only what saving would change: pivot formats, a shown note, hidden sheet tabs, a hyperlink base", async () => {
		const pivot = await proven(await fixture("x365_pivotformat.xlsx"))

		expect(pivot.writable).toBe(false)
		expect(pivot.losses.some(loss => loss.includes("renumbers"))).toBe(true)

		const note = await proven(await fixture("x365_visiblenote.xlsx"))

		expect(note.losses.some(loss => loss.includes("shown all the time"))).toBe(true)
		expect((await proven(await fixture("x365_bookviews.xlsx"))).writable).toBe(false)
		expect((await proven(await fixture("x365_hlbase.xlsx"))).writable).toBe(false)
	})

	it("writes whole-sheet column formats as one range", async () => {
		const parts = await savedParts(await proven(await fixture("hidecols.xlsx")))

		expect(parts.get("xl/worksheets/sheet1.xml")?.match(/<col /g)?.length ?? 0).toBeLessThan(10)
	})
})

describe("formula text", () => {
	it("stores newer functions with the prefix Excel reads and shows them without it", async () => {
		expect(storedFormula('XLOOKUP(2,A1:A3,B1:B3)&TEXTJOIN("-",TRUE,B1:B3)&"XLOOKUP("')).toBe(
			'_xlfn.XLOOKUP(2,A1:A3,B1:B3)&_xlfn.TEXTJOIN("-",TRUE,B1:B3)&"XLOOKUP("'
		)
		expect(storedFormula("SUM(FILTER(A:A,A:A>1))+_xlfn.XLOOKUP(1,A:A,B:B)")).toBe(
			"SUM(_xlfn._xlws.FILTER(A:A,A:A>1))+_xlfn.XLOOKUP(1,A:A,B:B)"
		)
		expect(shownFormula("_xlfn._xlws.FILTER(A:A,A:A>1)+_xlfn.NEWTHING(1)")).toBe("FILTER(A:A,A:A>1)+_xlfn.NEWTHING(1)")
		expect(storedFormula(shownFormula("_xlfn.CONCAT(A1)"))).toBe("_xlfn.CONCAT(A1)")

		const document = await proven(await openXlsx(await writeXlsx({ sheets: [{ name: "S", rows: [[1, "a"]] }] }), { readStyles: true }))
		const typed = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 2, input: '=TEXTJOIN("-",TRUE,A1:B1)' }] })

		expect(view(typed, 0, 2)).toMatchObject({ text: "1-a", input: '=TEXTJOIN("-",TRUE,A1:B1)' })
		expect((await savedParts(document)).get("xl/worksheets/sheet1.xml")).toContain("<f>_xlfn.TEXTJOIN(")
	})

	it("quotes a renamed sheet whose name has anything but letters, digits, underscores and periods", async () => {
		const document = await proven(
			await openXlsx(
				await writeXlsx({
					sheets: [
						{
							name: "S",
							rows: [[null]],
							cells: new Map([["0,0", { value: 5, type: "formula" as const, formula: "Other!A1", formulaResult: 5 }]])
						},
						{ name: "Other", rows: [[5]] }
					]
				}),
				{ readStyles: true }
			)
		)
		const formulaAfter = (name: string) => {
			document.apply({ type: "renameSheet", sheet: 1, name })

			return document.doc().sheets[0]?.cells.get(cellKey(0, 0))?.input
		}

		expect(formulaAfter("Q1–Q2")).toBe("='Q1–Q2'!A1")
		expect(formulaAfter("Umsatz€")).toBe("='Umsatz€'!A1")
		expect(formulaAfter("Kosten§3")).toBe("='Kosten§3'!A1")
		expect(formulaAfter("Données")).toBe("=Données!A1")
	})

	it("does not build an array sized from cells past the limit", async () => {
		const document = await proven(await openXlsx(await writeXlsx({ sheets: [{ name: "S", rows: [[16_000]] }] }), { readStyles: true }))
		const started = performance.now()
		const result = document.apply({
			type: "setCells",
			sheet: 0,
			cells: [
				{ row: 1, col: 0, input: "=SEQUENCE(A1,A1)" },
				{ row: 2, col: 0, input: "=SUM(SEQUENCE(A1))" }
			]
		})

		expect(performance.now() - started).toBeLessThan(2000)
		expect(view(result, 1, 0)).toMatchObject({ text: "#N/A" })
		expect(view(result, 2, 0)).toMatchObject({ text: "128008000" })
	})
})
