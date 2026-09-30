import { describe, expect, it } from "vitest"
import { formula, openFixture, openSheets, proven, savedWorkbook, shownCell, viewCell } from "@/tests/spreadsheetProven"
import { rawEntries } from "@/features/spreadsheet/lib/xlsxWritable"

describe("XlsxDocument, what saving cannot move", () => {
	it("locks rows around array formulas and refuses edits to part of one", async () => {
		const document = await proven(await openFixture("array.xlsx"))

		expect(document.doc().sheets[0]?.structureLocked).toBe(true)
		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 0, count: 1 })).toMatchObject({ reason: "structureLocked" })
		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 2, input: "5" }] })).toMatchObject({
			reason: "arrayFormula"
		})
		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 2, input: "5" }] })).toMatchObject({
			reason: "arrayFormula"
		})

		const whole = document.apply({
			type: "setCells",
			sheet: 0,
			cells: [0, 1, 2].map(row => ({ row, col: 2, input: String(row) }))
		})

		expect(whole.type).toBe("cells")
	})

	it("locks rows on a sheet with threaded comments, and saves it", async () => {
		const document = await proven(await openFixture("threaded.xlsx"))

		expect(document.writable).toBe(true)
		expect(document.doc().sheets[0]?.structureLocked).toBe(true)
		expect(document.apply({ type: "insert", sheet: 0, axis: "rows", at: 0, count: 2 })).toMatchObject({ reason: "structureLocked" })

		const reopened = await savedWorkbook(document)

		expect(reopened.sheets[0]?.threadedComments?.[0]?.ref).toBe("B1")
	})

	it("opens view-only what saving would drop: shapes, form controls, iterative calculation", async () => {
		expect((await proven(await openFixture("shape.xlsx"))).writable).toBe(false)
		expect((await proven(await openFixture("ctrl.xlsx"))).writable).toBe(false)
		expect((await proven(await openFixture("calc.xlsx"))).writable).toBe(false)
	})

	it("keeps column formats within the sheet when columns are inserted, and restores them on undo", async () => {
		const document = await proven(await openFixture("hidecols.xlsx"))

		document.apply({ type: "insert", sheet: 0, axis: "cols", at: 1, count: 2 })

		expect((await savedWorkbook(document)).sheets[0]?.columns?.length).toBeLessThanOrEqual(16_384)

		document.undo()

		const restored = await savedWorkbook(document)

		expect(restored.sheets[0]?.columns?.length).toBe(16_384)
		expect(restored.sheets[0]?.columns?.[16_383]?.hidden).toBe(true)
	})

	it("refuses to rename a table column by editing its header, and allows the rest", async () => {
		const document = await proven(await openFixture("table.xlsx"))

		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "Quantity" }] })).toMatchObject({
			reason: "tableHeader"
		})
		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "" }] })).toMatchObject({
			reason: "tableHeader"
		})
		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "Qty" }] }).type).toBe("cells")
		expect(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 1, input: "7" }] }).type).toBe("cells")
	})
})

describe("XlsxDocument, LibreOffice files", () => {
	it("saves a LibreOffice workbook, adding the theme it lacks and dropping its empty custom properties", async () => {
		for (const name of ["lo-plain.xlsx", "lo-array.xlsx"]) {
			const document = await proven(await openFixture(name))

			expect(document.writable).toBe(true)

			document.apply({ type: "setCells", sheet: 0, cells: [{ row: 2, col: 1, input: "400" }] })

			const raw = rawEntries(await savedWorkbook(document))

			expect(raw?.has("xl/theme/theme1.xml")).toBe(true)
			expect(raw?.has("docProps/custom.xml")).toBe(false)
		}

		expect(shownCell(await proven(await savedWorkbook(await proven(await openFixture("lo-plain.xlsx")))), 3, 1)).toMatchObject({
			text: "1500"
		})
	})

	it("opens view-only a workbook whose custom properties hold something", async () => {
		const workbook = await openFixture("lo-array.xlsx")
		const raw = rawEntries(workbook)

		raw?.set(
			"docProps/custom.xml",
			new TextEncoder().encode(
				'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"><property name="Label" pid="2" fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"/></Properties>'
			)
		)

		expect((await proven(workbook)).writable).toBe(false)
	})
})

