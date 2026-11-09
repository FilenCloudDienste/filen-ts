import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula } from "../core/sheet/refs/formulaRefs"

type Typed = string | number | boolean | null

// The value of each formula cell of one sheet by its A1 name ("!" before an error's text).
function calculate(rows: Typed[][]): Record<string, unknown> {
	const sheets: EngineSheet[] = [
		{
			name: "S",
			rows: rows.map(row =>
				row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(cell.slice(1)) ?? "") : cell))
			),
			formulas: []
		}
	]
	const engine = new FormulaEngine(sheets, [])
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

// A header, then {apple, banana, cherry, TRUE, 5, Zed} with 1..6 beside them; a DCOUNTA criteria block in C1:C2.
const DATA: Typed[][] = [
	["Fruit", "N", "Fruit"],
	["apple", 1, ">b"],
	["banana", 2],
	["cherry", 3],
	[true, 4],
	[5, 5],
	["Zed", 6]
]

function withFormulas(formulas: string[]): Typed[][] {
	return [...DATA, ...formulas.map(formula => [null, null, null, formula])]
}

describe("criteria comparing text", () => {
	// Comparison operators compare text with text, without case; numbers, booleans and empty cells never match
	// (support.microsoft.com "COUNTIF function"; OpenDocument part 4, 4.11.8 and 6.4.9).
	it("count, sum and average the text cells the comparison holds for", () => {
		expect(
			calculate(
				withFormulas([
					'=COUNTIF(A2:A7,">b")',
					'=COUNTIF(A2:A7,"<c")',
					'=COUNTIF(A2:A7,">B")',
					'=COUNTIF(A2:A7,">=banana")',
					'=COUNTIF(A2:A7,"<=APPLE")',
					'=COUNTIF(A:A,"<c")',
					'=SUMIF(A2:A7,">b",B2:B7)',
					'=COUNTIFS(A2:A7,">b",B2:B7,"<6")',
					'=AVERAGEIFS(B2:B7,A2:A7,"<c")',
					"=DCOUNTA(A1:B7,B1,C1:C2)",
					'=COUNTIF(A2:A7,">b*")'
				])
			)
		).toEqual({
			D8: 3,
			D9: 2,
			D10: 3,
			D11: 3,
			D12: 1,
			D13: 2,
			D14: 11,
			D15: 2,
			D16: 1.5,
			D17: 3,
			// A wildcard is a literal character in a comparison: "banana", "cherry" and "Zed" sort after "b*".
			D18: 3
		})
	})

	it("reads an operator after the start as text to equal", () => {
		expect(calculate([["a>b", 5, "x=5", "x=5", '=COUNTIF(A1:D1,"a>b")', '=COUNTIF(A1:D1,"x=5")', '=COUNTIF(A1:D1,"a>*")']])).toEqual({
			E1: 1,
			F1: 2,
			G1: 1
		})
	})

	it("keeps an empty operand, numbers and booleans as they were", () => {
		expect(
			calculate(withFormulas(['=COUNTIF(A2:A7,">")', '=COUNTIF(A2:A7,">4")', "=COUNTIF(A2:A7,TRUE)", '=COUNTIF(A2:A7,"<>b*")']))
		).toEqual({ D8: 0, D9: 1, D10: 1, D11: 5 })
	})
})
