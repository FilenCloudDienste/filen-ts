import { describe, expect, it } from "vitest"
import type { Cell } from "hucre"
import { applyEditResult, gridDoc, type GridDoc, type GridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import type { EditOp, EditResult } from "@/features/spreadsheet/lib/edits"
import { cellKey } from "@/features/spreadsheet/lib/model"
import type { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { formula, openSheets } from "@/tests/spreadsheetProven"

// A structural edit sends full views only of the sheets whose layout changed; every other sheet is kept on
// the page, renamed and patched. Folded in, the page must hold exactly what fresh views of every sheet show.

function link(location: string): Cell {
	return { value: "go", type: "string", hyperlink: { target: "", location } }
}

function workbook(): Promise<XlsxDocument> {
	return openSheets([
		{
			name: "Data",
			rows: [[1], [2], [3], [4]],
			cells: new Map([["0,1", formula("Data!A1*3", 3)]])
		},
		{
			name: "Summary",
			rows: [[10, 2, 3, "#REF!", "#REF!"]],
			cells: new Map([
				["0,0", formula("SUM(Data!A1:A4)", 10)],
				["0,1", formula("Data!A2", 2)],
				["0,2", formula("Data!A3", 3)],
				["0,3", formula("Ghost!A1+1", "#REF!")],
				["0,4", formula("Later!A1+1", "#REF!")]
			])
		},
		{ name: "Links", rows: [["go"]], cells: new Map([["0,0", link("'Data'!A2")]]) },
		{ name: "Extra", rows: [[4]] }
	])
}

function comparable(sheet: GridSheet): object {
	return {
		...sheet,
		cells: [...sheet.cells.keys()].sort((a, b) => a - b).map(key => [key, sheet.cells.get(key)])
	}
}

function expectInSync(held: GridDoc, document: XlsxDocument): void {
	const fresh = gridDoc(document.doc())

	expect(held.sheets.map(comparable)).toEqual(fresh.sheets.map(comparable))
	expect(held.styles).toEqual(fresh.styles)
}

// Applies, undoes and redoes the op, folding each result into the held view and checking it after each.
function roundTrip(document: XlsxDocument, start: GridDoc, op: EditOp): GridDoc {
	let held = start
	const step = (result: EditResult): void => {
		expect(result.type).toBe("sheets")

		held = applyEditResult(held, result)
		expectInSync(held, document)
	}

	step(document.apply(op))
	step(document.undo())
	step(document.redo())

	return held
}

// Writes past each sheet's edge and undoes it: the page's extents only ever grow from a patch, so they are
// left larger than the sheets' until a result sets them again.
function growAndUndo(document: XlsxDocument, start: GridDoc, sheets: readonly number[]): GridDoc {
	let held = start

	for (const sheet of sheets) {
		held = applyEditResult(held, document.apply({ type: "setCells", sheet, cells: [{ row: 40, col: 5, input: "x" }] }))
		held = applyEditResult(held, document.undo())

		expect(held.sheets[sheet]?.rowCount).toBe(41)
	}

	return held
}

describe("XlsxDocument sheets result", () => {
	it("keeps a renamed sheet and the sheets naming it, patched, in step with fresh views", async () => {
		const document = await workbook()
		let held = gridDoc(document.doc())

		held = roundTrip(document, held, { type: "renameSheet", sheet: 0, name: "Numbers 2" })

		const renamed = document.apply({ type: "renameSheet", sheet: 3, name: "Ghost" })

		// Nothing's layout changed: every sheet is kept, the one formula reading the new name patched.
		expect(renamed).toMatchObject({ sheets: [null, null, null, null], names: ["Numbers 2", "Summary", "Links", "Ghost"] })

		held = applyEditResult(held, renamed)
		expectInSync(held, document)
		expect(held.sheets[1]?.cells.get(cellKey(0, 3))).toMatchObject({ text: "5" })

		held = applyEditResult(held, document.undo())
		expectInSync(held, document)
		held = applyEditResult(held, document.redo())
		expectInSync(held, document)
	})

	it("sends an added sheet whole and patches the formulas that already named it", async () => {
		const document = await workbook()
		const held = roundTrip(document, gridDoc(document.doc()), { type: "addSheet", name: "Later" })

		expect(held.sheets.map(sheet => sheet.name)).toEqual(["Data", "Summary", "Links", "Extra", "Later"])
		expect(held.sheets[1]?.cells.get(cellKey(0, 4))).toMatchObject({ text: "1" })
	})

	it("patches the sheets reading one whose rows or columns moved", async () => {
		const document = await workbook()
		let held = gridDoc(document.doc())

		// Cuts Summary's reference to A2.
		held = roundTrip(document, held, { type: "delete", sheet: 0, axis: "rows", at: 1, count: 1 })
		expect(held.sheets[1]?.cells.get(cellKey(0, 1))).toMatchObject({ text: "#REF!" })

		held = roundTrip(document, held, { type: "insert", sheet: 0, axis: "rows", at: 1, count: 2 })
		held = roundTrip(document, held, { type: "insert", sheet: 0, axis: "cols", at: 0, count: 1 })
		roundTrip(document, held, { type: "delete", sheet: 0, axis: "cols", at: 1, count: 1 })
	})

	it("resets the extents of the sheets an edit reaches, grown and undone before it", async () => {
		const document = await workbook()
		let held = gridDoc(document.doc())

		// Data is renamed, Summary's formulas name it and Links' hyperlink does.
		held = growAndUndo(document, held, [0, 1, 2])
		held = applyEditResult(held, document.apply({ type: "renameSheet", sheet: 0, name: "Numbers" }))
		expectInSync(held, document)

		held = growAndUndo(document, held, [0, 1, 2])
		held = applyEditResult(held, document.undo())
		expectInSync(held, document)

		held = growAndUndo(document, held, [0, 1, 2])
		held = roundTrip(document, held, { type: "insert", sheet: 0, axis: "rows", at: 1, count: 1 })

		held = growAndUndo(document, held, [0, 1, 2])
		held = applyEditResult(held, document.undo())
		expectInSync(held, document)

		// Summary's formulas already name the added sheet.
		held = growAndUndo(document, held, [1])
		held = applyEditResult(held, document.apply({ type: "addSheet", name: "Later" }))
		expectInSync(held, document)

		held = growAndUndo(document, held, [1])
		held = applyEditResult(held, document.undo())
		expectInSync(held, document)
	})
})
