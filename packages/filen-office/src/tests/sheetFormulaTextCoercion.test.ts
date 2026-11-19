import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { NUMFMT_EN_US } from "../core/sheet/numfmt/locale"
import type { SheetLocale } from "../core/sheet/protocol"
import { engineCellFormula } from "../core/sheet/refs/formulaRefs"
import { RenderStyleTable } from "../core/sheet/session"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { openOdsFixture, table } from "./odsFixtures"

// Text, wildcards and comparison in the engine as Excel reads them, where HyperFormula alone differs.

type Typed = string | number | boolean | null

// The value of each formula cell ("=..." in Excel's syntax) by its A1 name; an error as "!#NAME".
function calculate(rows: Typed[][], locale?: SheetLocale): Record<string, unknown> {
	const sheets: EngineSheet[] = [
		{
			name: "S",
			rows: rows.map(row =>
				row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(cell.slice(1)) ?? "") : cell))
			),
			formulas: []
		}
	]
	const engine = new FormulaEngine(sheets, [], false, undefined, undefined, locale)
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

// Formulas in column B, row by row, beside the values in column A given by row index.
function column(formulas: string[], prefix: Readonly<Record<number, Typed>> = {}, locale?: SheetLocale): Record<string, unknown> {
	const values = calculate(
		formulas.map((formula, index) => [prefix[index] ?? null, formula]),
		locale
	)

	return Object.fromEntries(formulas.map((_, index) => [index, values[`B${String(index + 1)}`]]))
}

describe("numbers as text", () => {
	// Excel turns a number into text as General does, at 15 significant digits ("Excel specifications and limits").
	it("gives & the General text of a number", () => {
		expect(column(['=(0.1+0.2)&""', '=1/3&""', '=1E+20&""', '=1E-20&""', '=-2/3&"x"', '=A6&""', "=TRUE&1"], { 5: 0.1 + 0.2 })).toEqual({
			0: "0.3",
			1: "0.333333333333333",
			2: "1E+20",
			3: "1E-20",
			4: "-0.666666666666667x",
			5: "0.3",
			6: "TRUE1"
		})
	})

	it("gives text functions the General text of a number argument", () => {
		expect(
			column(
				[
					"=LEN(2/3)",
					"=CONCATENATE(1/3)",
					'=TEXTJOIN(",",,1/3,2)',
					'=SUBSTITUTE(1/3,"3","x")',
					"=LEFT(1/3,20)",
					"=MID(0.1+0.2,1,10)",
					"=REPT(1/3,2)",
					'=TEXTJOIN(0.1+0.2,,"a","b")',
					"=CONCATENATE(A9,1)"
				],
				{ 8: 1e21 }
			)
		).toEqual({
			0: 17,
			1: "0.333333333333333",
			2: "0.333333333333333,2",
			3: "0.xxxxxxxxxxxxxxx",
			4: "0.333333333333333",
			5: "0.3",
			6: "0.3333333333333330.333333333333333",
			7: "a0.3b",
			8: "1E+211"
		})
	})
})

describe("numbers as text in the session's locale", () => {
	const ITALIAN_MONTHS = [
		"gennaio",
		"febbraio",
		"marzo",
		"aprile",
		"maggio",
		"giugno",
		"luglio",
		"agosto",
		"settembre",
		"ottobre",
		"novembre",
		"dicembre"
	]
	const MONTH_ROW =
		'<table:table-row><table:table-cell table:formula="of:=TEXT(DATE(2024;3;1);&quot;mmmm&quot;)" office:value-type="string" office:string-value="March"><text:p>March</text:p></table:table-cell></table:table-row>'
	const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]
	const GERMAN: SheetLocale = {
		decimal: ",",
		group: ".",
		argument: ";",
		dateOrder: "dmy",
		currencies: ["€"],
		numFmt: { ...NUMFMT_EN_US, decimal: ",", group: ".", months: MONTHS }
	}
	// Separators alone: the cells show en-US's names with them.
	const SEPARATORS: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }
	const FORMULAS = [
		'=TEXT(1234.5,"#,##0.00")',
		'=VALUE(TEXT(1234.5,"#,##0.00"))',
		'=TEXT(1234.5,"0.00")*1',
		'=A4&""',
		'=(A4&"")*1',
		"=FIXED(1234.5,1)",
		"=DOLLAR(-1234.5)",
		"=VALUE(FIXED(1234.5))",
		"=CONCATENATE(1/4)",
		'=TEXT(DATE(2024,3,1),"mmmm")',
		"=VALUE(DOLLAR(1234.5))",
		"=DOLLAR(-1234.5)*1",
		"=VALUETOTEXT(1.5)",
		"=VALUETOTEXT(1.5)*1",
		"=ARRAYTOTEXT({1.5,2})",
		"=ENCODEURL(1.5)"
	]

	// Excel writes text in the regional settings it reads text in, so the text a formula gives reads back.
	it("writes what the locale reads back", () => {
		expect(column(FORMULAS, { 3: 1234.5 }, GERMAN)).toEqual({
			0: "1.234,50",
			1: 1234.5,
			2: 1234.5,
			3: "1234,5",
			4: 1234.5,
			5: "1.234,5",
			6: "(€1.234,50)",
			7: 1234.5,
			8: "0,25",
			9: "März",
			10: 1234.5,
			11: -1234.5,
			12: "1,5",
			13: 1.5,
			14: "1,5, 2",
			15: "1%2C5"
		})
		expect(column([FORMULAS[0] ?? "", FORMULAS[9] ?? ""], {}, SEPARATORS)).toEqual({ 0: "1.234,50", 1: "March" })
	})

	it("keeps en-US's text without a locale", () => {
		expect(column(FORMULAS, { 3: 1234.5 })).toEqual({
			0: "1,234.50",
			1: 1234.5,
			2: 1234.5,
			3: "1234.5",
			4: 1234.5,
			5: "1,234.5",
			6: "($1,234.50)",
			7: 1234.5,
			8: "0.25",
			9: "March",
			10: 1234.5,
			11: -1234.5,
			12: "1.5",
			13: 1.5,
			14: "1.5, 2",
			15: "1.5"
		})
	})

	// An OpenDocument session's entries read without the locale's patterns; its formulas still write what cells show.
	it("writes month names as an OpenDocument session's cells show them", async () => {
		const document = new XlsxDocument((await openOdsFixture({ body: table("S", MONTH_ROW) })).workbook, new RenderStyleTable(), {
			kind: "ods",
			settings: { locale: GERMAN }
		})

		document.buildEngine()

		expect(document.numFmtLocale?.months[2]).toBe("März")
		expect(document.engine?.result(0, 0, 0).value).toBe("März")
		document.dropEngine()
	})

	// Another locale with the same separators and order but other names: TEXT gives the new names.
	it("writes the new names after a change of the shown locale alone", async () => {
		const document = new XlsxDocument((await openOdsFixture({ body: table("S", MONTH_ROW) })).workbook, new RenderStyleTable(), {
			kind: "ods",
			settings: { locale: GERMAN }
		})

		document.buildEngine()
		expect(document.engine?.result(0, 0, 0).value).toBe("März")

		document.settings = { locale: { ...GERMAN, numFmt: { ...NUMFMT_EN_US, decimal: ",", group: ".", months: ITALIAN_MONTHS } } }

		expect(document.engine).toBeNull()
		document.buildEngine()
		expect(document.engine?.result(0, 0, 0).value).toBe("marzo")
		document.dropEngine()
	})
})

