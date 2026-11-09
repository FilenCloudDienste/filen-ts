import { describe, expect, it } from "vitest"
import { FormulaEngine, type RecalculatedCell } from "../core/sheet/formula/index"
import { engineCellFormula, storedFormula } from "../core/sheet/refs/formulaRefs"

// OFFSET with computed arguments (support.microsoft.com "OFFSET function"), a range ending in a function that gives a
// reference (A1:INDEX(A:A,n)), and INDIRECT reading LibreOffice's Calc A1 text in a workbook from an .ods file.

type Typed = string | number | boolean | null

function engineRows(rows: Typed[][]): (string | number | boolean | null)[][] {
	return rows.map(row =>
		row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(storedFormula(cell.slice(1))) ?? "") : cell))
	)
}

function build(rows: Typed[][], calcA1 = false): FormulaEngine {
	return new FormulaEngine(
		[
			{ name: "S", rows: engineRows(rows), formulas: [] },
			{ name: "My Sheet", rows: [[null, 7]], formulas: [] }
		],
		[],
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		calcA1
	)
}

function value(engine: FormulaEngine, a1: string, sheet = 0): unknown {
	const col = a1.charCodeAt(0) - 65
	const row = Number(a1.slice(1)) - 1
	const result = engine.result(sheet, row, col)

	return result.error === true ? `!${String(result.value)}` : result.value
}

function set(engine: FormulaEngine, a1: string, content: Typed): RecalculatedCell[] {
	const [cell] = engineRows([[content]])

	return engine.set(0, [{ row: Number(a1.slice(1)) - 1, col: a1.charCodeAt(0) - 65, content: cell?.[0] ?? null }])
}

describe("OFFSET with computed arguments", () => {
	it("keeps the engine's own OFFSET where every argument is an integer literal", () => {
		expect(engineCellFormula("SUM(OFFSET(A1,0,0,2,1))")).toBe("=SUM(OFFSET(A1,0,0,2,1))")
		expect(engineCellFormula("OFFSET(A1, -1, +2)")).toBe("=OFFSET(A1, -1, +2)")
		expect(engineCellFormula("A1:OFFSET(A1,2,0)")).toBe("=A1:OFFSET(A1,2,0)")
		expect(engineCellFormula("OFFSET(A1,0,B1-1)")).toBe("=FILEN.OFFSET(A1,0,B1-1)")
		expect(engineCellFormula("COUNTA(OFFSET(A1,,,3))")).toBe("=COUNTA(FILEN.OFFSET(A1,,,3))")
		expect(engineCellFormula('"OFFSET(A1,0,B1)"&A1')).toBe('="OFFSET(A1,0,B1)"&A1')
	})

	it("calculates rows, cols, height and width from expressions, omitted ones defaulting", () => {
		// A1:A3 1 2 3, C1 the column count; "OFFSET function": rows and cols may be any expression, height and width
		// default to the reference's own size.
		const engine = build([
			[1, 10, 2, "=OFFSET(A1,0,C1-1)", "=SUM(OFFSET(A1,0,0,C1+1,1))", "=OFFSET(A1,A1,0)", "=ROWS(OFFSET(A1,0,0,C1*2))"],
			[
				2,
				20,
				null,
				"=COUNTA(OFFSET(A1,,,3))",
				"=SUM(OFFSET(A1:B2,1,0))",
				"=SUM(OFFSET($A$1,0,0,COUNTA($A:$A),1))",
				"=OFFSET(A1,C1/2,0)"
			],
			[3, 30, null, "=OFFSET(A1,-1,0)", "=OFFSET(A1,0,0,0)", "=SUM(OFFSET(A1,0,0,,2))", '=OFFSET("A1",0,0)']
		])

		try {
			expect([value(engine, "D1"), value(engine, "E1"), value(engine, "F1"), value(engine, "G1")]).toEqual([10, 6, 2, 4])
			// A2:B3 sums 55; a fraction of a row is cut to a whole one (C1/2 is 1).
			expect([value(engine, "D2"), value(engine, "E2"), value(engine, "F2"), value(engine, "G2")]).toEqual([3, 55, 6, 2])
			// Off the grid or no height: #REF!; an empty height is the reference's; no reference: #VALUE!.
			expect([value(engine, "D3"), value(engine, "E3"), value(engine, "F3"), value(engine, "G3")]).toEqual([
				"!#REF!",
				"!#REF!",
				11,
				"!#VALUE!"
			])
		} finally {
			engine.destroy()
		}
	})

	it("calculates again when an argument or a cell it reaches changes", () => {
		const engine = build([[1, 10, 100, 2, "=OFFSET(A1,0,D1-1)", "=SUM(OFFSET(A1,0,0,1,D1))"]])

		try {
			expect([value(engine, "E1"), value(engine, "F1")]).toEqual([10, 11])
			set(engine, "D1", 3)
			expect([value(engine, "E1"), value(engine, "F1")]).toEqual([100, 111])
			// C1 is read through OFFSET alone: the engine has no link to it.
			set(engine, "C1", 200)
			expect([value(engine, "E1"), value(engine, "F1")]).toEqual([200, 211])
		} finally {
			engine.destroy()
		}
	})

	it("finds its own cell among what it reaches as a circle, and is one area", () => {
		const engine = build([[1, "=SUM(OFFSET(A1,0,0,1,A1+1))", "=AREAS(OFFSET(A1,0,A1-1))", "=AREAS(A1:INDEX(A1:A3,2))"]])

		try {
			expect([value(engine, "B1"), value(engine, "C1"), value(engine, "D1")]).toEqual(["!#CYCLE!", 1, 1])
		} finally {
			engine.destroy()
		}
	})
})

