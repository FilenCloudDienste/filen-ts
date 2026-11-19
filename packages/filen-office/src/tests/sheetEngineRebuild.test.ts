import { describe, expect, it } from "vitest"
import { FormulaEngine } from "../core/sheet/formula/index"

// The engine built again with a far cell written (a formula reading a wide whole-column span held): its formulas read
// as before, whatever the sheets are named, and SUBTOTAL leaves out the rows hidden on the sheet it reads.

describe("the engine built again after a cell at the grid's far edge", () => {
	it("keeps formulas naming a sheet whose name needs quotes, and the hidden rows of the sheet SUBTOTAL reads", () => {
		const hidden = (sheet: number, row: number): number => (sheet === 1 && row === 1 ? 1 : 0)
		const engine = new FormulaEngine([{ name: "S", rows: [[null, "=SUM(C:Z)"]], formulas: [] }], [], false, () => undefined, hidden)

		try {
			engine.addSheet("2024")
			engine.set(1, [
				{ row: 0, col: 0, content: 1 },
				{ row: 1, col: 0, content: 2 },
				{ row: 2, col: 0, content: 3 }
			])
			engine.set(0, [
				{ row: 0, col: 0, content: "=SUBTOTAL(109,'2024'!A1:A3)" },
				{ row: 0, col: 2, content: "='2024'!A3*2" }
			])

			expect(engine.result(0, 0, 0)).toEqual({ value: 4 })

			engine.set(0, [{ row: 1_048_575, col: 25, content: 1 }])

			expect(engine.result(0, 0, 0)).toEqual({ value: 4 })
			expect(engine.result(0, 0, 2)).toEqual({ value: 6 })
		} finally {
			engine.destroy()
		}
	})
})

describe("SUBTOTAL calculated again when rows are hidden", () => {
	it.each(["2024", "1st"])("reads a sheet named %s, whose name needs quotes, without an error", name => {
		let hiding = false
		const hidden = (sheet: number, row: number): number => (hiding && sheet === 1 && row === 1 ? 1 : 0)
		const engine = new FormulaEngine(
			[
				{ name: "S", rows: [[`=SUBTOTAL(109,'${name}'!A1:A3)`]], formulas: [] },
				{ name, rows: [[1], [2], [3]], formulas: [] }
			],
			[],
			false,
			() => undefined,
			hidden
		)

		try {
			expect(engine.result(0, 0, 0)).toEqual({ value: 6 })

			hiding = true
			engine.rowsChanged()

			expect(engine.result(0, 0, 0)).toEqual({ value: 4 })

			engine.set(1, [{ row: 0, col: 0, content: 10 }])

			expect(engine.result(0, 0, 0)).toEqual({ value: 13 })

			hiding = false
			engine.rowsChanged()

			expect(engine.result(0, 0, 0)).toEqual({ value: 15 })
		} finally {
			engine.destroy()
		}
	})
})
