import { describe, expect, it } from "vitest"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetSessionApi } from "../core/sheet/protocol"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// Column A: 1..3 filled, 4 blank, 6..7 filled. Row 1: A..C filled, E filled.
const ROWS = [["a", "b", "c", null, "e"], ["x"], ["x"], [], [], ["x"], ["x"]]

async function to(
	session: SheetSessionApi,
	row: number,
	col: number,
	direction: "up" | "down" | "left" | "right"
): Promise<[number, number]> {
	const at = await session.query("navigate", { sheet: 0, row, col, direction, to: "dataEdge" })

	return [at.row, at.col]
}

describe("Ctrl+arrow", () => {
	it("goes to the end of the run of filled cells it is in, then to the next filled cell, then to the sheet's edge", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(ROWS) }] })

		expect(await to(session, 0, 0, "down")).toEqual([2, 0])
		expect(await to(session, 2, 0, "down")).toEqual([5, 0])
		expect(await to(session, 5, 0, "down")).toEqual([6, 0])
		expect(await to(session, 6, 0, "down")).toEqual([SHEET_MAX_ROWS - 1, 0])
		expect(await to(session, SHEET_MAX_ROWS - 1, 0, "up")).toEqual([6, 0])
		expect(await to(session, 6, 0, "up")).toEqual([5, 0])
		expect(await to(session, 5, 0, "up")).toEqual([2, 0])
		expect(await to(session, 2, 0, "up")).toEqual([0, 0])
		expect(await to(session, 0, 0, "up")).toEqual([0, 0])
	})

	it("starts from a blank cell to the next filled one", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(ROWS) }] })

		expect(await to(session, 3, 0, "down")).toEqual([5, 0])
		expect(await to(session, 3, 0, "up")).toEqual([2, 0])
		// Nothing above in column D: to the sheet's first row.
		expect(await to(session, 10, 3, "up")).toEqual([0, 3])
	})

	it("works along a row", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(ROWS) }] })

		expect(await to(session, 0, 0, "right")).toEqual([0, 2])
		expect(await to(session, 0, 2, "right")).toEqual([0, 4])
		expect(await to(session, 0, 4, "right")).toEqual([0, SHEET_MAX_COLS - 1])
		expect(await to(session, 0, 4, "left")).toEqual([0, 2])
		expect(await to(session, 0, 2, "left")).toEqual([0, 0])
	})

	it("passes over hidden rows", async () => {
		const body = sheetBody(ROWS).replace('<row r="6">', '<row r="6" hidden="1">')
		const { session } = await openKeys({ sheets: [{ name: "One", body }] })

		expect(await to(session, 2, 0, "down")).toEqual([6, 0])
		expect(await to(session, 6, 0, "up")).toEqual([2, 0])
	})

	it("passes over hidden columns", async () => {
		const body = `<cols><col min="3" max="3" width="9" hidden="1"/></cols>${sheetBody(ROWS)}`
		const { session } = await openKeys({ sheets: [{ name: "One", body }] })

		// C is hidden: the run A..B ends at B; from B the next shown filled cell is E.
		expect(await to(session, 0, 0, "right")).toEqual([0, 1])
		expect(await to(session, 0, 1, "right")).toEqual([0, 4])
	})

	it("treats a cell holding only a format as blank, and a formula as filled", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2" s="1"/></row><row r="3"><c r="A3"><f>1+1</f><v>2</v></c></row></sheetData>'
		const { session } = await openKeys({ sheets: [{ name: "One", body }] })

		expect(await to(session, 0, 0, "down")).toEqual([2, 0])
	})

	it("works on a text file", async () => {
		const { session } = await openKeys("a,b,,d\nx\nx\n\nx\n")

		expect(await to(session, 0, 0, "down")).toEqual([2, 0])
		expect(await to(session, 2, 0, "down")).toEqual([4, 0])
		expect(await to(session, 4, 0, "down")).toEqual([SHEET_MAX_ROWS - 1, 0])
		expect(await to(session, 0, 0, "right")).toEqual([0, 1])
		expect(await to(session, 0, 1, "right")).toEqual([0, 3])
		expect(await to(session, 9, 0, "up")).toEqual([4, 0])
	})
})

describe("the data region", () => {
	it("grows round a cell while a filled cell borders it, diagonals included", async () => {
		const rows = [
			["a", "b", null, null],
			[null, "c", null, null],
			[null, null, "d", null],
			[null, null, null, null],
			["far", null, null, null]
		]
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(rows) }] })

		expect(await session.query("dataRegion", { sheet: 0, row: 0, col: 0 })).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 })
		expect(await session.query("dataRegion", { sheet: 0, row: 4, col: 0 })).toEqual({ startRow: 4, startCol: 0, endRow: 4, endCol: 0 })
		// A blank cell beside data takes that data's region, and whatever touches the region it grows to (A5 touches B4).
		expect(await session.query("dataRegion", { sheet: 0, row: 3, col: 3 })).toEqual({ startRow: 0, startCol: 0, endRow: 4, endCol: 3 })
		// A blank cell with nothing round it is its own region.
		expect(await session.query("dataRegion", { sheet: 0, row: 20, col: 20 })).toEqual({
			startRow: 20,
			startCol: 20,
			endRow: 20,
			endCol: 20
		})
	})

	it("works on a text file", async () => {
		const { session } = await openKeys("a,b\nc,d\n\nfar\n")

		expect(await session.query("dataRegion", { sheet: 0, row: 1, col: 1 })).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 })
	})
})
