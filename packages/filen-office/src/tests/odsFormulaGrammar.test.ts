import { describe, expect, it } from "vitest"
import { translateFormula } from "../core/ods/formula/toXlsx"
import { FormulaEngine } from "../core/sheet/formula/index"
import { engineCellFormula, wellFormedFormula } from "../core/sheet/refs/formulaRefs"
import { rng as generator } from "./mulberry32"

// Every OpenFormula the translation gives text for is in the store's grammar; anything else is refused.

// Pieces of OpenFormula (ODF 1.3 Part 4 §5), well and badly placed.
const PIECES = [
	"[.A1]",
	"[.B2]",
	"[.A1:.C3]",
	"['S 2'.D4]",
	"[.#REF!]",
	"1",
	"2.5",
	"-",
	"+",
	"*",
	"/",
	"^",
	"&",
	"=",
	"<>",
	"<=",
	"%",
	"~",
	"!",
	":",
	";",
	"(",
	")",
	" ",
	'"a;b"',
	"{1;2|3;4}",
	"#N/A",
	"TRUE()",
	"MyName",
	"SUM(",
	"IF(",
	"CEILING(",
	"FLOOR(",
	"RAND()"
]

describe("OpenFormula translation's grammar", () => {
	it("gives text in the store's grammar for every formula it does not refuse", () => {
		const next = generator(0x5eed)
		const malformed: string[] = []
		let translated = 0

		for (let k = 0; k < 40_000; k++) {
			const length = 1 + Math.floor(next() * 9)
			let source = ""

			for (let p = 0; p < length; p++) source += PIECES[Math.floor(next() * PIECES.length)] ?? ""

			// Balanced most of the time, so the operators meet inside calls as well as outside.
			const open = (source.match(/\(/g) ?? []).length - (source.match(/\)/g) ?? []).length

			if (open > 0 && next() < 0.8) source += ")".repeat(open)

			const result = translateFormula(`of:=${source}`)

			if ("refused" in result) continue

			translated++

			if (!wellFormedFormula(result.text)) malformed.push(`${source} => ${result.text}`)
		}

		expect(malformed.slice(0, 10)).toEqual([])
		expect(translated).toBeGreaterThan(1_000)
	})

	it("calculates CEILING and FLOOR as LibreOffice 7.5 does, its Err:502 as #VALUE! (§6.17.1, §6.17.3)", () => {
		// LibreOffice 7.5 headless over the same cells (A1 #N/A, B1 #DIV/0!, C1 -2, D1 "abc", E1 TRUE); its xlsx export
		// writes Err:502 as #VALUE!.
		const cases: [string, number | string][] = [
			["CEILING(2.5;-2)", "#VALUE!"],
			["FLOOR(-2.5;2)", "#VALUE!"],
			["CEILING(-2.5;2;1)", "#VALUE!"],
			["CEILING(-2.5;2)", "#VALUE!"],
			["FLOOR(2.5;-2;1)", "#VALUE!"],
			["CEILING(0;-2)", 0],
			["CEILING(2.5;0)", 0],
			["CEILING(-2.5;;1)", -3],
			["CEILING(-2.5)", -2],
			["FLOOR(-2.5;;1)", -2],
			["FLOOR(2.5;;1)", 2],
			["FLOOR(-2.5; )", -3],
			["CEILING(-2.5;;0)", -2],
			["CEILING(-2.5;-2;1)", -4],
			["FLOOR(-2.5;-2;1)", -2],
			["FLOOR(-2.5;-2)", -4],
			["CEILING([.A1];[.B1])", "#N/A"],
			["CEILING([.A1];2;[.B1])", "#N/A"],
			["CEILING(2.5;-2;[.A1])", "#N/A"],
			["CEILING(2.5;[.C1];[.D1])", "#VALUE!"],
			["CEILING(2.5;[.Z9])", 0],
			["CEILING([.Z9];-2)", 0],
			["CEILING(2.5;[.D1])", "#VALUE!"],
			["CEILING(2.5;[.C1];[.E1])", "#VALUE!"],
			["FLOOR([.B1];[.A1])", "#DIV/0!"],
			["CEILING(-2.5;[.C1];[.D1])", "#VALUE!"],
			["CEILING(2.5;-2;[.D1])", "#VALUE!"],
			["CEILING(-2.5;[.C1])", -2],
			["CEILING([.C1]*1.25;2)", "#VALUE!"],
			["CEILING([.C1]*-1.25;2)", 4],
			["FLOOR(-[.C1]*1.25;-2;1)", "#VALUE!"]
		]
		const formulas = cases.map(([source]) => {
			const result = translateFormula(`of:=${source}`)

			if ("refused" in result) throw new Error(`${source}: ${result.refused}`)

			// As a session gives the engine a cell's formula.
			return engineCellFormula(result.text) ?? `unreadable ${result.text}`
		})
		const engine = new FormulaEngine(
			[{ name: "S", rows: [["=NA()", "=1/0", -2, "abc", true], ...formulas.map(formula => [formula])], formulas: [] }],
			[]
		)

		try {
			expect(cases.map(([source], k) => [source, engine.result(0, k + 1, 0).value])).toEqual(
				cases.map(([source, value]) => [source, value])
			)
		} finally {
			engine.destroy()
		}
	})
})
