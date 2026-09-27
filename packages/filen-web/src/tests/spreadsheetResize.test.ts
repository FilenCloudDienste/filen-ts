import { describe, expect, it } from "vitest"
import { openXlsx, writeXlsx } from "hucre/xlsx"
import { applyEditResult, gridDoc } from "@/features/spreadsheet/lib/cellStore.logic"
import { CsvDocument } from "@/features/spreadsheet/lib/csvDocument"
import { parseCsvFile } from "@/features/spreadsheet/lib/csvView"
import { MAX_COL_WIDTH, MAX_RESIZE_TARGETS } from "@/features/spreadsheet/lib/sizes.logic"
import type { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { proven } from "@/tests/spreadsheetProven"

async function workbook(): Promise<XlsxDocument> {
	const bytes = await writeXlsx({
		sheets: [
			{
				name: "Sheet1",
				rows: [
					["a", "b", "c"],
					["d", "e", "f"]
				],
				columns: [{ width: 20 }]
			}
		]
	})

	return await proven(await openXlsx(bytes, { readStyles: true }))
}

async function reopened(document: XlsxDocument): Promise<XlsxDocument> {
	return await proven(await openXlsx((await document.serialize()).bytes, { readStyles: true }))
}

describe("XlsxDocument resize", () => {
	it("resizes columns, answers with only their sizes, and dirties the document", async () => {
		const document = await workbook()
		const result = document.apply({
			type: "resize",
			sheet: 0,
			axis: "cols",
			sizes: [
				[1, 150],
				[2, 150]
			]
		})

		expect(result).toEqual({
			type: "sizes",
			sheet: 0,
			axis: "cols",
			sizes: [
				[1, 150],
				[2, 150]
			],
			state: { dirty: true, canUndo: true, canRedo: false }
		})
	})

	it("undoes and redoes a resize", async () => {
		const document = await workbook()
		const before = document.doc().sheets[0]?.colWidths.get(0)

		document.apply({ type: "resize", sheet: 0, axis: "cols", sizes: [[0, 300]] })

		const undone = document.undo()

		expect(undone).toMatchObject({ type: "sizes", axis: "cols", sizes: [[0, before ?? null]] })
		expect(document.redo()).toMatchObject({ type: "sizes", sizes: [[0, 300]] })
	})

	it("saves resized columns and rows, and they read back at the same pixels", async () => {
		const document = await workbook()

		document.apply({ type: "resize", sheet: 0, axis: "cols", sizes: [[2, 133]] })
		document.apply({ type: "resize", sheet: 0, axis: "rows", sizes: [[1, 61]] })

		const sheet = (await reopened(document)).doc().sheets[0]

		expect(sheet?.colWidths.get(2)).toBe(133)
		expect(sheet?.rowHeights.get(1)).toBe(61)
		// Columns it was not asked to size keep none of their own.
		expect(sheet?.colWidths.has(1)).toBe(false)
	})

	it("resets a size to the default, keeping the column's other details", async () => {
		const document = await workbook()
		const result = document.apply({ type: "resize", sheet: 0, axis: "cols", sizes: [[0, null]] })

		expect(result).toMatchObject({ type: "sizes", sizes: [[0, null]] })
		expect((await reopened(document)).doc().sheets[0]?.colWidths.has(0)).toBe(false)
	})

	it("changes nothing, and leaves the file clean, when no size would change", async () => {
		const document = await workbook()

		// Column B has no width of its own; A is already 20 characters (145 px).
		expect(
			document.apply({
				type: "resize",
				sheet: 0,
				axis: "cols",
				sizes: [
					[1, null],
					[0, 145]
				]
			})
		).toEqual({ type: "none", state: { dirty: false, canUndo: false, canRedo: false } })
	})

	it("records only the sizes that change", async () => {
		const document = await workbook()

		document.apply({
			type: "resize",
			sheet: 0,
			axis: "cols",
			sizes: [
				[1, null],
				[2, 90]
			]
		})

		expect(document.undo()).toMatchObject({ type: "sizes", sizes: [[2, null]] })
	})

	it("clamps sizes to Excel's limits", async () => {
		const document = await workbook()

		expect(document.apply({ type: "resize", sheet: 0, axis: "cols", sizes: [[0, 99_999]] })).toMatchObject({
			sizes: [[0, MAX_COL_WIDTH]]
		})
	})

	it("refuses a resize naming more than the cap", async () => {
		const document = await workbook()
		const sizes = Array.from({ length: MAX_RESIZE_TARGETS + 1 }, (_, index) => [index, 50] as const)

		expect(document.apply({ type: "resize", sheet: 0, axis: "rows", sizes })).toMatchObject({ type: "refused", reason: "tooLarge" })
	})

	it("keeps a resized column's width with it when a column is inserted before it", async () => {
		const document = await workbook()

		document.apply({ type: "resize", sheet: 0, axis: "cols", sizes: [[2, 140]] })
		document.apply({ type: "insert", sheet: 0, axis: "cols", at: 1, count: 1 })

		expect(document.doc().sheets[0]?.colWidths.get(3)).toBe(140)
	})
})

describe("applyEditResult sizes", () => {
	it("folds new sizes into the sheet's map without touching the other axis", async () => {
		const document = await workbook()
		const doc = gridDoc(document.doc())
		const next = applyEditResult(doc, {
			type: "sizes",
			sheet: 0,
			axis: "cols",
			sizes: [
				[0, null],
				[1, 90]
			],
			state: { dirty: true, canUndo: true, canRedo: false }
		})

		expect(next.sheets[0]?.colWidths.has(0)).toBe(false)
		expect(next.sheets[0]?.colWidths.get(1)).toBe(90)
		expect(next.sheets[0]?.rowHeights).toBe(doc.sheets[0]?.rowHeights)
	})
})

function csvDocument(text: string): CsvDocument {
	const { rows, format } = parseCsvFile(new TextEncoder().encode(text), false)

	return new CsvDocument(rows, format)
}

describe("CsvDocument resize", () => {
	it("has nothing to resize: sizes live beside a CSV, never in it", () => {
		expect(csvDocument("a,b\n").apply({ type: "resize", sheet: 0, axis: "cols", sizes: [[0, 80]] }).type).not.toBe("sizes")
	})
})

describe("CsvDocument structural shifts", () => {
	it("names the shift of an insert, its undo and its redo", () => {
		const document = csvDocument("a,b\nc,d\n")
		const inserted = document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 2 })

		expect(inserted).toMatchObject({ type: "sheets", shift: { axis: "rows", kind: "insert", at: 1, count: 2, revert: false } })
		expect(document.undo()).toMatchObject({ type: "sheets", shift: { axis: "rows", kind: "insert", at: 1, count: 2, revert: true } })
		expect(document.redo()).toMatchObject({ type: "sheets", shift: { kind: "insert", revert: false } })
	})

	it("names the clamped position an insert past the end actually used", () => {
		const document = csvDocument("a\n")

		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 50, count: 1 })).toMatchObject({ shift: { at: 1 } })
	})
})
