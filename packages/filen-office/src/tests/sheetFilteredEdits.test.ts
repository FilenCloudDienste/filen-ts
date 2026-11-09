import { describe, expect, it } from "vitest"
import type { SheetCommand, SheetCommandResult, SheetSessionApi } from "../core/sheet/protocol"
import { visibleFillPlan } from "../core/sheet/fill/fill"
import { rowHidden, visibleRanges } from "../core/sheet/visibleRows"
import { cells, firstTile, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// Edits over a filtered selection act on its visible rows only, as Excel's do; rows hidden by hand on a sheet no
// filter filters are edited as any. And automatic percent entry: a number typed into a percent cell.

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} (${result.refusal.detail ?? ""})`)
}

async function run(session: SheetSessionApi, command: SheetCommand): Promise<void> {
	ok(await session.command(command))
}

async function column(session: SheetSessionApi, col: number, rows: number): Promise<string[]> {
	const tile = await firstTile(session, 0)

	return Array.from({ length: rows }, (_, row) => tileEntry(tile, row, col)?.text ?? "")
}

// A header, then rows of fruit and a count: a filter on "apple" hides rows 3 and 5 (indices 2 and 4).
const FRUIT = sheetBody([
	["Fruit", "Count"],
	["apple", 1],
	["pear", 2],
	["apple", 3],
	["fig", 4],
	["apple", 5]
])

const ALL = { startRow: 0, startCol: 0, endRow: 5, endCol: 1 }
const BODY = { startRow: 1, startCol: 1, endRow: 5, endCol: 1 }

async function filtered(): Promise<SheetSessionApi> {
	const { session } = await openKeys({ sheets: [{ name: "Data", body: FRUIT }] })

	await session.intent()
	await run(session, { type: "filter.toggle", sheet: 0, range: ALL, active: { row: 0, col: 0 } })
	await run(session, {
		type: "filter.column",
		sheet: 0,
		row: 0,
		col: 0,
		criteria: { kind: "values", values: ["apple"], blank: false, dates: [] }
	})

	return session
}

// The same rows hidden by hand, no filter on the sheet.
async function handHidden(): Promise<SheetSessionApi> {
	const body = FRUIT.replace('<row r="3">', '<row r="3" hidden="1">').replace('<row r="5">', '<row r="5" hidden="1">')
	const { session } = await openKeys({ sheets: [{ name: "Data", body }] })

	await session.intent()

	return session
}

describe("visible row runs", () => {
	it("splits a range around hidden spans and keeps a range no span crosses", () => {
		const hidden = [
			{ first: 2, last: 2 },
			{ first: 4, last: 6 }
		]
		const kept = { startRow: 10, startCol: 0, endRow: 12, endCol: 1 }

		expect(visibleRanges([{ startRow: 1, startCol: 0, endRow: 8, endCol: 1 }, kept], hidden)).toEqual([
			{ startRow: 1, startCol: 0, endRow: 1, endCol: 1 },
			{ startRow: 3, startCol: 0, endRow: 3, endCol: 1 },
			{ startRow: 7, startCol: 0, endRow: 8, endCol: 1 },
			kept
		])

		const ranges = [kept]

		expect(visibleRanges(ranges, hidden)).toBe(ranges)
		expect(visibleRanges(ranges, [])).toBe(ranges)
		expect(visibleRanges([{ startRow: 4, startCol: 0, endRow: 6, endCol: 0 }], hidden)).toEqual([])
		expect([1, 2, 3, 4, 6, 7].map(row => rowHidden(hidden, row))).toEqual([false, true, false, true, true, false])
	})

	it("fills down from the first visible row into the visible rows only", () => {
		const plan = visibleFillPlan([{ startRow: 1, startCol: 0, endRow: 5, endCol: 0 }], "down", [
			{ first: 1, last: 1 },
			{ first: 3, last: 3 }
		])

		expect(plan === null || plan === "tooLarge" ? plan : [Array.from(plan.rows), Array.from(plan.sourceRows)]).toEqual([
			[4, 5],
			[2, 2]
		])
	})
})

describe("edits over a filtered selection", () => {
	it("Delete clears the visible rows only", async () => {
		const session = await filtered()

		await run(session, { type: "cells.clear", sheet: 0, ranges: [BODY], what: "contents" })
		expect(await column(session, 1, 6)).toEqual(["Count", "", "2", "", "4", ""])
	})

	it("Fill Down copies the first row into the visible rows only", async () => {
		const session = await filtered()

		await run(session, { type: "fill.copy", sheet: 0, ranges: [BODY], direction: "down" })
		expect(await column(session, 1, 6)).toEqual(["Count", "1", "2", "1", "4", "1"])
	})

	it("Ctrl+Enter writes the visible rows only", async () => {
		const session = await filtered()

		await run(session, { type: "fill.entry", sheet: 0, ranges: [BODY], entry: "9", from: { row: 1, col: 1 } })
		expect(await column(session, 1, 6)).toEqual(["Count", "9", "2", "9", "4", "9"])
	})

	it("formats the visible rows only", async () => {
		const session = await filtered()

		await run(session, { type: "format.apply", sheet: 0, ranges: [BODY], patch: { numFmt: "0.00" } })
		expect(await column(session, 1, 6)).toEqual(["Count", "1.00", "2", "3.00", "4", "5.00"])
	})

	it("edits rows hidden by hand when no filter filters the sheet", async () => {
		const cleared = await handHidden()

		await run(cleared, { type: "cells.clear", sheet: 0, ranges: [BODY], what: "contents" })
		expect(await column(cleared, 1, 6)).toEqual(["Count", "", "", "", "", ""])

		const filled = await handHidden()

		await run(filled, { type: "fill.copy", sheet: 0, ranges: [BODY], direction: "down" })
		expect(await column(filled, 1, 6)).toEqual(["Count", "1", "1", "1", "1", "1"])
	})
})

describe("automatic percent entry", () => {
	async function percentCells(): Promise<SheetSessionApi> {
		const { session } = await openKeys({ sheets: [{ name: "One", body: "<sheetData/>" }] })

		await run(session, {
			type: "format.apply",
			sheet: 0,
			ranges: [{ startRow: 0, startCol: 0, endRow: 5, endCol: 0 }],
			patch: { numFmt: "0%" }
		})

		return session
	}

	it("reads a number of 1 or more typed into a percent cell as percent, keeps smaller ones", async () => {
		const session = await percentCells()

		await run(session, {
			type: "cells.set",
			sheet: 0,
			cells: cells([
				[0, 0, "5"],
				[1, 0, "0.1"],
				[2, 0, "-5"],
				[3, 0, "5%"],
				[4, 0, "0"],
				[0, 1, "5"]
			])
		})

		const tile = await firstTile(session, 0)

		expect([0, 1, 2, 3, 4].map(row => tileEntry(tile, row, 0)?.text)).toEqual(["5%", "10%", "-5%", "5%", "0%"])
		// A General cell takes the number as typed.
		expect(tileEntry(tile, 0, 1)?.text).toBe("5")
	})

	it("applies to Ctrl+Enter but not to a paste", async () => {
		const session = await percentCells()

		await run(session, {
			type: "fill.entry",
			sheet: 0,
			ranges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 0 }],
			entry: "7",
			from: { row: 0, col: 0 }
		})
		await run(session, { type: "clipboard.paste", sheet: 0, at: { row: 2, col: 0 }, text: "5" })

		expect(await column(session, 0, 3)).toEqual(["7%", "7%", "500%"])
	})
})
