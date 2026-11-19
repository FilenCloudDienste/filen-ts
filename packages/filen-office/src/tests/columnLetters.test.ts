import { describe, expect, it } from "vitest"
import { cellAddress } from "../core/ods/formula/toXlsx"
import { SHEET_MAX_COLS } from "../core/sheet/protocol"
import { columnIndex, columnName, parseCellRef } from "../core/xlsx/write/text"

describe("column letters", () => {
	it("reads column letters back to their index", () => {
		expect(["A", "Z", "AA", "XFD"].map(columnIndex)).toEqual([0, 25, 26, 16_383])
		expect(columnName(columnIndex("XFD"))).toBe("XFD")
	})

	it("reads a cell reference's column through the shared index", () => {
		expect(parseCellRef("$XFD$1")).toEqual({ row: 0, col: SHEET_MAX_COLS - 1 })
		expect(parseCellRef("aa10")).toEqual({ row: 9, col: 26 })
	})

	it("keeps an ODS address's column on the grid", () => {
		expect(cellAddress("Sheet1.XFD1")).toEqual({ row: 0, col: SHEET_MAX_COLS - 1 })
		expect(cellAddress("Sheet1.XFE1")).toBeNull()
	})
})
