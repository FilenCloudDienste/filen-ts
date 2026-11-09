import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineIteration, type EngineSheet } from "../core/sheet/formula/index"

// Circular references as Excel calculates them: iterated under calcPr iterate (iterateCount, iterateDelta), else 0
// with what reads them calculated from that, and reported ("Remove or allow a circular reference").

const ITERATE: EngineIteration = { count: 100, delta: 0.001 }

function engineOf(
	rows: EngineSheet["rows"],
	options: { iteration?: EngineIteration; formulas?: EngineSheet["formulas"]; held?: boolean } = {}
) {
	return new FormulaEngine(
		[{ name: "S", rows, formulas: options.formulas ?? [] }],
		[],
		false,
		options.held === true ? () => undefined : undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		options.iteration ?? null
	)
}

function value(engine: FormulaEngine, row: number, col: number): unknown {
	return engine.result(0, row, col).value
}

describe("circular references, not iterating", () => {
	it("shows 0 on the circle, calculates what reads it from that, and reports its first cell once", () => {
		const engine = engineOf([["=B1+1", "=A1", "=A1+5"]])

		try {
			expect([value(engine, 0, 0), value(engine, 0, 1), value(engine, 0, 2)]).toEqual([0, 0, 5])
			expect(engine.circularChange(0)).toEqual({ version: 1, cells: [{ sheet: 0, row: 0, col: 0 }], introduced: true })
			expect(engine.circularChange(1)).toBeNull()
		} finally {
			engine.destroy()
		}
	})

	it("reports a circle an edit closes, and none once an edit breaks it", () => {
		const engine = engineOf([[1, "=A1*2", "=B1+1"]])

		try {
			expect(engine.circularChange(0)).toBeNull()

			const closed = engine.set(0, [{ row: 0, col: 0, content: "=C1" }])

			expect(closed.find(cell => cell.col === 2)?.value).toBe(0)
			expect(closed.some(cell => cell.error === true)).toBe(false)

			const found = engine.circularChange(0)

			expect(found?.cells).toEqual([{ sheet: 0, row: 0, col: 0 }])
			expect(found?.introduced).toBe(true)

			// Recalculated again (a precedent of the circle edited), it is no new circle.
			engine.set(0, [{ row: 1, col: 0, content: "=C1" }])
			expect(engine.circularChange(found?.version ?? 0)?.introduced ?? false).toBe(false)

			engine.set(0, [{ row: 0, col: 0, content: 4 }])
			expect(engine.circularChange(found?.version ?? 0)).toMatchObject({ cells: [], introduced: false })
			expect([value(engine, 0, 1), value(engine, 0, 2)]).toEqual([8, 9])
		} finally {
			engine.destroy()
		}
	})

	it("keeps the stored results of a circle the file holds, still reported as one", () => {
		const engine = engineOf([["=B1", "=A1", "=A1+1"]], {
			held: true,
			formulas: [
				{ row: 0, col: 0, content: "=B1", fallback: 7 },
				{ row: 0, col: 1, content: "=A1", fallback: 7 }
			]
		})

		try {
			expect([value(engine, 0, 0), value(engine, 0, 1), value(engine, 0, 2)]).toEqual([7, 7, 8])
			expect(engine.circularChange(0)?.cells).toEqual([{ sheet: 0, row: 0, col: 0 }])
		} finally {
			engine.destroy()
		}
	})

	it("costs a workbook without circles nothing to report", () => {
		const engine = engineOf([[1, "=A1+1"]])

		try {
			engine.set(0, [{ row: 0, col: 0, content: 2 }])
			expect(engine.circularChange(0)).toBeNull()
		} finally {
			engine.destroy()
		}
	})
})

describe("iterative calculation", () => {
	it("iterates a formula reading its own cell iterateCount times", () => {
		const engine = engineOf([[null]], { iteration: ITERATE })

		try {
			expect(engine.set(0, [{ row: 0, col: 0, content: "=A1+1" }]).find(cell => cell.col === 0)?.value).toBe(100)
		} finally {
			engine.destroy()
		}

		const ten = engineOf([[null, 1]], { iteration: { count: 10, delta: 0.001 } })

		try {
			ten.set(0, [{ row: 0, col: 0, content: "=A1+B1" }])
			expect(value(ten, 0, 0)).toBe(10)
			// Each recalculation goes on from where the last one ended.
			ten.set(0, [{ row: 0, col: 1, content: 2 }])
			expect(value(ten, 0, 0)).toBe(30)
		} finally {
			ten.destroy()
		}
	})

	it("stops once no value changes by iterateDelta", () => {
		// A1 = A1 / 2 + 1 settles at 2, the change halving each iteration.
		const coarse = engineOf([["=B1/2+1", "=A1", "=A1*10"]], { iteration: ITERATE })
		const fine = engineOf([["=B1/2+1", "=A1", "=A1*10"]], { iteration: { count: 100, delta: 0 } })

		try {
			const a = value(coarse, 0, 0) as number

			expect(a).not.toBe(2)
			expect(Math.abs(a - 2)).toBeLessThan(0.002)
			expect(value(coarse, 0, 2)).toBeCloseTo(a * 10, 10)
			expect(value(fine, 0, 0)).toBe(2)
			// Excel reports no circle while it iterates.
			expect(coarse.circularChange(0)).toBeNull()
		} finally {
			coarse.destroy()
			fine.destroy()
		}
	})

	it("keeps the results the file stored on open, and goes on from them when an edit reaches the circle", () => {
		const engine = engineOf([["=A1+B1", 1]], { iteration: ITERATE, formulas: [{ row: 0, col: 0, content: "=A1+B1", fallback: 50 }] })

		try {
			expect(value(engine, 0, 0)).toBe(50)
			engine.set(0, [{ row: 0, col: 1, content: 2 }])
			expect(value(engine, 0, 0)).toBe(250)
		} finally {
			engine.destroy()
		}

		const again = new FormulaEngine(
			[{ name: "S", rows: [["=A1+1"]], formulas: [{ row: 0, col: 0, content: "=A1+1", fallback: 5 }] }],
			[],
			false,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ ...ITERATE, recalculateOnLoad: true }
		)

		try {
			expect(value(again, 0, 0)).toBe(105)
		} finally {
			again.destroy()
		}
	})

	it("iterates a circle through a range", () => {
		const engine = engineOf([[1], [2], ["=SUM(A1:A3)/2"]], { iteration: { count: 100, delta: 0 } })

		try {
			// A3 = (3 + A3) / 2 settles at 3.
			expect(value(engine, 2, 0)).toBe(3)
		} finally {
			engine.destroy()
		}
	})
})
