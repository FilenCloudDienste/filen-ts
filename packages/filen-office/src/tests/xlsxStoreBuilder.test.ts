import { describe, expect, it } from "vitest"
import { CellKind, NO_SPAN, RowFlag, blockOrigin } from "../core/xlsx/model/types"
import { SheetStore, StoreBuilder, type RowBlock } from "../core/xlsx/read/index"
import { FormulaTable } from "../core/xlsx/model/formulas"
import { SheetStrings } from "../core/xlsx/model/strings"
import { budget, cpuMs } from "./timing"

// The store as a sheet is read into it: rows out of order sorted, repeated rows merged, in steps a host can slice
// (no step holds the thread for long), and a row of repeated cells never outgrows the builder.

// Drives finishSteps, returning the blocks and the longest stretch between two yields, in ms.
function finishTimed(builder: StoreBuilder): { blocks: RowBlock[]; longest: number } {
	const steps = builder.finishSteps()
	let longest = 0

	for (;;) {
		const started = cpuMs()
		const step = steps.next()

		longest = Math.max(longest, cpuMs() - started)

		if (step.done === true) return { blocks: step.value, longest }
	}
}

function rowCells(block: RowBlock, index: number): number[][] {
	const out: number[][] = []

	for (let k = block.rowStarts[index] ?? 0; k < (block.rowStarts[index + 1] ?? 0); k++) {
		out.push([block.cols[k] ?? 0, block.values[k] ?? 0, blockOrigin(block, index, k)])
	}

	return out
}

describe("the store builder", () => {
	it("merges 30 copies of a 16,384-cell row in short steps, the last written cell winning", () => {
		const builder = new StoreBuilder()

		for (let copy = 0; copy < 30; copy++) {
			builder.beginRow()

			for (let col = 0; col < 16_384; col++) builder.cell(col, CellKind.NUMBER, copy, 0, -1)

			builder.endRow(0, copy * 100, copy * 100 + 50, 0, Number.NaN, -1)
		}

		const { blocks, longest } = finishTimed(builder)
		const block = blocks[0]!

		expect(blocks).toHaveLength(1)
		expect(block.rowCount).toBe(1)
		expect(block.cellCount).toBe(16_384)
		expect(Array.from(new Set(block.values))).toEqual([29])
		expect([block.rowSpans[0], block.rowSpans[1]]).toEqual([NO_SPAN, NO_SPAN])
		expect((block.rowFlags[0] ?? 0) & (RowFlag.DIRTY | RowFlag.NEW)).toBe(RowFlag.DIRTY | RowFlag.NEW)
		expect(builder.totalCells).toBe(16_384)
		expect(longest).toBeLessThan(budget(50))
	})

	it("sorts 200,000 rows written in descending order in short steps, each keeping its span and cells", () => {
		const builder = new StoreBuilder()
		const rows = 200_000

		for (let row = rows - 1; row >= 0; row--) {
			builder.beginRow()

			for (let col = 0; col < 5; col++) builder.cell(col, CellKind.NUMBER, row * 10 + col, 0, -1)

			builder.endRow(row, row * 64, row * 64 + 60, 0, Number.NaN, -1)
		}

		const { blocks, longest } = finishTimed(builder)
		let expected = 0

		for (const block of blocks) {
			for (let i = 0; i < block.rowCount; i++, expected++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				if (row !== expected || block.rowSpans[i * 2] !== row * 64 || (block.values[block.rowStarts[i] ?? 0] ?? 0) !== row * 10) {
					throw new Error(`row ${expected} read back as ${row}`)
				}
			}

			expect(block.origins).toBeNull()
		}

		expect(expected).toBe(rows)
		expect(longest).toBeLessThan(budget(50))
	})

	it("folds a row of more repeated cells than its scratch holds, keeping each cell's source position", () => {
		const builder = new StoreBuilder()

		builder.beginRow()

		for (let k = 0; k < 60_000; k++) builder.cell(k % 10, CellKind.NUMBER, k, 0, -1)

		builder.endRow(0, 0, 10, 0, Number.NaN, -1)
		builder.beginRow()
		builder.cell(3, CellKind.NUMBER, 7, 0, -1)
		builder.endRow(1, 20, 30, 0, Number.NaN, -1)

		const blocks = builder.finish()
		const block = blocks[0]!

		expect(rowCells(block, 0)).toEqual(Array.from({ length: 10 }, (_, col) => [col, 59_990 + col, 59_991 + col]))
		expect((block.rowFlags[0] ?? 0) & RowFlag.DIRTY).toBe(RowFlag.DIRTY)
		expect(rowCells(block, 1)).toEqual([[3, 7, 1]])
		expect(builder.totalCells).toBe(11)
	})
})

