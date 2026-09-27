import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { openXlsx, saveXlsx, writeXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { Cell, CellValue } from "hucre"
import type { EditResult } from "@/features/spreadsheet/lib/edits"
import { FormulaEngine } from "@/features/spreadsheet/lib/formulaEngine"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { saveLosses } from "@/features/spreadsheet/lib/xlsxVerify"
import { rawEntries, xlsxSavePlan } from "@/features/spreadsheet/lib/xlsxWritable"
import { readZip } from "@/features/spreadsheet/lib/zipLimits"
import { proven } from "@/tests/spreadsheetProven"

const FIXTURES = new URL("./fixtures/spreadsheet/", import.meta.url)

async function fixture(name: string): Promise<RoundtripWorkbook> {
	return await openXlsx(readFileSync(new URL(name, FIXTURES)), { readStyles: true })
}

async function open(sheets: { name: string; rows: CellValue[][]; cells?: Map<string, Cell> }[]): Promise<XlsxDocument> {
	return await proven(await openXlsx(await writeXlsx({ sheets }), { readStyles: true }))
}

function formula(text: string, result: CellValue = null): Cell {
	return { value: result, type: "formula", formula: text, formulaResult: result }
}

function view(result: EditResult, row: number, col: number, sheet = 0): CellView | null | undefined {
	if (result.type === "cells") {
		return result.patches.find(patch => patch.sheet === sheet)?.cells.find(([key]) => key === cellKey(row, col))?.[1]
	}

	return result.type === "sheets" ? result.sheets[sheet]?.cells.get(cellKey(row, col)) : undefined
}

function shown(document: XlsxDocument, row: number, col: number, sheet = 0): CellView | undefined {
	return document.doc().sheets[sheet]?.cells.get(cellKey(row, col))
}

describe("proof that saving loses nothing", () => {
	it("skips the proof for a page that will not edit, and then refuses to save", async () => {
		const document = new XlsxDocument(await openXlsx(await writeXlsx({ sheets: [{ name: "S", rows: [[1]] }] }), { readStyles: true }))

		document.viewOnly()

		expect(await document.verifyWritable()).toBe(false)
		await expect(document.serialize()).rejects.toThrow()
	})

	it("opens view-only until proven, and proves ordinary files from Google Sheets, LibreOffice and openpyxl", async () => {
		const workbook = await fixture("gs.xlsx")
		const document = new XlsxDocument(workbook)

		expect(document.writable).toBe(false)
		expect(await document.verifyWritable()).toBe(true)
		expect(document.writable).toBe(true)

		for (const name of ["lo-plain.xlsx", "lo-array.xlsx", "dv.xlsx", "shared.xlsx", "table.xlsx", "threaded.xlsx"]) {
			const other = await proven(await fixture(name))

			expect([name, other.losses]).toEqual([name, []])
		}
	})

	it("keeps view-only an Excel file with what saving would lose: x14 validations, picture offsets, data bars", async () => {
		const excel = await proven(await fixture("excel_full.xlsx"))

		expect(excel.writable).toBe(false)
		expect(excel.losses.some(loss => loss.includes("extLst"))).toBe(true)
		expect(excel.losses.some(loss => loss.includes("colOff"))).toBe(true)
		await expect(excel.serialize()).rejects.toThrow()

		expect((await proven(await fixture("cf.xlsx"))).writable).toBe(false)
	})

	it("finds a value, a format or an element that saving changed", async () => {
		const workbook = await fixture("shared.xlsx")
		const plan = xlsxSavePlan(workbook)
		const original = new Map(rawEntries(workbook))
		const saved = (await readZip(await saveXlsx(workbook))) ?? new Map<string, Uint8Array>()
		const sheet = new TextDecoder().decode(saved.get("xl/worksheets/sheet1.xml"))
		const losses = async (edit: (xml: string) => string) =>
			(await saveLosses({
				original,
				saved: new Map([...saved, ["xl/worksheets/sheet1.xml", new TextEncoder().encode(edit(sheet))]]),
				sheetPaths: plan.sheets,
				dropped: plan.drop
			})) ?? []

		expect((await losses(xml => xml.replace("<v>3</v>", "<v>4</v>"))).some(loss => loss.includes("cell 3,1"))).toBe(true)
		expect(
			(
				await losses(xml => xml.replace("</sheetData>", '</sheetData><mergeCells count="1"><mergeCell ref="D1:E2"/></mergeCells>'))
			).some(loss => loss.includes("added"))
		).toBe(true)
		expect(await losses(xml => xml.replace(/<pageMargins[^>]*\/>/, ""))).not.toEqual([])
	})

	it("stops a proof when its workbook closes, resolving false and letting go of the file's parts", async () => {
		const rows = Array.from({ length: 20_000 }, (_, row) => Array.from({ length: 10 }, (_, col) => row * 10 + col))
		const workbook = await openXlsx(await writeXlsx({ sheets: [{ name: "S", rows }] }), { readStyles: true })
		const document = new XlsxDocument(workbook)
		const proof = document.verifyWritable()

		document.close()

		expect(await proof).toBe(false)
		expect(document.writable).toBe(false)
		expect(rawEntries(workbook)?.size).toBe(0)
		expect(document.losses).toEqual([])

		// Closed during the comparison: abandoned there too.
		const other = await openXlsx(await writeXlsx({ sheets: [{ name: "S", rows }] }), { readStyles: true })
		const second = new XlsxDocument(other)
		const later = second.verifyWritable()

		await new Promise(resolve => setTimeout(resolve, 5))
		second.close()

		expect(await later).toBe(false)
		expect(rawEntries(other)?.size).toBe(0)
	})

	it("proves only the file as opened: an edit made first leaves it view-only", async () => {
		const document = new XlsxDocument(await fixture("gs.xlsx"))

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "x" }] })

		expect(await document.verifyWritable()).toBe(false)
	})

	it("keeps of the file only what saving copies once proven, and nothing of a view-only one", async () => {
		const writable = await fixture("lo-plain.xlsx")

		await proven(writable)

		expect(
			[...(rawEntries(writable)?.keys() ?? [])].some(path => /worksheets\/sheet\d+\.xml$|sharedStrings|styles\.xml/i.test(path))
		).toBe(false)

		const viewOnly = await fixture("excel_full.xlsx")

		await proven(viewOnly)

		expect(rawEntries(viewOnly)?.size).toBe(0)
	})

	it("reads back what the patched writer keeps: conditional format kinds, hidden names, row formats", async () => {
		const cf = await openXlsx(await saveXlsx(await fixture("cf.xlsx")))
		const rules = cf.sheets[0]?.conditionalRules ?? []

		expect(rules.find(rule => rule.type === "timePeriod")?.timePeriod).toBe("lastWeek")
		expect(rules.find(rule => rule.type === "top10")?.rank).toBe(3)
		expect(rules.find(rule => rule.type === "containsText")?.operator).toBe("containsText")

		const excel = await openXlsx(await saveXlsx(await fixture("excel_full.xlsx")))

		expect(excel.namedRanges?.find(named => named.name === "_xlnm._FilterDatabase")?.hidden).toBe(true)
	})
})

