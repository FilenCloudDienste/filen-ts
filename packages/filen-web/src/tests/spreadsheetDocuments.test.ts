import { describe, expect, it } from "vitest"
import { openXlsx, writeXlsx } from "hucre/xlsx"
import type { EditResult } from "@/features/spreadsheet/lib/edits"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { proven, viewCell } from "@/tests/spreadsheetProven"
import { CsvDocument } from "@/features/spreadsheet/lib/csvDocument"
import { parseCsvFile } from "@/features/spreadsheet/lib/csvView"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"

async function workbook(): Promise<XlsxDocument> {
	const bytes = await writeXlsx({
		sheets: [
			{
				name: "Budget",
				rows: [
					["Item", "Cost"],
					["Rent", 1200],
					["Food", 300],
					["Total", 1500]
				],
				cells: new Map([
					["3,1", { value: 1500, type: "formula", formula: "SUM(B2:B3)", formulaResult: 1500 }],
					["1,1", { value: 1200, type: "number", style: { numFmt: '"$"#,##0.00' } }]
				])
			},
			{
				name: "Other Sheet",
				rows: [["=Budget!B4"]],
				cells: new Map([["0,0", { value: 1500, type: "formula", formula: "Budget!B4", formulaResult: 1500 }]])
			}
		]
	})

	return await proven(await openXlsx(bytes, { readStyles: true }))
}

function cell(result: EditResult, row: number, col: number, sheet = 0): CellView | null | undefined {
	const view = result.type === "sheets" ? result.sheets[sheet] : undefined

	return view === null || view === undefined ? viewCell(result, row, col, sheet) : (view.cells.get(cellKey(row, col)) ?? null)
}

describe("XlsxDocument", () => {
	it("recalculates what an edit changes, keeping the cell's format, and undoes it", async () => {
		const document = await workbook()
		const edited = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 2, col: 1, input: "500" }] })

		// The total on this sheet and the reference on the other both moved: a patch for each sheet.
		expect(edited.type).toBe("cells")
		expect(cell(edited, 3, 1)).toMatchObject({ text: "1700", input: "=SUM(B2:B3)" })
		expect(cell(edited, 0, 0, 1)).toMatchObject({ text: "1700", input: "=Budget!B4" })
		expect(edited.state).toEqual({ dirty: true, canUndo: true, canRedo: false })

		const undone = document.undo()

		expect(cell(undone, 2, 1)).toMatchObject({ text: "300" })
		expect(cell(undone, 3, 1)).toMatchObject({ text: "1500" })
		expect(undone.state).toEqual({ dirty: false, canUndo: false, canRedo: true })

		const redone = document.redo()

		expect(cell(redone, 3, 1)).toMatchObject({ text: "1700" })
	})

	it("reads typed input: formulas, formatted numbers, text kept as text", async () => {
		const document = await workbook()
		const result = document.apply({
			type: "setCells",
			sheet: 0,
			cells: [
				{ row: 5, col: 0, input: "=B2*2" },
				{ row: 5, col: 1, input: "12%" },
				{ row: 5, col: 2, input: "'007" },
				{ row: 1, col: 1, input: "1250" }
			]
		})

		expect(cell(result, 5, 0)).toMatchObject({ text: "2500", input: "=B2*2" })
		expect(cell(result, 5, 1)).toMatchObject({ text: "12%" })
		expect(cell(result, 5, 2)).toMatchObject({ text: "007" })
		expect(cell(result, 1, 1)).toMatchObject({ text: "$1,250.00" })
	})

	it("moves formula references and merges when rows are inserted", async () => {
		const document = await workbook()
		const result = document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 1 })

		expect(result.type).toBe("sheets")
		expect(cell(result, 4, 1)).toMatchObject({ text: "1500", input: "=SUM(B3:B4)" })

		expect(cell(result, 0, 0, 1)).toMatchObject({ input: "=Budget!B5" })

		expect(cell(document.undo(), 3, 1)).toMatchObject({ input: "=SUM(B2:B3)" })
	})

	it("renames a sheet and every reference to it, refusing a taken or invalid name", async () => {
		const document = await workbook()

		expect(document.apply({ type: "renameSheet", sheet: 1, name: "budget" })).toMatchObject({ type: "refused", reason: "sheetName" })
		expect(document.apply({ type: "renameSheet", sheet: 0, name: "a/b" })).toMatchObject({ type: "refused", reason: "sheetName" })

		const renamed = document.apply({ type: "renameSheet", sheet: 0, name: "Costs 2026" })

		expect(cell(renamed, 0, 0, 1)).toMatchObject({ input: "='Costs 2026'!B4" })
	})

	it("formats a range and saves a file that opens with the edits and the formats", async () => {
		const document = await workbook()

		document.apply({
			type: "format",
			sheet: 0,
			range: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
			patch: { bold: true, fill: "#ffcc00" }
		})
		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 2, col: 1, input: "400" }] })

		const { bytes } = await document.serialize()
		const reopened = (await proven(await openXlsx(bytes, { readStyles: true }))).doc()
		const sheet = reopened.sheets[0]
		const header = sheet?.cells.get(cellKey(0, 0))

		expect(reopened.styles[header?.style ?? -1]).toMatchObject({ bold: true, fill: "#ffcc00" })
		expect(sheet?.cells.get(cellKey(3, 1))).toMatchObject({ text: "1600", input: "=SUM(B2:B3)" })
		expect(document.apply({ type: "setCells", sheet: 0, cells: [] }).state.dirty).toBe(true)
	})
})

