import { describe, expect, it } from "vitest"
import { navigate, type SheetOccupancy } from "../core/sheet/navigate/navigate"
import { SHEET_MAX_ROWS, type SheetCellDetail, type SheetRange, type SheetSessionApi } from "../core/sheet/protocol"
import type { GridAxis } from "../react/sheet/axis"
import { fillDownTo } from "../react/sheet/fill"

// A session answering only the cell and navigate queries fillDownTo asks, over a set of filled "row:col" cells.
function fakeSession(filled: ReadonlySet<string>, hidden: ReadonlySet<number>): { session: SheetSessionApi; queries: string[] } {
	const queries: string[] = []
	const has = (row: number, col: number): boolean => filled.has(`${row}:${col}`)
	const scan = (from: number, step: 1 | -1, until: number, at: (index: number) => boolean): number => {
		for (let index = from; step === 1 ? index <= until : index >= until; index += step) if (at(index)) return index

		return -1
	}
	const occupancy: SheetOccupancy = {
		filled: has,
		nextInCol: (col, row, step, until) => scan(row, step, until ?? (step === 1 ? 200 : 0), index => has(index, col)),
		nextInRow: (row, col, step, until) => scan(col, step, until ?? (step === 1 ? 50 : 0), index => has(row, index)),
		hiddenRow: row => hidden.has(row),
		hiddenCol: () => false,
		lastRow: 200,
		lastCol: 50
	}
	const query = (name: string, request: never): unknown => {
		queries.push(name)

		if (name === "cell") {
			const { row, col } = request as { row: number; col: number }
			const detail: SheetCellDetail = { input: has(row, col) ? "1" : "", numFmt: "General", style: 0, flags: 0 }

			return detail
		}

		if (name === "navigate") return navigate(occupancy, request)

		throw new Error(name)
	}

	return {
		session: { query: (name: string, request: never) => Promise.resolve(query(name, request)) } as unknown as SheetSessionApi,
		queries
	}
}

function rowsAxis(hidden: ReadonlySet<number>): GridAxis {
	return {
		count: SHEET_MAX_ROWS,
		total: 0,
		defaultSize: 20,
		size: index => (hidden.has(index) ? 0 : 20),
		offset: () => 0,
		indexAt: () => 0,
		hidden: index => hidden.has(index),
		lastShown: SHEET_MAX_ROWS - 1
	}
}

const cells = (...list: [number, number][]): Set<string> => new Set(list.map(([row, col]) => `${row}:${col}`))
const at = (startRow: number, col: number, endRow = startRow): SheetRange => ({ startRow, startCol: col, endRow, endCol: col })

async function downTo(filled: Set<string>, source: SheetRange, hidden: ReadonlySet<number> = new Set()): Promise<number | null> {
	return fillDownTo(fakeSession(filled, hidden).session, 0, source, rowsAxis(hidden))
}

describe("fillDownTo (double-click on the fill handle)", () => {
	it("stops at a lone filled cell below the selection, not at a further block past a gap", async () => {
		// A2 selected; B2:B3 filled, B4:B19 blank, B20 filled.
		const filled = cells([1, 1], [2, 1], [19, 1])

		expect(await downTo(filled, at(1, 0))).toBe(2)
	})

	it("fills to the end of a run below the selection, not past the gap after it", async () => {
		const filled = cells([1, 1], [2, 1], [3, 1], [4, 1], [10, 1], [11, 1])

		expect(await downTo(filled, at(1, 0))).toBe(4)
	})

	it("passes hidden rows inside the run and stops at a lone cell whose next shown row is blank", async () => {
		// B3 filled, B4 hidden (blank), B5:B6 filled: the run goes on past the hidden row.
		expect(await downTo(cells([2, 1], [4, 1], [5, 1]), at(1, 0), new Set([3]))).toBe(5)
		// B3 filled, B4 hidden but filled, B5 blank, B9 filled: B3 is the run.
		expect(await downTo(cells([2, 1], [3, 1], [8, 1]), at(1, 0), new Set([3]))).toBe(2)
	})

	it("falls back to the column right of the selection when the left one is blank below it", async () => {
		const filled = cells([2, 2], [3, 2], [4, 2], [9, 2])

		expect(await downTo(filled, at(1, 1))).toBe(4)
		expect(await downTo(cells([2, 2], [9, 2]), at(1, 1))).toBe(2)
	})

	it("fills nothing when there is no data beside the selection or the selection is on the last row", async () => {
		expect(await downTo(cells([9, 1]), at(1, 0))).toBeNull()
		expect(await downTo(cells([SHEET_MAX_ROWS - 1, 1]), at(SHEET_MAX_ROWS - 1, 0))).toBeNull()
	})

	it("fills one row when the filled cell below is on the sheet's last row", async () => {
		const filled = cells([SHEET_MAX_ROWS - 1, 1])

		expect(await downTo(filled, at(SHEET_MAX_ROWS - 2, 0))).toBe(SHEET_MAX_ROWS - 1)
	})

	it("asks no navigate query for a lone filled cell", async () => {
		const { session, queries } = fakeSession(cells([2, 1], [19, 1]), new Set())

		await fillDownTo(session, 0, at(1, 0), rowsAxis(new Set()))

		expect(queries).toEqual(["cell", "cell"])
	})
})
