import { describe, expect, it } from "vitest"
import type { SheetCommand, SheetSessionApi } from "../core/sheet/protocol"
import { sheetText } from "../core/sheet/readText"
import { firstTile, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// The "text" query a reader (the assistant) asks: a sheet's cells as shown, tab-separated, every row a filter hides
// included, cut at the characters asked for in the worker, and the session's held copy left as it was.

async function run(session: SheetSessionApi, command: SheetCommand): Promise<void> {
	const result = await session.command(command)

	if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)
}

const FRUIT = sheetBody([
	["Fruit", "Count", "Double"],
	["apple", 1, { f: "B2*2", v: 2 }],
	["pear", 2, { f: "B3*2", v: 4 }],
	["apple", 3, { f: "B4*2", v: 6 }]
])

describe("the sheet text query", () => {
	it("reads a workbook's used area as shown, rows a filter hides included", async () => {
		const { session } = await openKeys({ sheets: [{ name: "Data", body: FRUIT }] })

		await session.intent()
		await run(session, {
			type: "filter.toggle",
			sheet: 0,
			range: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
			active: { row: 0, col: 0 }
		})
		await run(session, {
			type: "filter.column",
			sheet: 0,
			row: 0,
			col: 0,
			criteria: { kind: "values", values: ["apple"], blank: false, dates: [] }
		})

		expect(await session.query("text", { sheet: 0, maxChars: 1000 })).toEqual({
			text: "Fruit\tCount\tDouble\napple\t1\t2\npear\t2\t4\napple\t3\t6",
			truncated: false
		})
		expect(
			await session.query("text", { sheet: 0, range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 }, maxChars: 1000 })
		).toEqual({ text: "1\t2\n2\t4", truncated: false })
		expect(await session.query("text", { sheet: 0, maxChars: 12 })).toEqual({ text: "Fruit\tCount\t", truncated: true })
		session.close()
	})

	it("leaves the session's held copy alone: a cut still moves its cells once the text was read", async () => {
		const { session } = await openKeys({ sheets: [{ name: "Data", body: FRUIT }] })

		await session.intent()

		const cut = await session.query("copy", { sheet: 0, range: { startRow: 1, startCol: 0, endRow: 1, endCol: 0 }, cut: true })

		if (!("clip" in cut)) throw new Error("copy refused")

		await session.query("text", { sheet: 0, maxChars: 1000 })
		await run(session, { type: "clipboard.paste", sheet: 0, at: { row: 6, col: 0 }, text: cut.text, clip: cut.clip })

		const tile = await firstTile(session, 0)

		expect(tileEntry(tile, 6, 0)?.text).toBe("apple")
		expect(tileEntry(tile, 1, 0)?.text ?? "").toBe("")
		session.close()
	})

	it("reads a CSV file's cells, quoting fields as a copy does", async () => {
		const { session } = await openKeys('a,"b\tc"\n1,2,3\n\nlast')

		expect(await session.query("text", { sheet: 0, maxChars: 1000 })).toEqual({ text: 'a\t"b\tc"\n1\t2\t3\n\nlast', truncated: false })
		expect(await session.query("text", { sheet: 0, maxChars: 2 })).toEqual({ text: "a\t", truncated: true })
		session.close()
	})

	it("bounds the blank rows and columns it writes by the room left, and never splits a surrogate pair", () => {
		const far = sheetText(
			{
				rows: 1_000_000,
				cols: 3,
				cells: (area, visit) => {
					if (area.startRow <= 0) visit(0, 0, "top")
					if (area.startRow <= 999_999 && area.endRow >= 999_999) visit(999_999, 2, "bottom")
				}
			},
			undefined,
			10
		)

		expect(far).toEqual({ text: "top\n\n\n\n\n\n\n", truncated: true })
		expect(sheetText({ rows: 1, cols: 1, cells: (_area, visit) => visit(0, 0, "ab😀") }, undefined, 3)).toEqual({
			text: "ab",
			truncated: true
		})
		expect(sheetText({ rows: 0, cols: 0, cells: () => undefined }, undefined, 10)).toEqual({ text: "", truncated: false })
	})
})
