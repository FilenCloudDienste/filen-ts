import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { formulaTranslator, shiftFormula } from "../core/sheet/refs/formulaRefs"
import { FormulaShift } from "../core/xlsx/refs/formulas"

// 3-D references (Jan:Mar!A1) moved as Excel moves them: by copy and fill like any reference, and by rows or columns
// inserted or deleted only when the edit is on every sheet they span, which an edit on one sheet is only for a span of
// that sheet alone.

function sheet(name: string, rows: EngineSheet["rows"]): EngineSheet {
	return { name, rows, formulas: [] }
}

describe("copy and fill", () => {
	it("move a 3-D reference's cells and keep its sheets", () => {
		expect(formulaTranslator("SUM(Jan:Mar!A1)")(1, 1)).toBe("SUM(Jan:Mar!B2)")
		expect(formulaTranslator("SUM('Jan 1:Mar'!A1:B2)")(2, 0)).toBe("SUM('Jan 1:Mar'!A3:B4)")
		expect(formulaTranslator("SUM(Jan:Mar!$A$1,Jan:Mar!A$1)")(3, 3)).toBe("SUM(Jan:Mar!$A$1,Jan:Mar!D$1)")
		expect(formulaTranslator("SUM(Jan:Mar!A2)")(-2, 0)).toBe("SUM(Jan:Mar!#REF!)")
	})
})

describe("rows and columns inserted or deleted", () => {
	it("leave a 3-D reference spanning other sheets as written", () => {
		expect(shiftFormula("SUM(Jan:Mar!A5)", "Sum", "Feb", { type: "insert", axis: "rows", at: 2, count: 1 }).formula).toBe(
			"SUM(Jan:Mar!A5)"
		)
		expect(shiftFormula("SUM(Jan:Mar!A5)", "Jan", "Jan", { type: "delete", axis: "rows", at: 4, count: 1 })).toEqual({
			formula: "SUM(Jan:Mar!A5)",
			cut: false
		})
	})

	it("move one spanning the edited sheet alone", () => {
		expect(shiftFormula("SUM(Jan:Jan!A5)+Jan!B5", "Sum", "Jan", { type: "insert", axis: "rows", at: 2, count: 1 }).formula).toBe(
			"SUM(Jan:Jan!A6)+Jan!B6"
		)
		expect(shiftFormula("SUM(jan:JAN!C1)", "Sum", "Jan", { type: "delete", axis: "cols", at: 0, count: 1 }).formula).toBe(
			"SUM(jan:JAN!B1)"
		)
		expect(shiftFormula("SUM(Jan:Jan!A5)", "Sum", "Jan", { type: "delete", axis: "rows", at: 4, count: 1 })).toEqual({
			formula: "SUM(Jan:Jan!#REF!)",
			cut: true
		})
	})

	it("in a band move one spanning the edited sheet alone", () => {
		const shift = new FormulaShift({
			kind: "axis",
			target: "Data",
			shift: { type: "insert", axis: "rows", at: 1, count: 1, band: { start: 0, end: 2 } }
		})

		expect(shift.shift("SUM(Data:Data!A3)+SUM(Data:Other!A3)", "Other")).toBe("SUM(Data:Data!A4)+SUM(Data:Other!A3)")
	})
})

describe("the engine, rows or columns of one spanned sheet moved", () => {
	function engineOf(): FormulaEngine {
		return new FormulaEngine(
			[
				sheet("Jan", [[1], [10]]),
				sheet("Feb", [[2], [20]]),
				sheet("Mar", [[3], [30]]),
				sheet("Sum", [["=SUM(Jan:Mar!A1)", "=SUM(Jan:Mar!A2)+Feb!A2"]])
			],
			[],
			false,
			() => undefined
		)
	}

	it("reads the same cell on every sheet after an insert, as Excel does", () => {
		const engine = engineOf()

		try {
			engine.insert(1, "rows", 0, 1)

			// Feb!A1 is the new empty row; Feb!A2 its old A1. The plain Feb!A2 moved to Feb!A3.
			expect(engine.result(3, 0, 0)).toEqual({ value: 4 })
			expect(engine.result(3, 0, 1)).toEqual({ value: 42 + 20 })
		} finally {
			engine.destroy()
		}
	})

	it("reads the same cell on every sheet after a deletion, not #REF!", () => {
		const engine = engineOf()

		try {
			engine.remove(1, "rows", 0, 1)

			expect(engine.result(3, 0, 0)).toEqual({ value: 1 + 20 + 3 })
			expect(engine.result(3, 0, 1)).toEqual({ value: 10 + 30 + 20 })
		} finally {
			engine.destroy()
		}
	})

	it("moves a formula on the edited sheet with its own references", () => {
		const engine = new FormulaEngine(
			[sheet("Jan", [[1], [10]]), sheet("Feb", [[2, "=SUM(Jan:Feb!A2)+A2"], [20]])],
			[],
			false,
			() => undefined
		)

		try {
			engine.insert(1, "rows", 0, 1)

			// The formula is at B2 now: A2 of each sheet (Jan 10, Feb 2) and its own A3 (20).
			expect(engine.result(1, 1, 1)).toEqual({ value: 32 })
		} finally {
			engine.destroy()
		}
	})

	it("follows a written formula, a renamed sheet, and leaves a cell written over", () => {
		const engine = engineOf()

		try {
			engine.set(3, [{ row: 1, col: 0, content: "=MAX(Jan:Feb!A2)" }])
			engine.set(3, [{ row: 0, col: 1, content: 7 }])
			engine.renameSheet(0, "January")
			engine.insert(1, "rows", 0, 1)

			expect(engine.result(3, 0, 0)).toEqual({ value: 4 })
			expect(engine.result(3, 1, 0)).toEqual({ value: 10 })
			expect(engine.result(3, 0, 1)).toEqual({ value: 7 })

			engine.remove(1, "rows", 0, 1)

			expect(engine.result(3, 0, 0)).toEqual({ value: 6 })
			expect(engine.result(3, 1, 0)).toEqual({ value: 20 })
		} finally {
			engine.destroy()
		}
	})
})