describe("the store builder, a row out of order first in a new block", () => {
	// Rows 0..count-1 of `cols` cells each, then `last` once more with a cell of its own (value -1, column `cols`).
	function storeWith(count: number, cols: number, last: number): SheetStore {
		const builder = new StoreBuilder()

		for (let row = 0; row < count; row++) {
			builder.beginRow()

			for (let col = 0; col < cols; col++) builder.cell(col, CellKind.NUMBER, row, 0, -1)

			builder.endRow(row, 0, 0, 0, Number.NaN, -1)
		}

		builder.beginRow()
		builder.cell(cols, CellKind.NUMBER, -1, 0, -1)
		builder.endRow(last, 0, 0, 0, Number.NaN, -1)

		return new SheetStore(builder.finish(), new SheetStrings(), new FormulaTable())
	}

	for (const [cut, count, cols] of [
		["1,024 rows", 1024, 1],
		["32,768 cells", 32, 1024]
	] as const)
		for (const last of [count - 1, count - 5])
			it(`orders the blocks and finds every cell after a cut at ${cut}, the next row ${last === count - 1 ? "repeated" : "lower"}`, () => {
				const store = storeWith(count, cols, last)

				for (let b = 1; b < store.blocks.length; b++)
					expect(store.blocks[b]!.firstRow).toBeGreaterThan(store.blocks[b - 1]!.lastRow)

				for (let row = 0; row < count; row++) expect(store.value(store.locate(row, 0))).toBe(row)

				expect(store.value(store.locate(last, cols))).toBe(-1)
			})
})

describe("the store", () => {
	it("keeps a cell put back as it was, its source cell with it, and removes one cleared", () => {
		const builder = new StoreBuilder()

		builder.beginRow()
		builder.cell(1, CellKind.NUMBER, 1, 0, -1)
		builder.cell(2, CellKind.EMPTY, 0, 0, -1)
		builder.endRow(2, 0, 40, 0, Number.NaN, -1)

		const store = new SheetStore(builder.finish(), new SheetStrings(), new FormulaTable())

		store.setCell(2, 2, CellKind.EMPTY, 0, 1, -1)
		store.setCell(2, 2, CellKind.EMPTY, 0, 0, -1, 2)

		expect(store.locate(2, 2)).toBeGreaterThanOrEqual(0)
		expect(rowCells(store.blocks[0]!, 0)).toEqual([
			[1, 1, 1],
			[2, 0, 2]
		])

		store.setCell(2, 2, CellKind.EMPTY, 0, 0, -1)

		expect(store.locate(2, 2)).toBe(-1)
		expect(store.origin(store.locate(2, 1))).toBe(1)

		// Put back as it was: the same source cell again.
		store.setCell(2, 2, CellKind.EMPTY, 0, 0, -1, 2)
		store.setCell(2, 0, CellKind.NUMBER, 3, 0, -1)

		expect(rowCells(store.blocks[0]!, 0)).toEqual([
			[0, 3, 0],
			[1, 1, 1],
			[2, 0, 2]
		])
		expect(store.origin(store.locate(2, 2))).toBe(2)
	})
})
