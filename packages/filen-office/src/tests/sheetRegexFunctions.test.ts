import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula } from "../core/sheet/refs/formulaRefs"
import { budget } from "./timing"

// REGEXTEST, REGEXEXTRACT and REGEXREPLACE through the engine, against the examples of their pages on
// support.microsoft.com ("REGEXTEST function", "REGEXEXTRACT function", "REGEXREPLACE function"), which use PCRE2.

type Typed = string | number | boolean | null

// Builds an engine over one sheet "S" from cells as typed: "=..." is a formula in Excel's syntax, anything else the
// value. Returns the value of each formula cell by its A1 name ("!" before an error).
function calculate(rows: Typed[][]): Record<string, unknown> {
	const toEngine = (cells: Typed[][]): EngineSheet["rows"] =>
		cells.map(row =>
			row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(cell.slice(1)) ?? "") : cell))
		)
	const engine = new FormulaEngine([{ name: "S", rows: toEngine(rows), formulas: [] }], [])
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

// The result of one formula in A1, whose file stored `stored`.
function heldResult(formula: string, stored: Typed): unknown {
	const content = engineCellFormula(formula) ?? ""
	const engine = new FormulaEngine([{ name: "S", rows: [[content]], formulas: [{ row: 0, col: 0, content, fallback: stored }] }], [])

	try {
		return engine.result(0, 0, 0)
	} finally {
		engine.destroy()
	}
}

const PHONES = [
	"Sonia Rees (378) 555-4195",
	"Angel Brown (878) 555-8622",
	"Blake Martin (437) 555-8987",
	"William Kirby (619) 555-4212",
	"Avery Smith (579) 555-5658",
	"Parker Jones (346) 555-0925",
	"Liam Small (405) 555-0887",
	"Hollie Rees (666) 555-1872"
].join("\n")

describe("REGEXTEST", () => {
	it("tells whether any part of the text matches (the page's examples)", () => {
		expect(
			calculate([
				[
					"alfalfa",
					'=REGEXTEST(A1,"a")',
					'=REGEXTEST(A1,"[a-z]")',
					'=REGEXTEST(A1,"[A-Z]")',
					'=REGEXTEST(A1,"[aeiou]")',
					'=REGEXTEST(A1,"[0-9]")'
				],
				["(378) 555-4195", '=REGEXTEST(A2,"^\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}$")'],
				["+1(878) 555-8622", '=REGEXTEST(A3,"^\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}$")']
			])
		).toEqual({ B1: true, C1: true, D1: false, E1: true, F1: false, B2: true, B3: false })
	})

	it("ignores case for case_sensitivity 1 and rejects any other but 0", () => {
		expect(
			calculate([['=REGEXTEST("ABC","b")', '=REGEXTEST("ABC","b",1)', '=REGEXTEST("ABC","b",0)', '=REGEXTEST("ABC","b",2)']])
		).toEqual({ A1: false, B1: true, C1: false, D1: "!#VALUE!" })
	})

	it("is #VALUE! for a pattern PCRE2 rejects", () => {
		expect(calculate([['=REGEXTEST("a","(a")', '=REGEXTEST("a","a{2,1}")', '=REGEXTEST("a","\\y")']])).toEqual({
			A1: "!#VALUE!",
			B1: "!#VALUE!",
			C1: "!#VALUE!"
		})
	})

	it("reads a number as its text", () => {
		expect(calculate([[123, '=REGEXTEST(A1,"^\\d+$")', '=REGEXTEST(1.5,"\\.")']])).toEqual({ B1: true, C1: true })
	})
})

