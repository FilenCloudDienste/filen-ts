import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { openXlsx, saveXlsx, writeXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { EditResult } from "@/features/spreadsheet/lib/edits"
import { shownFormula, storedFormula } from "@/features/spreadsheet/lib/formulaRefs"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import type { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { saveLosses } from "@/features/spreadsheet/lib/xlsxVerify"
import { structureLocked } from "@/features/spreadsheet/lib/xlsxView"
import { rawEntries, xlsxSavePlan } from "@/features/spreadsheet/lib/xlsxWritable"
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

// What the proof finds when a save differed from the real one in `part` as `edit` changes it.
async function lossesIf(name: string, part: string, edit: (xml: string) => string): Promise<string[]> {
	const workbook = await fixture(name)
	const plan = xlsxSavePlan(workbook)
	const saved = (await readZip(await saveXlsx(workbook))) ?? new Map<string, Uint8Array>()
	const xml = new TextDecoder().decode(saved.get(part))

	expect(edit(xml)).not.toBe(xml)

	return (
		(await saveLosses({
			original: new Map(rawEntries(workbook)),
			saved: new Map([...saved, [part, new TextEncoder().encode(edit(xml))]]),
			sheetPaths: plan.sheets,
			dropped: plan.drop
		})) ?? []
	)
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
			"x365_calcpr.xlsx",
			"x365_namedstyles.xlsx",
			"x365_filtered.xlsx",
			"x365_cfoff.xlsx",
			"x365_breaks.xlsx"
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

	it("writes back named styles, built-in formats 41 to 44, the file's own codes and a column's quote prefix", async () => {
		const styles = (await savedParts(await proven(await fixture("x365_namedstyles.xlsx")))).get("xl/styles.xml") ?? ""

		for (const style of ["Comma", "Currency", "Percent", "Hyperlink"])
			expect(styles).toMatch(new RegExp(`<cellStyle name="${style}" xfId="[1-9]`))
		for (const id of [41, 42, 43, 44]) expect(styles).toMatch(new RegExp(`<xf numFmtId="${String(id)}"`))
		expect(styles).toContain('<numFmt numFmtId="164" formatCode="m/d/yyyy"/>')
		expect(styles).toContain('<numFmt numFmtId="165" formatCode="h:mm"/>')
		expect(styles).toMatch(/<xf numFmtId="0" fontId="\d+" fillId="0" borderId="0" applyNumberFormat="0"/)
		expect(styles).toMatch(/<xf numFmtId="49"[^>]*quotePrefix="1"/)
	})

	it("writes back a filtered list, errors Excel is told not to flag, the workbook's VBA name, and formats turning bold off", async () => {
		const filtered = await savedParts(await proven(await fixture("x365_filtered.xlsx")))

		expect(filtered.get("xl/worksheets/sheet1.xml")).toMatch(/<sheetPr filterMode="1"\/>/)
		expect(filtered.get("xl/worksheets/sheet1.xml")).toContain('<ignoredError sqref="A2:A3" numberStoredAsText="1"/>')
		expect(filtered.get("xl/workbook.xml")).toMatch(/<workbookPr codeName="ThisWorkbook"/)

		const off = (await savedParts(await proven(await fixture("x365_cfoff.xlsx")))).get("xl/styles.xml")

		expect(off).toMatch(/<dxf><font><b val="0"\/><i val="0"\/><u val="none"\/><strike val="0"\/>/)
	})

	it("proves column formats, named styles, formats turning bold off and the VBA name, not skipping them", async () => {
		const edits: [string, string, (xml: string) => string][] = [
			// A column's format read as another: the quote prefix, or accounting as currency.
			["x365_namedstyles.xlsx", "xl/styles.xml", xml => xml.replace(' quotePrefix="1"', "")],
			["x365_namedstyles.xlsx", "xl/styles.xml", xml => xml.replace('<xf numFmtId="42"', '<xf numFmtId="44"')],
			// What a named style carries.
			["x365_namedstyles.xlsx", "xl/styles.xml", xml => xml.replace(' applyNumberFormat="0"', "")],
			["x365_cfoff.xlsx", "xl/styles.xml", xml => xml.replace('<b val="0"/>', "")],
			["x365_cfoff.xlsx", "xl/styles.xml", xml => xml.replace('<u val="none"/>', "")],
			["x365_filtered.xlsx", "xl/workbook.xml", xml => xml.replace(' codeName="ThisWorkbook"', "")]
		]

		for (const [name, part, edit] of edits) {
			expect([name, (await lossesIf(name, part, edit)).length > 0]).toEqual([name, true])
		}
	})

	it("gives a new cell its row's format, else its column's, and leaves a cell the file holds as it is", async () => {
		const accounts = await proven(await fixture("x365_namedstyles.xlsx"))
		const typed = accounts.apply({
			type: "setCells",
			sheet: 0,
			cells: [
				{ row: 4, col: 0, input: "12.5" },
				{ row: 4, col: 1, input: "12" }
			]
		})

		expect(view(typed, 4, 0)?.text).not.toBe("12.5")
		expect(view(typed, 4, 1)).toMatchObject({ text: "12" })

		const bolded = accounts.apply({
			type: "format",
			sheet: 0,
			range: { startRow: 5, startCol: 0, endRow: 5, endCol: 0 },
			patch: { bold: true }
		})

		expect(bolded.type).toBe("cells")

		const parts = await savedParts(accounts)
		const sheet = parts.get("xl/worksheets/sheet1.xml") ?? ""
		const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(parts.get("xl/styles.xml") ?? "")?.[1]?.match(/<xf [^>]*>/g) ?? []
		const format = (ref: string) => xfs[Number(new RegExp(`<c r="${ref}"[^>]* s="(\\d+)"`).exec(sheet)?.[1] ?? -1)] ?? ""

		expect(format("A5")).toMatch(/numFmtId="42"/)
		expect(format("B5")).toMatch(/numFmtId="49"[^>]*quotePrefix="1"/)
		expect(format("A6")).toMatch(/numFmtId="42"[^>]*fontId="[1-9]/)

		const rows = await proven(await fixture("x365_emptyrows.xlsx"))

		rows.apply({ type: "setCells", sheet: 0, cells: [{ row: 6, col: 3, input: "5" }] })
		expect((await savedParts(rows)).get("xl/worksheets/sheet1.xml")).toMatch(/<c r="D7" s="[1-9]/)

		// A1 is in the file without a format of its own: it stays without one.
		const columns = await proven(await fixture("x365_colstyle.xlsx"))

		columns.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "Renamed" }] })
		expect((await savedParts(columns)).get("xl/worksheets/sheet1.xml")).not.toMatch(/<c r="A1"[^>]* s="/)
	})

	it("moves manual page breaks with their rows and columns, drops one whose row goes, and puts them back on undo", async () => {
		const document = await proven(await fixture("x365_breaks.xlsx"))
		const breaks = async () => {
			const sheet = (await savedParts(document)).get("xl/worksheets/sheet1.xml") ?? ""

			return [
				/<rowBreaks[\s\S]*?<\/rowBreaks>/.exec(sheet)?.[0].match(/id="\d+"/g),
				/<colBreaks[\s\S]*?<\/colBreaks>/.exec(sheet)?.[0].match(/id="\d+"/g)
			]
		}

		expect(await breaks()).toEqual([['id="5"'], ['id="2"']])

		document.apply({ type: "insert", sheet: 0, axis: "rows", at: 2, count: 2 })
		document.apply({ type: "insert", sheet: 0, axis: "cols", at: 0, count: 1 })
		expect(await breaks()).toEqual([['id="7"'], ['id="3"']])

		document.apply({ type: "delete", sheet: 0, axis: "rows", at: 7, count: 1 })
		expect(await breaks()).toEqual([undefined, ['id="3"']])

		document.undo()
		document.undo()
		document.undo()
		expect(await breaks()).toEqual([['id="5"'], ['id="2"']])
	})

	it("locks rows and columns on a sheet with errors told not to flag, which are kept by range", async () => {
		const sheet = (await fixture("x365_filtered.xlsx")).sheets[0]

		expect(sheet).toBeDefined()

		if (sheet !== undefined) {
			delete sheet.autoFilter
			expect(structureLocked(sheet)).toBe(true)
			delete sheet.ignoredErrors
			expect(structureLocked(sheet)).toBe(false)
		}
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

		// The names LET and LAMBDA bind, where declared and used, never twice; a sheet's own name stays.
		expect(storedFormula("LET(x,1,y,x*2,SUM(x,y,Sheet1!x))")).toBe(
			"_xlfn.LET(_xlpm.x,1,_xlpm.y,_xlpm.x*2,SUM(_xlpm.x,_xlpm.y,Sheet1!x))"
		)
		expect(storedFormula("LET(f,LAMBDA(v,v+1),f(2))")).toBe("_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.v,_xlpm.v+1),_xlpm.f(2))")
		expect(storedFormula("_xlfn.LET(_xlpm.x,1,_xlpm.x)")).toBe("_xlfn.LET(_xlpm.x,1,_xlpm.x)")
		expect(storedFormula('LET(x,"x",x&y)')).toBe('_xlfn.LET(_xlpm.x,"x",_xlpm.x&y)')
		expect(shownFormula("_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.v,_xlpm.v+1),_xlpm.f(2))")).toBe("LET(f,LAMBDA(v,v+1),f(2))")

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
