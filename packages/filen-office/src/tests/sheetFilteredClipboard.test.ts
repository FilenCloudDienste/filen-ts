import { describe, expect, it } from "vitest"
import type { SheetCommand, SheetCommandResult, SheetSessionApi } from "../core/sheet/protocol"
import { pastedCells, type GridClip } from "../core/sheet/clipboard/tsv"
import { cells, firstTile, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// A copy of filtered data takes its visible rows only and pastes them on consecutive rows, each formula moved from
// the row it was copied from; a cut moves every row of its range; one row pasted down a filtered area lands on its
// visible rows only. Rows hidden by hand on a sheet no filter filters are copied as any.

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} (${result.refusal.detail ?? ""})`)
}

async function run(session: SheetSessionApi, command: SheetCommand): Promise<void> {
	ok(await session.command(command))
}

async function column(session: SheetSessionApi, col: number, from: number, rows: number, input = false): Promise<string[]> {
	const tile = await firstTile(session, 0)

	return Array.from({ length: rows }, (_, i) => {
		const entry = tileEntry(tile, from + i, col)

		return (input ? entry?.input : entry?.text) ?? ""
	})
}

// A header, then fruit, a count and twice the count: a filter on "apple" hides rows 3 and 5 (indices 2 and 4).
const FRUIT = sheetBody([
	["Fruit", "Count", "Double"],
	["apple", 1, { f: "B2*2", v: 2 }],
	["pear", 2, { f: "B3*2", v: 4 }],
	["apple", 3, { f: "B4*2", v: 6 }],
	["fig", 4, { f: "B5*2", v: 8 }],
	["apple", 5, { f: "B6*2", v: 10 }]
])

const ALL = { startRow: 0, startCol: 0, endRow: 5, endCol: 2 }
const BODY = { startRow: 1, startCol: 0, endRow: 5, endCol: 2 }

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

async function handHidden(): Promise<SheetSessionApi> {
	const body = FRUIT.replace('<row r="3">', '<row r="3" hidden="1">').replace('<row r="5">', '<row r="5" hidden="1">')
	const { session } = await openKeys({ sheets: [{ name: "Data", body }] })

	await session.intent()

	return session
}

async function copy(session: SheetSessionApi, range: typeof BODY, cut = false): Promise<{ clip: number; text: string }> {
	const copied = await session.query("copy", { sheet: 0, range, cut })

	if (!("clip" in copied)) throw new Error("copy refused")

	return copied
}

describe("copying filtered data", () => {
	it("copies the visible rows only", async () => {
		const session = await filtered()

		expect((await copy(session, BODY)).text).toBe("apple\t1\t2\r\napple\t3\t6\r\napple\t5\t10")
	})

	it("pastes the visible rows on consecutive rows, each formula moved from its own row", async () => {
		const session = await filtered()
		const copied = await copy(session, BODY)

		await run(session, { type: "clipboard.paste", sheet: 0, at: { row: 10, col: 0 }, text: copied.text, clip: copied.clip })
		expect(await column(session, 0, 10, 4)).toEqual(["apple", "apple", "apple", ""])
		expect(await column(session, 1, 10, 3)).toEqual(["1", "3", "5"])
		// B2*2 from row 2 to row 11, B4*2 from row 4 to row 12, B6*2 from row 6 to row 13.
		expect(await column(session, 2, 10, 3, true)).toEqual(["=B11*2", "=B12*2", "=B13*2"])
		expect(await column(session, 2, 10, 3)).toEqual(["2", "6", "10"])
	})

	it("copies the visible rows only as HTML, each formula's source cell its own", async () => {
		const session = await filtered()
		const { html } = await session.query("copyHtml", { sheet: 0, range: BODY })

		expect(html?.match(/<tr>/g)?.length).toBe(3)
		expect(html).not.toContain("pear")
		expect(html).toContain('data-filen-cell="5,2"')
		expect(html).not.toContain('data-filen-cell="2,2"')
	})

	it("cuts every row of the range, hidden ones too, as Excel moves them", async () => {
		const session = await filtered()
		const cut = await copy(session, BODY, true)

		expect(cut.text.split("\r\n")).toHaveLength(5)

		const { html } = await session.query("copyHtml", { sheet: 0, range: BODY, cut: true })

		expect(html).toContain("pear")
	})

	it("copies rows hidden by hand when no filter filters the sheet", async () => {
		const session = await handHidden()

		expect((await copy(session, BODY)).text.split("\r\n")).toHaveLength(5)
	})
})

describe("pasting one row down a filtered area", () => {
	it("writes the visible rows only, from the session's own copy", async () => {
		const session = await filtered()

		await run(session, { type: "cells.set", sheet: 0, cells: cells([[8, 1, "9"]]) })

		const copied = await copy(session, { startRow: 8, startCol: 1, endRow: 8, endCol: 1 })

		await run(session, {
			type: "clipboard.paste",
			sheet: 0,
			at: { row: 1, col: 1 },
			text: copied.text,
			clip: copied.clip,
			target: { startRow: 1, startCol: 1, endRow: 5, endCol: 1 }
		})
		expect(await column(session, 1, 1, 5)).toEqual(["9", "2", "9", "4", "9"])
	})

	it("writes the visible rows only, from text and from HTML", async () => {
		const text = await filtered()
		const area = { startRow: 1, startCol: 1, endRow: 5, endCol: 1 }

		await run(text, { type: "clipboard.paste", sheet: 0, at: { row: 1, col: 1 }, text: "7", target: area })
		expect(await column(text, 1, 1, 5)).toEqual(["7", "2", "7", "4", "7"])

		const html = await filtered()

		await run(html, {
			type: "clipboard.pasteHtml",
			sheet: 0,
			at: { row: 1, col: 1 },
			html: "<table><tr><td>8</td></tr></table>",
			text: "8",
			target: area
		})
		expect(await column(html, 1, 1, 5)).toEqual(["8", "2", "8", "4", "8"])
	})

	it("writes a taller block on consecutive rows, hidden ones too", async () => {
		const session = await filtered()

		await run(session, {
			type: "clipboard.paste",
			sheet: 0,
			at: { row: 1, col: 1 },
			text: "7\r\n8",
			target: { startRow: 1, startCol: 1, endRow: 4, endCol: 1 }
		})
		expect(await column(session, 1, 1, 4)).toEqual(["7", "8", "7", "8"])
	})
})

describe("a clip's row map", () => {
	it("moves each formula by the row it was copied from", () => {
		const clip: GridClip = {
			tsv: "1\r\n2",
			sheet: "S",
			range: { startRow: 0, startCol: 0, endRow: 9, endCol: 0 },
			cut: false,
			inputs: new Map([
				[0, "=A1"],
				[16_384, "=A6"]
			]),
			sourceRows: Uint32Array.of(1, 6)
		}

		expect(pastedCells(clip.tsv, clip, { row: 20, col: 0 }, "S", 10)?.cells).toEqual([
			{ row: 20, col: 0, input: "=A20" },
			{ row: 21, col: 0, input: "=A21" }
		])
	})
})
