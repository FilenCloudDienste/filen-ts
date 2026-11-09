import { describe, expect, it } from "vitest"
import { planCellMove, splitsMerge, usedPart } from "../core/sheet/move/plan"
import { SHEET_MAX_COLS, type SheetChange, type SheetCommandResult, type SheetRange, type SheetSessionApi } from "../core/sheet/protocol"
import { openTextSession } from "../core/sheet/text"
import { BORDER_SLOP, cellSpot, draggable, dragKeys, dropAt, onBorder, sameDrop } from "../react/sheet/cellDrag"
import { equalBytes, parts, type Fixture } from "./xlsxWriteFixtures"
import { firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"

// Dragging the selection's border (cells.move), as Excel: a move (formulas referring to the moved cells follow them,
// the moved formulas keep what they refer to), a copy (relative references move), an insert (the cells there shift,
// a block moved along its own band closes its gap); a move over data asks first; one undo step.

function range(startRow: number, startCol: number, endRow = startRow, endCol = startCol): SheetRange {
	return { startRow, startCol, endRow, endCol }
}

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok)
		throw new Error(`refused: ${result.refusal.reason}${result.refusal.detail === undefined ? "" : ` (${result.refusal.detail})`}`)

	return result.change
}

function refusal(result: SheetCommandResult): string | null {
	return result.ok ? null : result.refusal.reason
}

// What the cell holds as typed (its text when that is its entry); undefined for no cell.
async function inputAt(session: SheetSessionApi, sheet: number, row: number, col: number): Promise<string | undefined> {
	const entry = tileEntry(await firstTile(session, sheet), row, col)

	return entry === null || (entry.input === null && entry.text === "") ? undefined : (entry.input ?? entry.text)
}

async function textAt(session: SheetSessionApi, sheet: number, row: number, col: number): Promise<string | undefined> {
	return tileEntry(await firstTile(session, sheet), row, col)?.text
}

describe("planCellMove", () => {
	it("is nothing dropped where it was, or at a gridline at or inside its own place", () => {
		expect(planCellMove(range(1, 1, 2, 2), { row: 1, col: 1 }, undefined, false)).toBeNull()
		expect(planCellMove(range(1, 0, 2, 0), { row: 2, col: 0 }, "rows", false)).toBeNull()
		expect(planCellMove(range(1, 0, 2, 0), { row: 3, col: 0 }, "rows", false)).toBeNull()
	})

	it("reorders a block along its band: insert, move, then close the gap", () => {
		// Rows 2-3 (c, d) to the gridline above row 5 (f): a b e c d f.
		expect(planCellMove(range(2, 0, 3, 0), { row: 5, col: 0 }, "rows", false)).toEqual({
			insert: range(5, 0, 6, 0),
			from: range(2, 0, 3, 0),
			to: range(5, 0, 6, 0),
			close: range(2, 0, 3, 0),
			landed: range(3, 0, 4, 0)
		})
		// Rows 4-5 to the gridline above row 1: the insert pushes them to 6-7 first.
		expect(planCellMove(range(4, 0, 5, 0), { row: 1, col: 0 }, "rows", false)).toEqual({
			insert: range(1, 0, 2, 0),
			from: range(6, 0, 7, 0),
			to: range(1, 0, 2, 0),
			close: range(6, 0, 7, 0),
			landed: range(1, 0, 2, 0)
		})
	})

	it("closes no gap for a copy or another band, and refuses an insert splitting the block or off the sheet", () => {
		expect(planCellMove(range(0, 0, 1, 0), { row: 4, col: 2 }, "rows", false)).toMatchObject({ close: null, landed: range(4, 2, 5, 2) })
		expect(planCellMove(range(0, 0, 1, 0), { row: 4, col: 0 }, "rows", true)).toMatchObject({ close: null })
		expect(planCellMove(range(5, 0, 6, 1), { row: 1, col: 1 }, "rows", false)).toEqual({ reason: "tooLarge", detail: "split" })
		expect(planCellMove(range(0, 0, 0, 1), { row: 0, col: SHEET_MAX_COLS - 1 }, undefined, false)).toEqual({ reason: "tooLarge" })
	})

	it("finds a merge cut by a range, and cuts whole rows back to the used columns", () => {
		const merges = Uint32Array.of(0, 0, 1, 1)

		expect(splitsMerge(merges, range(0, 0, 0, 3))).toBe(true)
		expect(splitsMerge(merges, range(0, 0, 3, 3))).toBe(false)
		expect(usedPart(range(2, 0, 3, SHEET_MAX_COLS - 1), 10, 4)).toEqual(range(2, 0, 3, 3))
		expect(usedPart(range(2, 0, 3, SHEET_MAX_COLS - 1), 10, 0)).toBeNull()
	})
})