describe("XlsxDocument engine, as Excel reads ordinary formulas", () => {
	it("intersects a range where one value is expected, evaluates SUMPRODUCT over arrays, and never spills", async () => {
		const document = await open([
			{
				name: "S",
				rows: [
					[1, 10],
					[2, 20],
					[3, 30],
					[4, 40]
				]
			}
		])
		const result = document.apply({
			type: "setCells",
			sheet: 0,
			cells: [
				{ row: 1, col: 2, input: "=A1:A4*2" },
				{ row: 0, col: 3, input: "=SUMPRODUCT((A1:A4>1)*B1:B4)" },
				{ row: 0, col: 4, input: "=SEQUENCE(4)" },
				{ row: 0, col: 5, input: "=SUM(E1:E4)" }
			]
		})

		expect(view(result, 1, 2)).toMatchObject({ text: "4" })
		expect(view(result, 0, 3)).toMatchObject({ text: "90" })
		expect(view(result, 0, 4)).toMatchObject({ text: "1" })
		expect(view(result, 0, 5)).toMatchObject({ text: "1" })
		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 2, count: 1 }).type).toBe("sheets")
	})

	it("keeps the stored result of an array formula", async () => {
		const document = await proven(await fixture("lo-array.xlsx"))
		const before = shown(document, 0, 2)

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 0, input: "100" }] })

		expect(shown(document, 0, 2)).toEqual(before)
	})

	it("does not build an array too large to hold, typed or read from a file", async () => {
		const document = await open([{ name: "S", rows: [[1]] }])
		const started = performance.now()

		expect(
			view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "=SEQUENCE(1000,1000)" }] }), 0, 1)
		).toMatchObject({
			text: "#ERROR!"
		})
		expect(performance.now() - started).toBeLessThan(2000)

		const stored = await open([{ name: "S", rows: [[null]], cells: new Map([["0,0", formula("SEQUENCE(100000,100000)")]]) }])

		expect(shown(stored, 0, 0)).toMatchObject({ input: "=SEQUENCE(100000,100000)" })
	})
})

describe("XlsxDocument, structural edits all or nothing", () => {
	it("keeps the workbook and the engine together when the engine fails part-way", async () => {
		const document = await open([
			{
				name: "S",
				rows: [[1], [2], [3], [4]],
				cells: new Map([["3,0", formula("SUM(A1:A3)", 6)]])
			}
		])
		const insert = vi.spyOn(FormulaEngine.prototype, "insert").mockImplementationOnce(() => {
			throw new Error("Cannot move cell. Destination already occupied.")
		})

		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 1 }).type).toBe("sheets")
		expect(insert).toHaveBeenCalled()
		expect(shown(document, 4, 0)).toMatchObject({ input: "=SUM(A1:A4)" })
		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 0, input: "10" }] }), 4, 0)).toMatchObject({
			text: "16"
		})

		const remove = vi.spyOn(FormulaEngine.prototype, "remove").mockImplementation(() => {
			throw new Error("engine failure")
		})

		document.undo()

		const undone = document.undo()

		remove.mockRestore()

		expect(undone.state).toMatchObject({ canUndo: false, canRedo: true })
		expect(shown(document, 3, 0)).toMatchObject({ text: "6", input: "=SUM(A1:A3)" })
		expect(view(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "5" }] }), 3, 0)).toMatchObject({
			text: "10"
		})
	})

	it("shrinks a sheet back when undoing an edit that grew it", async () => {
		const document = await open([{ name: "S", rows: [[1, 2]] }])

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 9, col: 5, input: "x" }] })

		expect(document.doc().sheets[0]).toMatchObject({ rowCount: 10, colCount: 6 })

		document.undo()

		expect(document.doc().sheets[0]).toMatchObject({ rowCount: 1, colCount: 2 })
	})

	it("locks rows and columns on a sheet with a print area or print titles", async () => {
		const workbook = await fixture("printarea.xlsx")

		// Sheet A's print area lives in its page setup, not in the defined names.
		delete workbook.namedRanges
		expect(workbook.sheets[0]?.pageSetup?.printArea).toBeDefined()

		const document = await proven(workbook)

		expect(document.doc().sheets[0]?.structureLocked).toBe(true)
		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 0, count: 1 })).toMatchObject({ reason: "structureLocked" })
	})
})