describe("XlsxDocument engine edges", () => {
	it("reads sheet names the engine only takes quoted", async () => {
		const document = await openSheets([
			{ name: "数据", rows: [[5]] },
			{ name: "Q1.2024", rows: [[1]] },
			{
				name: "Calc",
				rows: [[10, 1]],
				cells: new Map([
					["0,0", formula("数据!A1*2", 10)],
					["0,1", formula("Q1.2024!A1", 1)]
				])
			}
		])

		expect(viewCell(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "21" }] }), 0, 0, 2)).toMatchObject({
			text: "42"
		})
		expect(viewCell(document.apply({ type: "setCells", sheet: 1, cells: [{ row: 0, col: 0, input: "3" }] }), 0, 1, 2)).toMatchObject({
			text: "3"
		})
	})

	it("keeps the results a circular reference stored", async () => {
		const document = await openSheets([
			{
				name: "S",
				rows: [[100, 105.26, 52.63]],
				cells: new Map([
					["0,1", formula("A1+C1*0.1", 105.26)],
					["0,2", formula("B1*0.5", 52.63)]
				])
			}
		])

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "200" }] })

		expect(shownCell(document, 0, 1)).toMatchObject({ text: "105.26" })
		expect(viewCell(document.apply({ type: "setCells", sheet: 0, cells: [{ row: 1, col: 0, input: "=A2+1" }] }), 1, 0)).toMatchObject({
			text: "0"
		})
	})

	it("formats the whole range asked for, past the used area", async () => {
		const document = await openSheets([{ name: "S", rows: [[1, 2]] }])
		const result = document.apply({
			type: "format",
			sheet: 0,
			range: { startRow: 3, startCol: 0, endRow: 5, endCol: 2 },
			patch: { bold: true }
		})

		expect(result.type === "cells" ? result.patches[0]?.cells.length : 0).toBe(9)
	})

	it("takes a formula too deeply nested for the engine without throwing, and opens a file holding one", async () => {
		const deep = `${"(".repeat(300)}1${")".repeat(300)}`
		const document = await openSheets([{ name: "S", rows: [[1]], cells: new Map([["0,0", formula("1", 1)]]) }])
		const result = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: `=${deep}` }] })

		expect(viewCell(result, 0, 1)).toMatchObject({ text: "#ERROR!" })
		expect(document.undo().state.canUndo).toBe(false)

		const stored = await openSheets([{ name: "S", rows: [[null]], cells: new Map([["0,0", formula(deep)]]) }])

		expect(shownCell(stored, 0, 0)).toMatchObject({ input: `=${deep}` })
	})

	it("sends only the sheets a structural edit changed", async () => {
		const document = await openSheets([
			{ name: "Big", rows: [[1, 2]] },
			{ name: "Small", rows: [[1]] }
		])
		const renamed = document.apply({ type: "renameSheet", sheet: 1, name: "Tiny" })
		const added = document.apply({ type: "addSheet", name: "New" })

		// A rename changes only a name, which travels without the sheet's view.
		expect(renamed).toMatchObject({ sheets: [null, null], names: ["Big", "Tiny"], patches: [] })
		expect(added).toMatchObject({ names: ["Big", "Tiny", "New"], patches: [] })
		expect(added.type === "sheets" ? added.sheets.map(sheet => sheet?.name ?? null) : null).toEqual([null, null, "New"])
	})

	it("recalculates formulas that named a sheet's new name, and back on undo", async () => {
		const document = await openSheets([
			{ name: "S", rows: [[5, "#REF!"]], cells: new Map([["0,1", formula("Summary!A1*2", "#REF!")]]) },
			{ name: "T", rows: [[7]] }
		])
		const renamed = document.apply({ type: "renameSheet", sheet: 1, name: "Summary" })

		expect(viewCell(renamed, 0, 1)).toMatchObject({ text: "14" })
		expect(viewCell(document.apply({ type: "setCells", sheet: 1, cells: [{ row: 0, col: 0, input: "8" }] }), 0, 1)).toMatchObject({
			text: "16"
		})

		document.undo()
		document.undo()

		expect(shownCell(document, 0, 1)).toMatchObject({ text: "#REF!" })

		const edited = document.apply({ type: "setCells", sheet: 1, cells: [{ row: 0, col: 0, input: "9" }] })

		expect(viewCell(edited, 0, 1)).toBeUndefined()
		expect(shownCell(document, 0, 1)).toMatchObject({ text: "#REF!" })
	})
})
