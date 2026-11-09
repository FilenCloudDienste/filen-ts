import { describe, expect, it } from "vitest"
import { pastedCells, pasteRepeats } from "../core/sheet/clipboard/tsv"
import type { SheetCommandResult, SheetRange, SheetSessionApi } from "../core/sheet/protocol"
import { firstTile, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// A paste into a selected paste area, as Excel fills one ("Move or copy cells and cell contents"): an area whose
// height and width are whole multiples of the copied block takes it that many times; a cut, any other area, or one a
// copy would cut a merged cell of, takes it once.

const range = (startRow: number, startCol: number, endRow: number, endCol: number): SheetRange => ({ startRow, startCol, endRow, endCol })

async function texts(session: SheetSessionApi, cells: readonly (readonly [number, number])[]): Promise<(string | null)[]> {
	const tile = await firstTile(session, 0)

	return cells.map(([row, col]) => {
		const entry = tileEntry(tile, row, col)

		return entry === null || entry.text === "" ? null : (entry.input ?? entry.text)
	})
}

async function copyPaste(session: SheetSessionApi, source: SheetRange, target: SheetRange, cut = false): Promise<SheetCommandResult> {
	const copy = await session.query("copy", { sheet: 0, range: source, cut })

	if (!("clip" in copy)) throw new Error("copy refused")

	return session.command({
		type: "clipboard.paste",
		sheet: 0,
		at: { row: target.startRow, col: target.startCol },
		text: copy.text,
		clip: copy.clip,
		target
	})
}

describe("paste area repeats", () => {
	it("repeats a block over whole multiples of it only", () => {
		const at = { row: 0, col: 0 }

		expect(pasteRepeats(1, 1, at, range(0, 0, 99, 0))).toEqual({ down: 100, across: 1 })
		expect(pasteRepeats(1, 3, at, range(0, 0, 3, 2))).toEqual({ down: 4, across: 1 })
		expect(pasteRepeats(2, 2, at, range(0, 0, 3, 2))).toEqual({ down: 1, across: 1 })
		expect(pasteRepeats(1, 1, at, undefined)).toEqual({ down: 1, across: 1 })
		// An area not starting where the paste does is not its paste area.
		expect(pasteRepeats(1, 1, at, range(1, 0, 4, 0))).toEqual({ down: 1, across: 1 })
	})

	it("pastes once where a copy would cut through a merged cell", () => {
		const at = { row: 0, col: 0 }

		// A2:A3 merged across the 1x1 copies of A1:A4.
		expect(pasteRepeats(1, 1, at, range(0, 0, 3, 0), [1, 0, 2, 0])).toEqual({ down: 1, across: 1 })
		// A merge inside one 2-row copy, or outside the area, cuts none.
		expect(pasteRepeats(2, 1, at, range(0, 0, 3, 0), [2, 0, 3, 0, 9, 9, 10, 10])).toEqual({ down: 2, across: 1 })
	})

	it("repeats plain text and refuses an area past the edit cap before building it", () => {
		const block = pastedCells("x\ty", null, { row: 0, col: 0 }, "S", 100, range(0, 0, 2, 3))

		expect(block?.rows).toBe(3)
		expect(block?.cols).toBe(4)
		expect(block?.cells.map(cell => cell.input)).toEqual(["x", "y", "x", "y", "x", "y", "x", "y", "x", "y", "x", "y"])
		expect(pastedCells("x", null, { row: 0, col: 0 }, "S", 100, range(0, 0, 100, 0))).toBeNull()
	})
})

describe("sheet session: pasting into a paste area", () => {
	it("fills the whole selection with one copied cell, as one undo step", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[7]]) }] })
		const result = await copyPaste(session, range(0, 0, 0, 0), range(0, 2, 49, 2))

		expect(result.ok ? result.change.selection?.ranges : null).toEqual([range(0, 2, 49, 2)])
		expect(
			await texts(
				session,
				[0, 25, 49, 50].map(row => [row, 2] as const)
			)
		).toEqual(["7", "7", "7", null])

		await session.undo()

		expect(
			await texts(
				session,
				[0, 25, 49].map(row => [row, 2] as const)
			)
		).toEqual([null, null, null])
	})

	it("repeats a 1x3 block over a 4x3 area, each copy's relative references moved to its own origin", async () => {
		const { session } = await openKeys({
			sheets: [
				{
					name: "S",
					body: sheetBody([
						[1, 2, "=A1+B1+$A$1"],
						[10, 20]
					])
				}
			]
		})

		await copyPaste(session, range(0, 0, 0, 2), range(3, 0, 6, 2))

		expect(
			await texts(session, [
				[3, 0],
				[3, 2],
				[4, 2],
				[6, 1],
				[6, 2]
			])
		).toEqual(["1", "=A4+B4+$A$1", "=A5+B5+$A$1", "2", "=A7+B7+$A$1"])
	})

	it("pastes once into an area that is not a whole multiple of the block", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[1, 2]]) }] })

		await copyPaste(session, range(0, 0, 0, 1), range(2, 0, 3, 2))

		expect(
			await texts(session, [
				[2, 0],
				[2, 1],
				[2, 2],
				[3, 0]
			])
		).toEqual(["1", "2", null, null])
	})

	it("moves a cut once, whatever the area", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[5]]) }] })

		await copyPaste(session, range(0, 0, 0, 0), range(2, 0, 5, 0), true)

		expect(
			await texts(session, [
				[0, 0],
				[2, 0],
				[3, 0]
			])
		).toEqual([null, "5", null])
	})

	it("refuses an area past the edit cap", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[5]]) }] })
		const result = await copyPaste(session, range(0, 0, 0, 0), range(0, 1, 299_999, 1))

		expect(result.ok ? null : result.refusal.reason).toBe("tooLarge")
		expect(await texts(session, [[0, 1]])).toEqual([null])
	})

	it("repeats an HTML table over the area, its formulas moved per copy", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[1]]) }] })

		await session.command({
			type: "clipboard.pasteHtml",
			sheet: 0,
			at: { row: 0, col: 1 },
			html: '<table><tr><td data-sheets-formula="=R[0]C[-1]*2">2</td></tr></table>',
			text: "2",
			target: range(0, 1, 2, 1)
		})

		expect(
			await texts(session, [
				[0, 1],
				[1, 1],
				[2, 1]
			])
		).toEqual(["=A1*2", "=A2*2", "=A3*2"])
	})

	it("repeats a copy over the area in a text file", async () => {
		const { session } = await openKeys("a,b\n")

		await copyPaste(session, range(0, 0, 0, 1), range(1, 0, 2, 3))

		expect(
			await texts(session, [
				[1, 0],
				[1, 3],
				[2, 2]
			])
		).toEqual(["a", "b", "a"])
	})
})