describe("A range ending in a function", () => {
	it("joins the references both ends give", () => {
		const engine = build([
			[1, 2, "=SUM(A1:INDEX(A1:A3,B1))", '=SUM(A1:INDIRECT("A3"))', "=SUM(INDEX(A1:A3,2):A3)", "=SUM(A1:OFFSET(A1,B1,0))"],
			[
				2,
				2,
				"=ROWS(A1:INDEX(A:A,B1))",
				"=SUM(B1:INDEX(A1:A3,3))",
				"=SUM(A1:A2:INDEX(B1:B3,1))",
				"=SUM('My Sheet'!A1:INDEX('My Sheet'!B1:B1,1))"
			],
			[3, 3, null, null, null, null]
		])

		try {
			expect([value(engine, "C1"), value(engine, "D1"), value(engine, "E1"), value(engine, "F1")]).toEqual([3, 6, 5, 6])
			// B1:A3 is A1:B3; A1:A2:B1 is A1:B2.
			expect([value(engine, "C2"), value(engine, "D2"), value(engine, "E2"), value(engine, "F2")]).toEqual([2, 13, 7, 7])
		} finally {
			engine.destroy()
		}
	})

	it("calculates again when an end moves or a cell between them changes", () => {
		const engine = build([[1, 2, "=SUM(A1:INDEX(A1:A3,B1))", '=SUM(A1:INDIRECT("A"&B1))'], [2], [3]])

		try {
			expect([value(engine, "C1"), value(engine, "D1")]).toEqual([3, 3])
			set(engine, "B1", 3)
			expect([value(engine, "C1"), value(engine, "D1")]).toEqual([6, 6])
			// A2 lies between the ends, linked through neither.
			set(engine, "A2", 20)
			expect([value(engine, "C1"), value(engine, "D1")]).toEqual([24, 24])
		} finally {
			engine.destroy()
		}
	})
})

describe("INDIRECT with Calc A1 text", () => {
	it("follows Sheet.A1 and $Sheet.$A$1 in a workbook from an .ods file", () => {
		const engine = build(
			[[null, 9, '=INDIRECT("S.B1")', '=INDIRECT("$S.$B$1")', "=INDIRECT(\"'My Sheet'.B1\")", '=SUM(INDIRECT("S.A1:S.B1"))']],
			true
		)

		try {
			expect([value(engine, "C1"), value(engine, "D1"), value(engine, "E1"), value(engine, "F1")]).toEqual([9, 9, 7, 9])
			set(engine, "B1", 5)
			expect([value(engine, "C1"), value(engine, "D1"), value(engine, "F1")]).toEqual([5, 5, 5])
		} finally {
			engine.destroy()
		}
	})

	it("reads Excel A1 first, and no Calc A1 text in any other workbook", () => {
		const ods = build([[null, 9, '=INDIRECT("S!B1")']], true)
		const xlsx = build([[null, 9, '=INDIRECT("S.B1")', '=INDIRECT("$S.$B$1")']])

		try {
			expect(value(ods, "C1")).toBe(9)
			expect([value(xlsx, "C1"), value(xlsx, "D1")]).toEqual(["!#REF!", "!#REF!"])
		} finally {
			ods.destroy()
			xlsx.destroy()
		}
	})
})
