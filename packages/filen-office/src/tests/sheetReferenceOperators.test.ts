import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula, engineFormula } from "../core/sheet/refs/formulaRefs"

// The reference operators "," (union) and " " (intersection) as support.microsoft.com "Calculation operators and
// precedence in Excel" defines them: an intersection gives the cells both references hold, #NULL! when none.

type Typed = string | number | null

// The value of each formula cell of one sheet "S" by its A1 name ("!" before an error).
function calculate(rows: Typed[][]): Record<string, unknown> {
	const cells: EngineSheet["rows"] = rows.map(row =>
		row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(cell.slice(1)) ?? "") : cell))
	)
	const engine = new FormulaEngine([{ name: "S", rows: cells, formulas: [] }], [])
	const out: Record<string, unknown> = {}

	try {
		rows.forEach((row, r) =>
			row.forEach((cell, c) => {
				if (typeof cell !== "string" || !cell.startsWith("=")) return

				const result = engine.result(0, r, c)

				out[`${String.fromCharCode(65 + c)}${String(r + 1)}`] = result.error === true ? `!${String(result.value)}` : result.value
			})
		)
	} finally {
		engine.destroy()
	}

	return out
}

// A 3x3 block of 1..9 in A1:C3, the formulas in E1, F1, ...
function overBlock(...formulas: string[]): unknown[] {
	return Object.values(
		calculate([
			[1, 2, 3, null, ...formulas.map(formula => `=${formula}`)],
			[4, 5, 6],
			[7, 8, 9]
		])
	)
}

describe("reference intersection", () => {
	it("gives the cells both references hold", () => {
		expect(overBlock("SUM(A1:B3 B2:C3)", "A1:A3 A2:C2", "SUM(A:A 2:2)", "SUM(S!A1:C1 S!B1:B3)", "SUM(A1:C3 B1:C3 C3)")).toEqual([
			13, 4, 4, 2, 9
		])
	})

	it("gives #NULL! where the references meet nowhere, numbered 1 by ERROR.TYPE", () => {
		expect(overBlock("SUM(A1:A2 C1:C2)", "ERROR.TYPE(A1 B1)", 'IFERROR(A1 C3,"none")', "ISERROR(A1 B2)", "SUM((A1 C3,B1))")).toEqual([
			"!#NULL!",
			1,
			"none",
			true,
			"!#NULL!"
		])
	})

	it("is spelled for the engine as the reference both hold", () => {
		expect(engineFormula("SUM(A1:B3 B2:C4)")).toBe("SUM(B2:B3)")
		expect(engineFormula("A1:A3 A2:B2")).toBe("A2")
		expect(engineFormula("A1:A2 C1:C2")).toBe("FILEN.NULL()")
		// A range alone once intersected: read in the formula's row or column, as any range alone.
		expect(engineCellFormula("A1:B3 A1:B2")).toBe("=FILEN.INTERSECT(A1:B2)")
	})

	it("is left as written where the text cannot tell what it gives", () => {
		for (const formula of ["SUM(Name A1)", "SUM(OFFSET(A1,0,0,2,2) A1)", 'SUM("A1 B1")', "A1 + B1", "SUM(A1, B1)"])
			expect(engineFormula(formula), formula).toBe(formula)

		expect(engineFormula("SUM(S!A1:B2 T!A1)")).toBe("SUM('S'!A1:B2 'T'!A1)")
		expect(engineFormula("SUM(S!A1:B2 A1)")).toBe("SUM('S'!A1:B2 A1)")
		// The range operator binds first: INDEX(…):A1 is the operand, not A1 alone.
		expect(engineFormula("SUM(INDEX(A1:B2,1,1):A1 B1)")).toContain(" B1)")
	})
})

describe("reference union", () => {
	it("is read by the aggregating functions as its references given apart", () => {
		expect(
			overBlock("SUM((A1,B1))", "SUM((A1:A2,C3),B1)", "COUNT(( A1 , B2:C2 ))", "MAX((A1,C3))", "_xlfn.STDEV.S((A1,A2,A3))")
		).toEqual([3, 16, 3, 9, 3])
	})

	it("counts its areas in AREAS", () => {
		expect(overBlock("AREAS((F1,G1))", "AREAS((A1:B2,C3,S!C1))", "AREAS((B2:C3))", "AREAS(A1)")).toEqual([2, 3, 1, 1])
	})

	it("is left as written outside those functions or where it is no union of references", () => {
		for (const formula of [
			"LARGE((A1,B1),1)",
			"INDEX((A1:B2,C3:D4),1,1,2)",
			"(A1,B1)",
			"SUM(IF(1,(A1,B1)))",
			"SUM((A1,B1)*2)",
			"SUM((A1+1,B1))",
			"SUM((Name,B1))",
			"AREAS((A1,B1),2)"
		])
			expect(engineFormula(formula), formula).toBe(formula)
	})
})