const LINKED: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>A1*2</f><v>10</v></c><c r="D1"><f>A1+1</f><v>6</v></c></row>' +
				'<row r="2"><c r="A2"><v>3</v></c></row><row r="4"><c r="C4"><v>9</v></c></row></sheetData>'
		}
	]
}

async function opened(fixture: Fixture = LINKED) {
	const result = await openFixture(fixture)

	return { ...result, sheet: result.info.sheets[0]!.id }
}

describe("cells.move in a workbook", () => {
	it("moves cells: what refers to them follows, the moved formula keeps its reference, undo is one step", async () => {
		const { session, sheet, bytes } = await opened()
		const change = changeOf(
			await session.command({ type: "cells.move", sheet, range: range(0, 0, 0, 1), to: { row: 5, col: 0 }, copy: false })
		)

		expect(await inputAt(session, sheet, 5, 0)).toBe("5")
		// The moved formula referred to a moved cell: it follows it.
		expect(await inputAt(session, sheet, 5, 1)).toBe("=A6*2")
		expect(await inputAt(session, sheet, 0, 3)).toBe("=A6+1")
		expect(await inputAt(session, sheet, 0, 0)).toBeUndefined()
		expect(change.selection).toEqual({ sheet, activeRow: 5, activeCol: 0, ranges: [range(5, 0, 5, 1)] })
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("keeps the moved formula's reference to a cell it did not move", async () => {
		const { session, sheet } = await opened()

		changeOf(await session.command({ type: "cells.move", sheet, range: range(0, 1), to: { row: 6, col: 4 }, copy: false }))
		expect(await inputAt(session, sheet, 6, 4)).toBe("=A1*2")
		expect(await textAt(session, sheet, 6, 4)).toBe("10")
		session.close()
	})

	it("copies cells, moving relative references, and leaves the source and the clipboard's copy alone", async () => {
		const { session, sheet } = await opened()
		const copy = await session.query("copy", { sheet, range: range(1, 0), cut: false })

		if (!("clip" in copy)) throw new Error("copy refused")

		changeOf(await session.command({ type: "cells.move", sheet, range: range(0, 1), to: { row: 2, col: 1 }, copy: true }))
		expect(await inputAt(session, sheet, 2, 1)).toBe("=A3*2")
		expect(await inputAt(session, sheet, 0, 1)).toBe("=A1*2")
		// The clipboard's copy still pastes as itself.
		changeOf(await session.command({ type: "clipboard.paste", sheet, at: { row: 9, col: 9 }, text: copy.text, clip: copy.clip }))
		expect(await inputAt(session, sheet, 9, 9)).toBe("3")
		session.close()
	})

	it("refuses a move over data until it is told to replace it; a copy replaces without asking", async () => {
		const { session, sheet } = await opened()
		const command = { type: "cells.move", sheet, range: range(0, 0), to: { row: 3, col: 2 }, copy: false } as const

		expect(refusal(await session.command(command))).toBe("occupied")
		expect(await inputAt(session, sheet, 3, 2)).toBe("9")
		changeOf(await session.command({ ...command, replace: true }))
		expect(await inputAt(session, sheet, 3, 2)).toBe("5")
		changeOf(await session.command({ type: "cells.move", sheet, range: range(1, 0), to: { row: 3, col: 2 }, copy: true }))
		expect(await inputAt(session, sheet, 3, 2)).toBe("3")
		session.close()
	})

	it("does not ask about the moved cells' own place", async () => {
		const { session, sheet } = await opened()

		changeOf(await session.command({ type: "cells.move", sheet, range: range(0, 0, 1, 0), to: { row: 1, col: 0 }, copy: false }))
		expect(await inputAt(session, sheet, 1, 0)).toBe("5")
		expect(await inputAt(session, sheet, 2, 0)).toBe("3")
		session.close()
	})

	it("inserts the moved cells, shifting the cells there down, and reorders a column closing the gap", async () => {
		const { session, sheet, bytes } = await opened({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>' +
						'<row r="3"><c r="A3"><v>3</v></c></row><row r="4"><c r="A4"><v>4</v></c><c r="B4"><f>A1</f><v>1</v></c></row></sheetData>'
				}
			]
		})
		// A1 to the gridline above A4: 2 3 1 4.
		const change = changeOf(
			await session.command({ type: "cells.move", sheet, range: range(0, 0), to: { row: 3, col: 0 }, copy: false, insert: "rows" })
		)

		expect(await inputAt(session, sheet, 0, 0)).toBe("2")
		expect(await inputAt(session, sheet, 1, 0)).toBe("3")
		expect(await inputAt(session, sheet, 2, 0)).toBe("1")
		expect(await inputAt(session, sheet, 3, 0)).toBe("4")
		// The reference followed the moved cell.
		expect(await inputAt(session, sheet, 3, 1)).toBe("=A3")
		expect(change.selection?.ranges).toEqual([range(2, 0)])
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("copies with an insert, shifting the cells there right", async () => {
		const { session, sheet } = await opened()

		changeOf(
			await session.command({ type: "cells.move", sheet, range: range(1, 0), to: { row: 0, col: 0 }, copy: true, insert: "cols" })
		)
		expect(await inputAt(session, sheet, 0, 0)).toBe("3")
		expect(await inputAt(session, sheet, 0, 1)).toBe("5")
		expect(await inputAt(session, sheet, 0, 2)).toBe("=B1*2")
		expect(await inputAt(session, sheet, 1, 0)).toBe("3")
		session.close()
	})

	it("refuses to move part of a merged cell, or onto part of one", async () => {
		const { session, sheet } = await opened({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="C3:D4"/></mergeCells>'
				}
			]
		})

		expect(refusal(await session.command({ type: "cells.move", sheet, range: range(2, 2), to: { row: 8, col: 8 }, copy: false }))).toBe(
			"merged"
		)
		expect(refusal(await session.command({ type: "cells.move", sheet, range: range(0, 0), to: { row: 3, col: 3 }, copy: true }))).toBe(
			"merged"
		)
		// A whole merge moves with its cells.
		changeOf(await session.command({ type: "cells.move", sheet, range: range(2, 2, 3, 3), to: { row: 6, col: 6 }, copy: false }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<mergeCell ref="G7:H8"/>')
		session.close()
	})

	it("refuses on a protected sheet's locked cells", async () => {
		const { session, sheet } = await opened({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData><sheetProtection sheet="1" objects="1" scenarios="1"/>'
				}
			]
		})

		expect(refusal(await session.command({ type: "cells.move", sheet, range: range(0, 0), to: { row: 4, col: 4 }, copy: false }))).toBe(
			"protectedSheet"
		)
		expect(refusal(await session.command({ type: "cells.move", sheet, range: range(0, 0), to: { row: 4, col: 4 }, copy: true }))).toBe(
			"protectedSheet"
		)
		session.close()
	})
})