describe("wildcards", () => {
	// "A question mark matches any single character" (support.microsoft.com COUNTIF).
	it("matches ? to exactly one character", () => {
		const values = calculate([
			["ac", '=COUNTIF(A1:A3,"a?c")', '=XLOOKUP("a?c",A1:A3,A1:A3,,2)', '=SEARCH("a?c","ac")', '=SEARCH("a?c","xabc")'],
			["abc", '=VLOOKUP("a?c",A1:A3,1,FALSE)', '=COUNTIF(A1:A3,"(x)")', '=COUNTIF(A1:A3,"a*")', '=COUNTIF(A1:A3,"a~?c")'],
			["(x)", '=COUNTIF(A1:A4,"a|c")', '=SUMIF(A1:A3,"?b?",A1:A3)', '=COUNTIF(A1:A3,"???")', '=SEARCH("b*","abc")'],
			["a|c"]
		])

		expect(values).toEqual({
			B1: 1,
			C1: "abc",
			D1: "!#VALUE!",
			E1: 2,
			B2: "abc",
			C2: 1,
			D2: 2,
			E2: 0,
			B3: 1,
			C3: 0,
			D3: 2,
			E3: 2
		})
	})

	it("counts ????? as five characters exactly", () => {
		const values = calculate([["apple", '=COUNTIF(A1:A7,"?????")'], ["Banana"], ["a*c"], ["a?c"], ["abc"], [true], [10]])

		expect(values["B1"]).toBe(1)
	})
})

describe("text that reads as a date", () => {
	// Text never equals a number and orders after every number (support.microsoft.com "Sort data in a range or
	// table", default sort order); arithmetic still reads it as a date.
	it("compares as text", () => {
		expect(
			column([
				'="1/1/2020"',
				"=B1=DATE(2020,1,1)",
				'="2020-01-01"=DATE(2020,1,1)',
				'="12:00"=0.5',
				"=B1<>DATE(2020,1,1)",
				"=B1>DATE(2020,1,1)",
				'=IF(B1=43831,"eq","ne")',
				"=B1+0",
				'="1/1/2020"="1/1/2020"',
				'="b">"A"'
			])
		).toEqual({ 0: "1/1/2020", 1: false, 2: false, 3: false, 4: true, 5: true, 6: "ne", 7: 43831, 8: true, 9: true })
	})

	it("sorts, deduplicates and matches as text", () => {
		expect(
			column([
				'=ROWS(UNIQUE({"1/1/2020";43831}))',
				'=INDEX(SORT({"3/1/2020";"10/1/2020"}),1)',
				'=INDEX(SORT({"1/5/2024";43831}),1)',
				'=MATCH("1/1/2020",{43831},0)',
				'=MATCH(43831,{"1/1/2020"},0)'
			])
		).toEqual({ 0: 2, 1: "10/1/2020", 2: 43831, 3: "!#N/A", 4: "!#N/A" })
	})
})

describe("the longest text", () => {
	// "If the result of the REPT function is longer than 32,767 characters, REPT returns the #VALUE! error value"
	// (support.microsoft.com REPT); a cell holds at most 32,767 characters ("Excel specifications and limits").
	it("gives #VALUE! for text past 32,767 characters", () => {
		expect(
			column([
				'=LEN(REPT("a",32767))',
				'=LEN(REPT("a",40000))',
				'=LEN(REPT("a",30000)&REPT("a",30000))',
				'=LEN(CONCATENATE(REPT("a",30000),REPT("a",30000)))',
				'=LEN(SUBSTITUTE(REPT("a",20000),"a","bb"))',
				'=REPT("ab",1E+15)',
				'=LEN(REPT("a",32766)&"b")',
				'=SUMPRODUCT(--ISERROR(REPT({"a";"b"},40000)))'
			])
		).toEqual({ 0: 32767, 1: "!#VALUE!", 2: "!#VALUE!", 3: "!#VALUE!", 4: "!#VALUE!", 5: "!#VALUE!", 6: 32767, 7: 2 })
	})
})
