import { describe, expect, it } from "vitest"
import { entryCells, fillPlan } from "../core/sheet/fill/fill"
import {
	CellFlag,
	SHEET_MAX_COLS,
	SHEET_MAX_EDIT_CELLS,
	SHEET_MAX_ROWS,
	type SheetCommandResult,
	type SheetSessionApi
} from "../core/sheet/protocol"
import { createGridAxis } from "../react/sheet/axis"
import { fillDownTo, fillHandleShown, fillLeft, fillTarget } from "../react/sheet/fill"
import { firstTile, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

function fill(
	session: SheetSessionApi,
	range: { startRow: number; startCol: number; endRow: number; endCol: number },
	direction: "down" | "right" | "up" | "left"
): Promise<SheetCommandResult> {
	return session.command({ type: "fill.copy", sheet: 0, ranges: [range], direction })
}

async function cell(
	session: SheetSessionApi,
	row: number,
	col: number
): Promise<{ text: string; input: string | null; flags: number; style: number } | null> {
	return tileEntry(await firstTile(session, 0), row, col)
}

// A1 5, B1 the text "007" (Text format would keep it so; here it is a string in General), C1 =A1*2, D1 a date.
const BODY =
	'<sheetData><row r="1"><c r="A1"><v>5</v></c><c r="B1" t="inlineStr"><is><t>007</t></is></c>' +
	'<c r="C1"><f>A1*2</f><v>10</v></c><c r="D1" s="1"><v>45000</v></c></row></sheetData>'

describe("the fill plan", () => {
	it("copies the first row down a range, and takes the row above for a one-row range", () => {
		const plan = fillPlan([{ startRow: 2, startCol: 0, endRow: 2, endCol: 1 }], "down")

		expect(plan).not.toBe("tooLarge")
		expect(plan === null || plan === "tooLarge" ? null : [Array.from(plan.rows), Array.from(plan.sourceRows)]).toEqual([
			[2, 2],
			[1, 1]
		])
	})

	it("writes nothing for a one-row range at the top", () => {
		expect(fillPlan([{ startRow: 0, startCol: 0, endRow: 0, endCol: 3 }], "down")).toBeNull()
	})

	it("refuses more cells than one edit takes", () => {
		expect(fillPlan([{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 }], "down")).toBe("tooLarge")
	})
})

describe("fill.copy", () => {
	it("copies values exactly, formats, and formulas moved by each row", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: BODY }] })
		const result = await fill(session, { startRow: 0, startCol: 0, endRow: 2, endCol: 3 }, "down")

		expect(result.ok).toBe(true)

		const a3 = await cell(session, 2, 0)
		const b3 = await cell(session, 2, 1)
		const c3 = await cell(session, 2, 2)
		const d3 = await cell(session, 2, 3)
		const d1 = await cell(session, 0, 3)

		expect(a3?.text).toBe("5")
		// Still text: a typed "007" would have become the number 7.
		expect(b3?.text).toBe("007")
		expect((b3?.flags ?? 0) & CellFlag.NUMBER).toBe(0)
		expect(c3?.input).toBe("=A3*2")
		expect(c3?.text).toBe("10")
		expect(d3?.text).toBe(d1?.text)
		expect(d3?.style).toBe(d1?.style)
	})

	it("fills right from the first column", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody([[1, null, null], [{ f: "A2+1", v: 1 }]]) }] })

		await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, "right")

		expect((await cell(session, 0, 2))?.text).toBe("1")
		expect((await cell(session, 1, 2))?.input).toBe("=C2+1")
	})

	it("fills up and left from the last row and column", async () => {
		const { session } = await openKeys({
			sheets: [
				{
					name: "One",
					body: sheetBody([
						[null, null],
						[null, "z"]
					])
				}
			]
		})

		await fill(session, { startRow: 0, startCol: 1, endRow: 1, endCol: 1 }, "up")
		expect((await cell(session, 0, 1))?.text).toBe("z")

		await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, "left")
		expect((await cell(session, 0, 0))?.text).toBe("z")
		expect((await cell(session, 1, 0))?.text).toBe("z")
	})

	it("is one step: undo takes the cells back", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: BODY }] })

		await fill(session, { startRow: 0, startCol: 0, endRow: 3, endCol: 3 }, "down")
		await session.undo()

		expect(await cell(session, 1, 0)).toBeNull()
		expect(await cell(session, 3, 2)).toBeNull()

		await session.redo()

		expect((await cell(session, 3, 2))?.input).toBe("=A4*2")
	})

	it("saves what it filled", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: BODY }] })

		await fill(session, { startRow: 0, startCol: 0, endRow: 2, endCol: 3 }, "down")

		const reopened = await openKeys(await savedBytes(session))

		expect((await cell(reopened.session, 2, 1))?.text).toBe("007")
		expect((await cell(reopened.session, 2, 2))?.input).toBe("=A3*2")
	})

	it("empties a target whose source is empty", async () => {
		const { session } = await openKeys({
			sheets: [
				{
					name: "One",
					body: sheetBody([
						[null, 1],
						["x", 2]
					])
				}
			]
		})

		await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, "down")

		expect(await cell(session, 1, 0)).toBeNull()
		expect((await cell(session, 1, 1))?.text).toBe("1")
	})

	it("refuses where merged cells are in the way", async () => {
		const { session } = await openKeys({
			sheets: [
				{
					name: "One",
					body: `${sheetBody([
						[1, 2],
						[3, 4]
					])}<mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells>`
				}
			]
		})
		const result = await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, "down")

		expect(!result.ok && result.refusal.reason).toBe("merged")
	})

	it("refuses over locked cells of a protected sheet", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: `${sheetBody([[1], [2]])}<sheetProtection sheet="1"/>` }] })
		const result = await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, "down")

		expect(!result.ok && result.refusal.reason).toBe("protectedSheet")
	})

	it("refuses to copy an array formula", async () => {
		const body = '<sheetData><row r="1"><c r="A1"><f t="array" ref="A1">1+1</f><v>2</v></c></row></sheetData>'
		const { session } = await openKeys({ sheets: [{ name: "One", body }] })
		const result = await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, "down")

		expect(!result.ok && result.refusal.reason).toBe("arrayFormula")
	})

	it("fills a text file's cells with their text", async () => {
		const { session } = await openKeys("a,=b\nx,y\n")

		await fill(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, "down")

		const tile = await firstTile(session, 0)

		expect(tileEntry(tile, 1, 0)?.text).toBe("a")
		expect(tileEntry(tile, 1, 1)?.text).toBe("=b")

		await session.undo()

		expect(tileEntry(await firstTile(session, 0), 1, 0)?.text).toBe("x")
	})
})