describe("REGEXEXTRACT", () => {
	it("gives the first match, or every match as an array (the page's examples)", () => {
		expect(
			calculate([
				[
					"DylanWilliams",
					'=REGEXEXTRACT(A1,"[A-Z][a-z]+")',
					'=INDEX(REGEXEXTRACT(A1,"[A-Z][a-z]+",1),1)',
					'=INDEX(REGEXEXTRACT(A1,"[A-Z][a-z]+",1),2)',
					'=ROWS(REGEXEXTRACT(A1,"[A-Z][a-z]+",1))',
					'=COLUMNS(REGEXEXTRACT(A1,"[A-Z][a-z]+",1))'
				],
				[
					PHONES,
					'=ROWS(REGEXEXTRACT(A2,"[0-9()]+ [0-9-]+",1))',
					'=INDEX(REGEXEXTRACT(A2,"[0-9()]+ [0-9-]+",1),1)',
					'=INDEX(REGEXEXTRACT(A2,"[0-9()]+ [0-9-]+",1),8)'
				]
			])
		).toEqual({ B1: "Dylan", C1: "Dylan", D1: "Williams", E1: 2, F1: 1, B2: 8, C2: "(378) 555-4195", D2: "(666) 555-1872" })
	})

	it("gives the first match's capturing groups across a row for return_mode 2", () => {
		expect(
			calculate([
				[
					'=INDEX(REGEXEXTRACT("2024-10-21","(\\d+)-(\\d+)-(\\d+)",2),1,1)',
					'=INDEX(REGEXEXTRACT("2024-10-21","(\\d+)-(\\d+)-(\\d+)",2),1,3)',
					'=COLUMNS(REGEXEXTRACT("2024-10-21","(\\d+)-(\\d+)-(?<d>\\d+)",2))',
					'=ROWS(REGEXEXTRACT("2024-10-21","(\\d+)-(\\d+)-(\\d+)",2))'
				]
			])
		).toEqual({ A1: "2024", B1: "21", C1: 3, D1: 1 })
	})

	it("is #N/A when nothing matches and #VALUE! for a return_mode other than 0, 1 or 2", () => {
		expect(
			calculate([
				[
					'=REGEXEXTRACT("abc","\\d")',
					'=REGEXEXTRACT("abc","\\d",1)',
					'=REGEXEXTRACT("abc","(\\d)",2)',
					'=REGEXEXTRACT("abc","b",3)',
					'=REGEXEXTRACT("abc","b",-1)'
				]
			])
		).toEqual({ A1: "!#N/A", B1: "!#N/A", C1: "!#N/A", D1: "!#VALUE!", E1: "!#VALUE!" })
	})

	it("always gives text, and matches case-insensitively for case_sensitivity 1", () => {
		expect(
			calculate([['=REGEXEXTRACT("Price: 42","\\d+")', "=ISTEXT(A1)", '=REGEXEXTRACT("ABC","b+",0,1)', '=REGEXEXTRACT("x","")']])
		).toEqual({ A1: "42", B1: true, C1: "B", D1: "" })
	})
})

describe("REGEXREPLACE", () => {
	it("replaces every match, with $n for a capturing group (the page's examples)", () => {
		expect(
			calculate([
				[PHONES, '=REGEXREPLACE(A1,"[0-9]+-","***-")'],
				["SoniaBrown", '=REGEXREPLACE(A2,"([A-Z][a-z]+)([A-Z][a-z]+)","$2, $1")']
			])
		).toEqual({ B1: PHONES.replace(/[0-9]+-/g, "***-"), B2: "Brown, Sonia" })
	})

	it("replaces only the occurrence-th match, counting from the end when negative", () => {
		expect(
			calculate([
				[
					'=REGEXREPLACE("a1b2c3","\\d","#",1)',
					'=REGEXREPLACE("a1b2c3","\\d","#",2)',
					'=REGEXREPLACE("a1b2c3","\\d","#",-1)',
					'=REGEXREPLACE("a1b2c3","\\d","#",-3)',
					'=REGEXREPLACE("a1b2c3","\\d","#",4)',
					'=REGEXREPLACE("a1b2c3","\\d","#",-4)',
					'=REGEXREPLACE("a1b2c3","\\d","#")'
				]
			])
		).toEqual({ A1: "a#b2c3", B1: "a1b#c3", C1: "a1b2c#", D1: "a#b2c3", E1: "a1b2c3", F1: "a1b2c3", G1: "a#b#c#" })
	})

	it("reads PCRE2's replacement syntax: $$, ${n}, $name and ${name}; anything else after $ is #VALUE!", () => {
		expect(
			calculate([
				[
					'=REGEXREPLACE("ab","(?<x>a)(b)","${2}$$${x}$x$0")',
					'=REGEXREPLACE("ab","(a)","$2")',
					'=REGEXREPLACE("ab","(a)","$y")',
					'=REGEXREPLACE("ab","(a)","$")',
					'=REGEXREPLACE("ab","(a)","${1")',
					'=REGEXREPLACE("ab","(a)","x$-")'
				]
			])
		).toEqual({ A1: "b$aaab", B1: "!#VALUE!", C1: "!#VALUE!", D1: "!#VALUE!", E1: "!#VALUE!", F1: "!#VALUE!" })
	})

	it("matches empty text where PCRE2's global substitution does", () => {
		expect(calculate([['=REGEXREPLACE("abc","x*","-")', '=REGEXREPLACE("abc","","|")', '=REGEXREPLACE("abc","b*","-")']])).toEqual({
			A1: "-a-b-c-",
			B1: "|a|b|c|",
			C1: "-a--c-"
		})
	})

	it("is #VALUE! for a result longer than a cell holds", () => {
		expect(calculate([['=REGEXREPLACE(REPT("a",20000),"a","bb")', '=LEN(REGEXREPLACE(REPT("a",20000),"a","b"))']])).toEqual({
			A1: "!#VALUE!",
			B1: 20000
		})
	})
})

describe("regex functions: patterns the engine does not run", () => {
	it.each([
		'REGEXTEST("aa","(a)\\1")',
		'REGEXEXTRACT("ab","a(?=b)")',
		'REGEXREPLACE("ab","(?<=a)b","x")',
		'REGEXTEST("aab","(?>a+)b")',
		'REGEXEXTRACT("abc","\\p{L}+")',
		'REGEXEXTRACT("ab","(a|)*",2)'
	])("keeps the file's result of %s", formula => {
		expect(heldResult(formula, "stored")).toEqual({ value: "stored" })
	})

	it("calculates a pattern without such constructs regardless of the stored result", () => {
		expect(heldResult('REGEXTEST("aa","(a)a")', false)).toEqual({ value: true })
	})
})