describe("cells.move in a text file", () => {
	async function csv(text: string): Promise<SheetSessionApi> {
		const result = await openTextSession(new TextEncoder().encode(text), { kind: "csv" }, () => undefined)

		if (result.kind !== "opened") throw new Error(result.kind)

		return result.session
	}

	const text = async (session: SheetSessionApi): Promise<string> => new TextDecoder().decode(await savedBytes(session))

	it("moves, asks before replacing, copies and reorders, each undone as one", async () => {
		const session = await csv("a,b\r\n1,2\r\n")

		changeOf(await session.command({ type: "cells.move", sheet: 0, range: range(0, 0), to: { row: 0, col: 2 }, copy: false }))
		expect(await text(session)).toBe(",b,a\r\n1,2\r\n")
		expect(
			refusal(await session.command({ type: "cells.move", sheet: 0, range: range(0, 2), to: { row: 1, col: 1 }, copy: false }))
		).toBe("occupied")
		changeOf(await session.command({ type: "cells.move", sheet: 0, range: range(1, 0), to: { row: 0, col: 0 }, copy: true }))
		expect(await text(session)).toBe("1,b,a\r\n1,2\r\n")
		await session.undo()
		await session.undo()
		expect(await text(session)).toBe("a,b\r\n1,2\r\n")

		changeOf(
			await session.command({ type: "cells.move", sheet: 0, range: range(0, 0), to: { row: 2, col: 0 }, copy: false, insert: "rows" })
		)
		expect(await text(session)).toBe("1,b\r\na,2\r\n")
		await session.undo()
		expect(await text(session)).toBe("a,b\r\n1,2\r\n")
		session.close()
	})
})