describe("fill.entry (Ctrl+Enter)", () => {
	it("puts the entry in every selected cell but those a merge covers, a formula's references moved from the active cell", async () => {
		const { session } = await openKeys({
			sheets: [{ name: "One", body: `${sheetBody([[1, 2, 3]])}<mergeCells count="1"><mergeCell ref="B2:C3"/></mergeCells>` }]
		})
		const result = await session.command({
			type: "fill.entry",
			sheet: 0,
			ranges: [{ startRow: 1, startCol: 0, endRow: 2, endCol: 2 }],
			entry: "=A1*2",
			from: { row: 1, col: 0 }
		})

		expect(result.ok).toBe(true)
		expect((await cell(session, 1, 0))?.input).toBe("=A1*2")
		expect((await cell(session, 1, 1))?.input).toBe("=B1*2")
		expect((await cell(session, 2, 0))?.input).toBe("=A2*2")
		// C2, B3 and C3 lie under B2's merge.
		expect(await cell(session, 1, 2)).toBeNull()
		expect(await cell(session, 2, 1)).toBeNull()

		await session.undo()

		expect(await cell(session, 1, 0)).toBeNull()
	})

	it("fills a text file's cells with the entry", async () => {
		const { session } = await openKeys("a,b\nx,y\n")

		await session.command({
			type: "fill.entry",
			sheet: 0,
			ranges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 0 }],
			entry: "z",
			from: { row: 0, col: 0 }
		})

		const tile = await firstTile(session, 0)

		expect([tileEntry(tile, 0, 0)?.text, tileEntry(tile, 1, 0)?.text, tileEntry(tile, 1, 1)?.text]).toEqual(["z", "z", "y"])
	})

	it("refuses more cells than one edit takes before listing any", () => {
		const column = [{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 }]
		const merges = Uint32Array.of(0, 0, SHEET_MAX_ROWS - 1, SHEET_MAX_COLS - 1)

		expect(entryCells(column, new Uint32Array(0), "=A1", { row: 0, col: 0 })).toBe("tooLarge")
		// Cells a merge covers do not count: the whole sheet merged is one cell.
		const whole = entryCells([{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }], merges, "x", {
			row: 0,
			col: 0
		})

		expect(whole !== null && whole !== "tooLarge" && Array.from(whole.rows)).toEqual([0])
		// Exactly as many as one edit takes is not too many.
		const most = entryCells([{ startRow: 0, startCol: 0, endRow: SHEET_MAX_EDIT_CELLS - 1, endCol: 0 }], new Uint32Array(0), "x", {
			row: 0,
			col: 0
		})

		expect(most !== null && most !== "tooLarge" && most.rows.length).toBe(SHEET_MAX_EDIT_CELLS)
	})
})