describe("regex functions: user patterns cannot hang the calculation", () => {
	it("calculate linear patterns over a cell's longest text, the step budget growing with the text", () => {
		expect(
			calculate([
				[
					'=REGEXTEST(REPT("x",32000),"foo|bar|baz|qux")',
					'=REGEXTEST(REPT("x",31000)&"baz","foo|bar|baz|qux")',
					'=REGEXTEST(REPT("x",32000),"(a|aa)*c")',
					'=REGEXTEST(REPT("x",32000),"(?i)SHIPPED.*TOTAL.*XYZ")',
					'=REGEXTEST(REPT("Order ABC-1234 shipped to john.doe@example.com on 2024-05-01; total $1,234.56. ",395)&"xyz","(?i)SHIPPED.*TOTAL.*XYZ")',
					'=REGEXTEST(REPT("Order ABC-1234 shipped to john.doe@example.com on 2024-05-01; total $1,234.56. ",395),"(?i)SHIPPED.*TOTAL.*XYZ")',
					'=REGEXEXTRACT(REPT("x",30000)&"order-123","(\\w+)-(\\d+)$")'
				]
			])
		).toEqual({ A1: false, B1: true, C1: false, D1: false, E1: true, F1: false, G1: `${"x".repeat(30000)}order-123` })
	})

	it("give each cell what it gives alone, however many calculate together", () => {
		// Each search takes its own step budget: none of them is held for the others' work.
		const content = engineCellFormula('REGEXTEST(REPT("a",300),"[ab]{0,300}c")') ?? ""
		const row = Array.from({ length: 200 }, () => content)
		const engine = new FormulaEngine(
			[{ name: "S", rows: [row], formulas: row.map((_, col) => ({ row: 0, col, content, fallback: "stored" })) }],
			[]
		)

		try {
			expect(row.map((_, col) => engine.result(0, 0, col).value)).toEqual(row.map(() => false))
		} finally {
			engine.destroy()
		}
	})

	it("answers catastrophic patterns over long text quickly", () => {
		const start = Date.now()
		const results = calculate([
			[
				'=REGEXTEST(REPT("a",3000)&"!","^(a+)+$")',
				'=REGEXTEST(REPT("a",3000),"(a|aa)*b")',
				'=REGEXEXTRACT(REPT("a",1000),"(.*a){20}")=REPT("a",1000)',
				'=LEN(REGEXREPLACE(REPT("a",1000),"(a|a)*?","x"))'
			]
		])

		expect(results).toEqual({ A1: false, B1: false, C1: true, D1: 2001 })
		// A search linear over a cell's longest text calculates; one rescanning past its step budget keeps the file's
		// result.
		expect(heldResult('REGEXEXTRACT(REPT("a",30000),"(.*a){20}")=REPT("a",30000)', "stored")).toEqual({ value: true })
		expect(heldResult('ROWS(REGEXEXTRACT(REPT("a",30000),"(?:a*a*a*a*c)|a",1))', "stored")).toEqual({ value: "stored" })
		expect(Date.now() - start).toBeLessThan(budget(5000))
	})

	it("keep the file's result of a search copying captures at every position, and calculate ordinary captures over long text", () => {
		expect(heldResult(`REGEXREPLACE(REPT("a",32767),"${"()".repeat(706)}","$1")`, "stored")).toEqual({ value: "stored" })
		expect(heldResult(`REGEXREPLACE(REPT("a",32767),"${"|".repeat(4_999)}","x")`, "stored")).toEqual({ value: "stored" })
		expect(
			calculate([
				[
					'=LEN(REGEXREPLACE(REPT("(378) 555-4195 ",2000),"(\\d{3})-(\\d{4})","$2-$1"))',
					'=RIGHT(REGEXREPLACE(REPT("john@example.com ",1800),"([a-z]+)@([a-z]+)\\.com","$2 $1"),13)',
					'=ROWS(REGEXEXTRACT(REPT("ab12 ",6000),"([a-z]+)(\\d+)",1))'
				]
			])
		).toEqual({ A1: 30_000, B1: "example john ", C1: 6_000 })
	})

	it("replace the occurrence-th match of a text holding many as replacing every match chose it", () => {
		expect(
			calculate([
				[
					'=LEFT(REGEXREPLACE(REPT("ab",16000),"b","x",1),6)',
					'=LEN(REGEXREPLACE(REPT("ab",16000),"b","x",2))',
					'=RIGHT(REGEXREPLACE(REPT("ab",16000),"b","x",-1),4)',
					'=REGEXREPLACE("a1b2c3","\\d","#",3)',
					'=REGEXREPLACE("a1b2c3","\\d","#",4)'
				]
			])
		).toEqual({ A1: "axabab", B1: 32_000, C1: "abax", D1: "a1b2c#", E1: "a1b2c3" })
	})
})
