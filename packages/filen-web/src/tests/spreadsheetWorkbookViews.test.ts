import { describe, expect, it } from "vitest"
import type { Cell, CellValue } from "hucre"
import { openXlsx, writeXlsx } from "hucre/xlsx"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { displayText } from "@/features/spreadsheet/lib/xlsxView"
import { proven } from "@/tests/spreadsheetProven"

async function workbookBytes(rows: CellValue[][], cells?: Map<string, Cell>, dateSystem?: "1904"): Promise<Uint8Array> {
	return await writeXlsx({
		sheets: [{ name: "S", rows, ...(cells === undefined ? {} : { cells }) }],
		...(dateSystem === undefined ? {} : { dateSystem })
	})
}

function shown(document: XlsxDocument, row: number, col: number): CellView | undefined {
	return document.doc().sheets[0]?.cells.get(cellKey(row, col))
}

describe("date-time and time cells", () => {
	it("start editing from their time, and keep it through an edit", async () => {
		const at = new Date(Date.UTC(2024, 2, 5, 14, 30))
		const document = await proven(
			await openXlsx(
				await workbookBytes([[at]], new Map([["0,0", { value: at, type: "date", style: { numFmt: "yyyy-mm-dd hh:mm" } }]])),
				{ readStyles: true }
			)
		)

		expect(shown(document, 0, 0)).toMatchObject({ text: "2024-03-05 14:30" })

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "2024-03-06 14:30" }] })

		expect(shown(document, 0, 0)?.text).toBe("2024-03-06 14:30")
	})

	it("show a time alone as the time, and read one typed back", async () => {
		const time = new Date(Date.UTC(1899, 11, 31, 14, 30))
		const document = await proven(
			await openXlsx(await workbookBytes([[time]], new Map([["0,0", { value: time, type: "date", style: { numFmt: "h:mm" } }]])), {
				readStyles: true
			})
		)

		// Edited as shown, not from the epoch day ("1899-12-31").
		expect(shown(document, 0, 0)).toEqual(expect.objectContaining({ text: "14:30" }))
		expect(shown(document, 0, 0)?.input).toBeUndefined()

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "9:15:30" }] })

		expect(shown(document, 0, 0)).toMatchObject({ text: "9:15", input: "09:15:30" })
	})

	it("reads a typed time into a cell with no format as a time", async () => {
		const document = await proven(await openXlsx(await workbookBytes([["x"]]), { readStyles: true }))

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "7:05" }] })

		expect(shown(document, 0, 1)).toMatchObject({ text: "7:05", input: "07:05" })
	})
})

describe("1904-date workbooks", () => {
	it("show a number under a date format from their own epoch", async () => {
		expect(displayText(40_000, "yyyy-mm-dd", true)).toBe("2013-07-07")
		expect(displayText(40_000, "yyyy-mm-dd")).toBe("2009-07-06")

		const document = await proven(await openXlsx(await workbookBytes([[40_000]], undefined, "1904"), { readStyles: true }))

		document.apply({
			type: "format",
			sheet: 0,
			range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
			patch: { numFmt: "yyyy-mm-dd" }
		})

		expect(shown(document, 0, 0)?.text).toBe("2013-07-07")
	})
})

describe("workbook memory", () => {
	it("lets go of the formula engine once the workbook is only viewed", async () => {
		const document = new XlsxDocument(
			await openXlsx(
				await workbookBytes(
					[[2, null]],
					new Map([["0,1", { value: null, type: "formula", formula: "A1*2", formulaResult: null }]])
				),
				{ readStyles: true }
			)
		)

		expect(shown(document, 0, 1)?.text).toBe("4")
		expect(Reflect.get(document, "engine")).not.toBeNull()

		document.viewOnly()

		expect(Reflect.get(document, "engine")).toBeNull()
		expect(shown(document, 0, 1)?.text).toBe("4")
	})

	it("keys the cells one format gives by that format, not by cell", async () => {
		const rows = Array.from({ length: 50 }, (_, row) => Array.from({ length: 20 }, (_, col) => row * 20 + col))
		const document = await proven(await openXlsx(await workbookBytes(rows), { readStyles: true }))
		const structuralIds = (): number =>
			(Reflect.get(Reflect.get(document, "views") as object, "structuralIds") as Map<string, number>).size
		const before = structuralIds()
		const range = { startRow: 0, startCol: 0, endRow: 49, endCol: 19 }

		document.apply({ type: "format", sheet: 0, range, patch: { bold: true } })
		document.apply({ type: "format", sheet: 0, range, patch: { bold: false } })
		document.undo()
		document.redo()

		expect(structuralIds() - before).toBeLessThanOrEqual(4)
		expect(new Set(Array.from(document.doc().sheets[0]?.cells.values() ?? [], view => view.style)).size).toBe(1)
	})
})