describe("the fill handle", () => {
	const range = (startRow: number, startCol: number, endRow: number, endCol: number) => ({ startRow, startCol, endRow, endCol })

	it("shows for one range that is neither whole rows nor whole columns", () => {
		expect(fillHandleShown([range(1, 1, 3, 2)])).toEqual(range(1, 1, 3, 2))
		expect(fillHandleShown([range(0, 0, 0, 0), range(2, 2, 2, 2)])).toBeNull()
		expect(fillHandleShown([])).toBeNull()
		expect(fillHandleShown([range(0, 2, SHEET_MAX_ROWS - 1, 2)])).toBeNull()
		expect(fillHandleShown([range(4, 0, 4, SHEET_MAX_COLS - 1)])).toBeNull()
		// Down to the last row but not from the first is not a whole column.
		expect(fillHandleShown([range(1, 2, SHEET_MAX_ROWS - 1, 2)])).toEqual(range(1, 2, SHEET_MAX_ROWS - 1, 2))
	})

	it("fills the way the pointer went furthest past the source", () => {
		const source = range(2, 2, 3, 3)

		expect(fillTarget(source, { row: 9, col: 5 })).toEqual(range(2, 2, 9, 3))
		expect(fillTarget(source, { row: 4, col: 8 })).toEqual(range(2, 2, 3, 8))
		expect(fillTarget(source, { row: 0, col: 2 })).toEqual(range(0, 2, 3, 3))
		expect(fillTarget(source, { row: 3, col: 0 })).toEqual(range(2, 0, 3, 3))
		// A tie goes to the rows.
		expect(fillTarget(source, { row: 5, col: 5 })).toEqual(range(2, 2, 5, 3))
	})

	it("cuts the source back to the pointer dragged inside it, and clears the cells it leaves", () => {
		const source = range(0, 0, 4, 2)
		const up = fillTarget(source, { row: 1, col: 2 })
		const leftward = fillTarget(source, { row: 4, col: 0 })

		expect(up).toEqual(range(0, 0, 1, 2))
		expect(fillLeft(source, up)).toEqual(range(2, 0, 4, 2))
		expect(leftward).toEqual(range(0, 0, 4, 0))
		expect(fillLeft(source, leftward)).toEqual(range(0, 1, 4, 2))
		expect(fillTarget(source, { row: 4, col: 2 })).toEqual(source)
		expect(fillLeft(source, source)).toBeNull()
		expect(fillLeft(source, range(0, 0, 9, 2))).toBeNull()
	})
})

describe("fill handle double-click", () => {
	async function downTo(text: string, source: { startRow: number; startCol: number; endRow: number; endCol: number }) {
		const { session, info } = await openKeys(text)
		const sheet = info.sheets[0]?.id ?? 0
		const layout = await session.layout(sheet)

		return fillDownTo(session, sheet, source, createGridAxis(layout.rows, layout.rowCount, 1))
	}

	it("fills down to the end of the run in the column to the left, not to the block after it", async () => {
		expect(await downTo("a,x\nb,\nc,\nd,\n,\ne,\nf,\n", at(0, 1))).toBe(3)
	})

	it("stops at a lone filled cell below the selection, not the next block past the blank cells under it", async () => {
		expect(await downTo("a,x\nb,\n,\n,\nc,\nd,\n", at(0, 1))).toBe(1)
	})

	it("takes the column to the right when the one to the left is empty or there is none", async () => {
		expect(await downTo("x,a\n,b\n,c\n", at(0, 0))).toBe(2)
		expect(await downTo(",x,a\n,,b\n,,c\n,,d\n", at(0, 1))).toBe(3)
	})

	it("fills nowhere when both neighbours are empty below the selection, or at the last row", async () => {
		expect(await downTo("a,x,b\n,,\nc,,d\n", at(0, 1))).toBeNull()
		expect(await downTo("a,x\n", { startRow: SHEET_MAX_ROWS - 1, startCol: 1, endRow: SHEET_MAX_ROWS - 1, endCol: 1 })).toBeNull()
	})

	function at(row: number, col: number) {
		return { startRow: row, startCol: col, endRow: row, endCol: col }
	}
})