describe("CsvDocument", () => {
	const encoder = new TextEncoder()

	it("edits, inserts, undoes and saves in the file's own format", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a;b\r\n1;2\r\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 1, input: "=A2" }] })
		document.apply({ type: "insert", sheet: 0, axis: "cols", at: 1, count: 1 })

		expect(new TextDecoder().decode(document.serialize().bytes)).toBe("a;;b\r\n1;;=A2\r\n")

		document.undo()

		expect(new TextDecoder().decode(document.serialize().bytes)).toBe("a;b\r\n1;=A2\r\n")
		expect(document.apply({ type: "addSheet", name: "x" })).toMatchObject({ type: "refused" })
	})
})

describe("XlsxDocument, as other programs write files", () => {
	it("calculates formulas stored without their results", async () => {
		const bytes = await writeXlsx({
			sheets: [
				{
					name: "Data",
					rows: [[2, 3, null]],
					cells: new Map([["0,2", { value: null, type: "formula", formula: "A1*B1" }]])
				}
			]
		})
		const document = await proven(await openXlsx(bytes, { readStyles: true }))

		expect(document.doc().sheets[0]?.cells.get(cellKey(0, 2))).toMatchObject({ text: "6", input: "=A1*B1" })
		expect(document.undo()).toMatchObject({ type: "none", state: { dirty: false, canUndo: false } })
	})

	it("keeps the grid's sheet numbering when a chart sheet comes first", async () => {
		const workbook = await openXlsx(
			await writeXlsx({
				sheets: [
					{
						name: "Data",
						rows: [[1, 2]],
						cells: new Map([["0,1", { value: 2, type: "formula", formula: "A1*2", formulaResult: 2 }]])
					}
				]
			}),
			{ readStyles: true }
		)

		workbook.sheets.unshift({ name: "Chart", rows: [], kind: "chartsheet" })
		workbook.activeSheet = 1

		const document = await proven(workbook)

		expect(document.doc().activeSheet).toBe(0)

		const edited = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "5" }] })

		expect(cell(edited, 0, 1)).toMatchObject({ text: "10" })
	})

	it("refuses an edit that would grow the sheet's rectangle past the limit", async () => {
		const document = await workbook()

		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1_000_000, col: 16_000, input: "x" }] })).toMatchObject({
			type: "refused",
			reason: "tooLarge"
		})
	})
})
