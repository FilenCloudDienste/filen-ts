import { describe, expect, it } from "vitest"
import type { SheetSummary } from "@filen/office/core/sheet"
import { linkTarget, placeName, type LinkForm } from "@/features/spreadsheet/comments/annotations.logic"

// A link to a place in the workbook names its sheet as the engine writes a sheet in a reference: quoted when the name
// reads as a cell, an R1C1 reference or a logical value.

const PLACE: LinkForm = { kind: "place", address: "", sheet: "", reference: "B3", text: "", tooltip: "" }

const sheets = (...names: string[]): SheetSummary[] =>
	names.map((name, index) => ({ id: index + 1, name, state: "visible", kind: "worksheet", ready: true }))

const range = (startRow: number, startCol: number, endRow = startRow, endCol = startCol) => ({ startRow, startCol, endRow, endCol })

describe("a link's place in the workbook", () => {
	it("names ordinary ranges as before", () => {
		const all = sheets("Data", "Bob's Data")

		expect(placeName(all, { sheet: 1, range: range(0, 0) })).toBe("Data!A1")
		expect(placeName(all, { sheet: 1, range: range(2, 1, 3, 2) })).toBe("Data!B3:C4")
		expect(placeName(all, { sheet: 1, range: range(0, 25, 9, 26) })).toBe("Data!Z1:AA10")
		expect(placeName(all, { sheet: 1, range: range(1_048_575, 16_383) })).toBe("Data!XFD1048576")
		expect(placeName(all, { sheet: 2, range: range(0, 0) })).toBe("'Bob''s Data'!A1")
		expect(placeName(all, { sheet: 9, range: range(0, 0) })).toBe("A1")
	})

	it("quotes a sheet named like an R1C1 reference or a logical value", () => {
		const all = sheets("RC", "R1C1", "TRUE", "false")

		for (const [index, name] of ["RC", "R1C1", "TRUE", "false"].entries()) {
			expect(placeName(all, { sheet: index + 1, range: range(0, 0) })).toBe(`'${name}'!A1`)
			expect(linkTarget({ ...PLACE, sheet: name })).toEqual({ ok: true, target: { location: `'${name}'!B3` } })
		}

		expect(linkTarget({ ...PLACE, sheet: "Data" })).toEqual({ ok: true, target: { location: "Data!B3" } })
	})
})
