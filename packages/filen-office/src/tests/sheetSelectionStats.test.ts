import { describe, expect, it } from "vitest"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../core/sheet/protocol"
import { openKeys, sheetBody } from "./sheetKeysFixtures"
import { budget, cpuMs } from "./timing"

// The status bar's Count, Sum and Average of a selection (Excel's "View summary data on the status bar").

const range = (startRow: number, startCol: number, endRow: number, endCol: number): SheetRange => ({ startRow, startCol, endRow, endCol })
const WHOLE = range(0, 0, SHEET_MAX_ROWS - 1, SHEET_MAX_COLS - 1)

describe("selection stats", () => {
	it("counts what cells hold and sums their numbers, formula results included", async () => {
		const rows = [
			[1, "text", { f: "A1*2", v: 2 }],
			[3, null, { f: '"x"', v: "x" }]
		]
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(rows) }] })
		const stats = await session.query("selectionStats", { sheet: 0, ranges: [range(0, 0, 1, 2)] })

		expect(stats).toMatchObject({ count: 5, numericCount: 3, sum: "6", average: "2", error: false })
	})

	it("walks only the cells a whole-sheet selection holds", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody([[4], [null, 6]]) }] })

		expect(await session.query("selectionStats", { sheet: 0, ranges: [WHOLE] })).toMatchObject({ count: 2, sum: "10", average: "5" })
	})

	it("counts a cell twice where ranges overlap, as Excel does", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody([[2, 3]]) }] })
		const stats = await session.query("selectionStats", { sheet: 0, ranges: [range(0, 0, 0, 1), range(0, 1, 0, 1)] })

		expect(stats).toMatchObject({ count: 3, numericCount: 3, sum: "8" })
	})

	it("shows no Sum or Average when a cell shows an error", async () => {
		const body = sheetBody([[1], [2]]).replace("</row></sheetData>", '<c r="B2" t="e"><v>#DIV/0!</v></c></row></sheetData>')
		const { session } = await openKeys({ sheets: [{ name: "One", body }] })

		expect(await session.query("selectionStats", { sheet: 0, ranges: [range(0, 0, 1, 1)] })).toMatchObject({
			count: 3,
			numericCount: 2,
			sum: "",
			average: "",
			error: true
		})
	})

	it("leaves out hidden rows and columns", async () => {
		const body = sheetBody([
			[1, 10],
			[2, 20],
			[4, 40]
		])
			.replace('<row r="2">', '<row r="2" hidden="1">')
			.replace("<sheetData>", '<cols><col min="2" max="2" width="9" hidden="1"/></cols><sheetData>')
		const { session } = await openKeys({ sheets: [{ name: "One", body }] })

		expect(await session.query("selectionStats", { sheet: 0, ranges: [range(0, 0, 2, 1)] })).toMatchObject({
			count: 2,
			sum: "5",
			average: "2.5"
		})
	})

	it("reads a text file's fields as numbers, errors and text", async () => {
		const { session } = await openKeys("1,2.5\nname,\n3,#N/A\n")

		expect(await session.query("selectionStats", { sheet: 0, ranges: [range(0, 0, 1, 1)] })).toMatchObject({
			count: 3,
			numericCount: 2,
			sum: "3.5",
			average: "1.75",
			error: false
		})
		expect(await session.query("selectionStats", { sheet: 0, ranges: [WHOLE] })).toMatchObject({ count: 5, error: true, sum: "" })
	})

	it("sums 100k cells of a whole-sheet selection within budget", async () => {
		const rows = Array.from({ length: 20_000 }, (_, row) => [row, row + 1, row + 2, row + 3, row + 4])
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(rows) }] })

		await session.query("selectionStats", { sheet: 0, ranges: [WHOLE] })

		let least = Number.POSITIVE_INFINITY
		let stats = null

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()

			stats = await session.query("selectionStats", { sheet: 0, ranges: [WHOLE] })
			least = Math.min(least, cpuMs() - start)
		}

		expect(stats).toMatchObject({ count: 100_000, numericCount: 100_000 })
		expect(least).toBeLessThanOrEqual(budget(100))
	})
})
