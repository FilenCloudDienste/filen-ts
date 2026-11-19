import { describe, expect, it } from "vitest"
import { CellKind, RowFlag } from "../core/xlsx/model/types"
import { BLOCK_ROWS, SheetStore, StoreBuilder } from "../core/xlsx/read/index"
import { FormulaTable } from "../core/xlsx/model/formulas"
import { SheetStrings } from "../core/xlsx/model/strings"
import { rowState } from "../core/xlsx/edit/history"

// Rows and cells set many at a time (a format on whole rows or a long column, a resize of many): the same as one
// setRow or setCell each, with each block rebuilt once.

function storeOf(rows: number, firstRow: number): SheetStore {
	const builder = new StoreBuilder()

	for (let row = firstRow; row < firstRow + rows; row++) {
		builder.beginRow()
		builder.cell(0, CellKind.NUMBER, row, 0, -1)
		builder.endRow(row, 0, 0, 0, Number.NaN, -1)
	}

	return new SheetStore(builder.finish(), new SheetStrings(), new FormulaTable())
}

describe("setting many rows' properties", () => {
	it("gives every row what one setRow per row gives it, across blocks and before the first", () => {
		const one = storeOf(5000, 100)
		const many = storeOf(5000, 100)
		// Rows before the sheet's first, inside blocks, between them and past the last, out of order.
		const rows = [...Array.from({ length: 1500 }, (_, k) => 7 + k * 4), ...Array.from({ length: 50 }, (_, k) => 9000 + k), 3, 40].map(
			(row, k) => ({ row, height: 12 + (k % 5), style: k % 3, flags: RowFlag.CUSTOM_FORMAT | RowFlag.CUSTOM_HEIGHT })
		)

		for (const { row, height, style, flags } of rows) one.setRow(row, height, style, flags)

		many.setRows(rows)

		for (const row of [3, 7, 40, 101, 103, 4003, 5099, 6000, 9000, 9049, 9050]) expect(rowState(many, row)).toEqual(rowState(one, row))

		expect(many.blocks.every(block => block.rowCount <= BLOCK_ROWS)).toBe(true)
		// The cells stay where they were.
		expect(many.value(many.locate(4321, 0))).toBe(4321)
	})
})

describe("setting existing rows' properties", () => {
	const props = (rows: readonly number[], flags = RowFlag.HIDDEN): { row: number; height: number; style: number; flags: number }[] =>
		rows.map(row => ({ row, height: 20, style: 1, flags }))

	it("writes them in place: the cells keep their arrays, the rows get what setRow gives them", () => {
		const one = storeOf(3000, 0)
		const many = storeOf(3000, 0)
		const block = many.blocks[1]!
		const arrays = [block.cols, block.kinds, block.values, block.styles]
		const rows = Array.from({ length: 900 }, (_, k) => 1024 + k)
		const version = many.version

		for (const { row, height, style, flags } of props(rows)) one.setRow(row, height, style, flags)

		many.setRows(props(rows))

		expect(many.blocks[1]).toBe(block)
		expect([block.cols, block.kinds, block.values, block.styles]).toEqual(arrays)
		arrays.forEach((array, k) => expect([block.cols, block.kinds, block.values, block.styles][k]).toBe(array))
		expect(many.version).toBeGreaterThan(version)

		for (const row of [1023, 1024, 1500, 1923, 1924]) expect(rowState(many, row)).toEqual(rowState(one, row))
	})

	it("copies a block an undo snapshot holds rather than changing it", () => {
		const store = storeOf(10, 0)
		const block = store.blocks[0]!
		const before = block.rowFlags.slice()

		store.held.add(block)
		store.setRows(props([2, 3]))

		expect(store.blocks[0]).not.toBe(block)
		expect(block.rowFlags).toEqual(before)
		expect((store.blocks[0]!.rowFlags[2] ?? 0) & RowFlag.HIDDEN).toBe(RowFlag.HIDDEN)
		expect(store.blocks[0]!.values).toEqual(block.values)
	})

	it("drops a row left vacant and adds a missing one, as setRow does", () => {
		const one = storeOf(10, 0)
		const many = storeOf(10, 0)

		for (const store of [one, many]) store.setRow(20, 15, -1, RowFlag.CUSTOM_HEIGHT)

		const bare = { row: 20, height: Number.NaN, style: -1, flags: 0 }
		const added = { row: 30, height: 18, style: -1, flags: RowFlag.CUSTOM_HEIGHT }

		one.setRow(bare.row, bare.height, bare.style, bare.flags)
		one.setRow(added.row, added.height, added.style, added.flags)
		many.setRows([bare, added])

		for (const row of [5, 20, 30]) expect(rowState(many, row)).toEqual(rowState(one, row))
		expect(many.blocks.reduce((sum, block) => sum + block.rowCount, 0)).toBe(one.blocks.reduce((sum, block) => sum + block.rowCount, 0))
	})
})

describe("setting many cells", () => {
	it("writes what one setCell per cell writes: in place, added, removed, in new rows and blocks", () => {
		const one = storeOf(3000, 100)
		const many = storeOf(3000, 100)
		const writes = [
			// In place, a style only.
			...Array.from({ length: 300 }, (_, k) => ({
				row: 100 + k * 7,
				col: 0,
				kind: CellKind.NUMBER,
				value: 100 + k * 7,
				style: 2,
				formula: -1,
				origin: -1
			})),
			// Added beside existing cells, and in rows the sheet does not have, before, between and after its rows.
			...Array.from({ length: 2000 }, (_, k) => ({
				row: 100 + k,
				col: 3,
				kind: CellKind.EMPTY,
				value: 0,
				style: 1,
				formula: -1,
				origin: -1
			})),
			...[2, 50, 4000, 70_000].map(row => ({ row, col: 5, kind: CellKind.EMPTY, value: 0, style: 1, formula: -1, origin: -1 })),
			// Removed: content gone and the default format.
			...Array.from({ length: 50 }, (_, k) => ({
				row: 2500 + k,
				col: 0,
				kind: CellKind.EMPTY,
				value: 0,
				style: 0,
				formula: -1,
				origin: -1
			}))
		]

		for (const { row, col, kind, value, style, formula, origin } of writes) one.setCell(row, col, kind, value, style, formula, origin)

		many.setCells(writes)

		expect(many.cellCount).toBe(one.cellCount)

		for (const row of [2, 50, 99, 100, 107, 2099, 2100, 2549, 2550, 3099, 4000, 70_000]) {
			for (const col of [0, 3, 5]) {
				const a = one.locate(row, col)
				const b = many.locate(row, col)

				expect(b < 0).toBe(a < 0)

				if (a >= 0) expect([many.style(b), many.value(b), many.kind(b)]).toEqual([one.style(a), one.value(a), one.kind(a)])
			}
		}

		expect(many.blocks.every(block => block.rowCount <= BLOCK_ROWS)).toBe(true)
	})
})