describe("cellDrag geometry", () => {
	it("grabs the outline of the selection only", () => {
		const rects = [{ x: 100, y: 50, width: 80, height: 20 }]

		expect(onBorder(rects, 179, 60, BORDER_SLOP)).toBe(true)
		expect(onBorder(rects, 98, 60, BORDER_SLOP)).toBe(true)
		expect(onBorder(rects, 140, 60, BORDER_SLOP)).toBe(false)
		expect(onBorder(rects, 190, 60, BORDER_SLOP)).toBe(false)
	})

	it("keeps the grabbed cell under the pointer, on the sheet, and whole rows on their axis", () => {
		const source = range(2, 2, 3, 3)

		expect(dropAt(source, { row: 3, col: 3 }, { row: 10, col: 10 }, null)).toEqual({ to: { row: 9, col: 9 }, insert: null })
		expect(dropAt(source, { row: 3, col: 3 }, { row: 0, col: 0 }, null).to).toEqual({ row: 0, col: 0 })
		expect(dropAt(range(2, 0, 2, SHEET_MAX_COLS - 1), { row: 2, col: 5 }, { row: 7, col: 9 }, null).to).toEqual({ row: 7, col: 0 })
	})

	it("inserts at the nearest edge's gridline, after a merge's last row", () => {
		const spot = cellSpot({ x: 0, y: 0, width: 80, height: 20 }, 40, 18)

		expect(spot).toEqual({ edge: "bottom", below: true, after: false })
		expect(dropAt(range(0, 0), { row: 0, col: 0 }, { row: 5, col: 2 }, spot)).toEqual({ to: { row: 6, col: 2 }, insert: "rows" })
		expect(dropAt(range(0, 0), { row: 0, col: 0 }, { row: 5, col: 2 }, spot, range(4, 2, 7, 2)).to).toEqual({ row: 8, col: 2 })
		expect(
			dropAt(range(0, 0), { row: 0, col: 0 }, { row: 5, col: 2 }, cellSpot({ x: 0, y: 0, width: 80, height: 20 }, 78, 10))
		).toEqual({
			to: { row: 5, col: 3 },
			insert: "cols"
		})
	})

	it("drops nothing where a move changes nothing; a copy onto itself still copies", () => {
		const source = range(2, 0, 3, 0)

		expect(sameDrop(source, { to: { row: 2, col: 0 }, insert: null }, false)).toBe(true)
		expect(sameDrop(source, { to: { row: 4, col: 0 }, insert: "rows" }, false)).toBe(true)
		expect(sameDrop(source, { to: { row: 5, col: 0 }, insert: "rows" }, false)).toBe(false)
		expect(sameDrop(source, { to: { row: 2, col: 0 }, insert: null }, true)).toBe(false)
	})

	it("reads Ctrl on Windows and Option on a Mac as copy, Shift as insert; one range only", () => {
		expect(dragKeys({ ctrlKey: true, altKey: false, shiftKey: true }, false)).toEqual({ copy: true, insert: true })
		expect(dragKeys({ ctrlKey: true, altKey: false, shiftKey: false }, true)).toEqual({ copy: false, insert: false })
		expect(dragKeys({ ctrlKey: false, altKey: true, shiftKey: false }, true)).toEqual({ copy: true, insert: false })
		expect(draggable([range(0, 0), range(2, 2)])).toBeNull()
	})
})
