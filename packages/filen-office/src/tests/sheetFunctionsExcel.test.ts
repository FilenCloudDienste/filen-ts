import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { absoluteCell, engineCellFormula, engineFormula, holdsBracket } from "../core/sheet/refs/formulaRefs"

// The engine against Excel's own reading of formulas, where HyperFormula alone differs: each case is Excel's result
// per the function's page on support.microsoft.com (cited by the test).

type Typed = string | number | boolean | null

// Builds an engine over one sheet "S" (and "T" when given) from cells as typed: "=..." is a formula in Excel's
// syntax, "'..." text, anything else the value. Returns the value of each formula cell by its A1 name.
function calculate(rows: Typed[][], other?: Typed[][]): Record<string, unknown> {
	const toEngine = (cells: Typed[][]): EngineSheet["rows"] =>
		cells.map(row =>
			row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(cell.slice(1)) ?? "") : cell))
		)
	const sheets: EngineSheet[] = [{ name: "S", rows: toEngine(rows), formulas: [] }]

	if (other !== undefined) sheets.push({ name: "T", rows: toEngine(other), formulas: [] })

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

// Numbers to the decimals the function pages show.
function rounded(values: Record<string, unknown>, decimals = 9): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(decimals)) : value])
	)
}

describe("Excel's coercion in the engine", () => {
	it("reads empty text as no number, and an empty cell as 0", () => {
		// "" from a formula is text: arithmetic on it is #VALUE! (support.microsoft.com "How to correct a #VALUE! error").
		expect(calculate([['=""', "=A1*2", "=A1+1", '=IFERROR(A1*2,"x")', "=D9*2", "=-A1"]])).toEqual({
			A1: "",
			B1: "!#VALUE!",
			C1: "!#VALUE!",
			D1: "x",
			E1: 0,
			F1: "!#VALUE!"
		})
	})

	it("counts an empty criterion cell as 0", () => {
		// COUNTIFS: "If the criteria argument is a reference to an empty cell, the COUNTIFS function treats the empty
		// cell as a 0 value."
		expect(calculate([[0, 1, "=COUNTIF(A1:B1,C9)", "=COUNTIFS(A1:B1,C9)", "=SUMIF(A1:B1,C9,A1:B1)"]])).toEqual({
			C1: 1,
			D1: 1,
			E1: 0
		})
	})
})

describe("TEXT", () => {
	it("formats through the cells' number formats", () => {
		expect(
			calculate([
				[
					0,
					2,
					'=TEXT(A1,"DD")&TEXT(A1,"MM")&TEXT(A1,"YYYY")',
					'=TEXT(B1*28,"mmmm")',
					'=TEXT(1234.5,"#,##0.00")',
					'=TEXT("12","0.0")'
				]
			])
		).toEqual({
			// Serial 0 is 1900-01-00 (ECMA-376 Part 1 §18.17.4.1).
			C1: "00011900",
			D1: "February",
			E1: "1,234.50",
			F1: "12.0"
		})
	})

	it("passes text through a text section, and shows logical values as they are", () => {
		expect(calculate([['=TEXT("ab","@!")', '=TEXT("ab","0")', '=TEXT(TRUE,"0")', '=TEXT(-1,"dd")', '=TEXT(5,"")']])).toEqual({
			A1: "ab!",
			B1: "ab",
			C1: "TRUE",
			D1: "!#VALUE!",
			E1: ""
		})
	})
})

describe("SUBTOTAL, AGGREGATE and COUNTBLANK", () => {
	it("leaves nested totals out", () => {
		// SUBTOTAL: "If there are other subtotals within ref1, ref2,… (or nested subtotals), these nested subtotals are
		// ignored to avoid double counting."
		expect(
			calculate([
				[1],
				[2],
				["=SUBTOTAL(9,A1:A2)"],
				[4],
				["=SUBTOTAL(9,A1:A4)"],
				["=SUM(A1:A4)"],
				["=AGGREGATE(9,0,A1:A4)"],
				["=AGGREGATE(9,4,A1:A4)"]
			])
		).toEqual({
			A3: 3,
			A5: 7,
			A6: 10,
			A7: 7,
			A8: 10
		})
	})

	it("calculates each SUBTOTAL function, raising the values' first error except for the counts", () => {
		const rows: Typed[][] = [[2, 4, "x", 6]]
		const formulas = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 109].map(type => [`=SUBTOTAL(${String(type)},A1:D1)`])

		// Results to Excel's 15 significant digits.
		expect(Object.values(calculate([...rows, ...formulas]))).toEqual(
			[4, 3, 4, 6, 2, 48, 2, Math.sqrt(8 / 3), 12, 4, 8 / 3, 12].map(value => Number(value.toPrecision(15)))
		)
		expect(
			calculate([[1, "=1/0"], ["=SUBTOTAL(9,A1:B1)"], ["=SUBTOTAL(2,A1:B1)"], ["=SUBTOTAL(3,A1:B1)"], ["=AGGREGATE(9,6,A1:B1)"]])
		).toEqual({
			B1: "!#DIV/0!",
			A2: "!#DIV/0!",
			A3: 1,
			A4: 2,
			A5: 1
		})
	})

	it("takes an array and k for AGGREGATE's LARGE to QUARTILE.EXC", () => {
		expect(
			calculate([
				[1, 5, 3, 9],
				[
					"=AGGREGATE(14,6,A1:D1,2)",
					"=AGGREGATE(15,6,A1:D1,1)",
					"=AGGREGATE(16,6,A1:D1,0.5)",
					"=AGGREGATE(12,6,A1:D1)",
					"=AGGREGATE(13,6,A1:D1)"
				]
			])
		).toEqual({ A2: 5, B2: 1, C2: 4, D2: 4, E2: "!#N/A" })
	})

	it("counts empty cells and empty text as blank", () => {
		// COUNTBLANK: "Cells with formulas that return "" (empty text) are also counted. Cells with zero values are
		// not counted."
		expect(calculate([['=""', 0, null, "x", "=COUNTBLANK(A1:D1)"]])).toEqual({ A1: "", E1: 2 })
	})
})

describe("Excel's reading of references", () => {
	it("intersects a range given alone with the formula's row or column, on any sheet", () => {
		const out = calculate(
			[
				[null, "=T!B1:D1", "=T!B1:D1"],
				[null, "=T!A1:A3"],
				[null, "=T!A1:A3"]
			],
			[
				[1, 2, 3, 4],
				[5, 6, 7, 8],
				[9, 10, 11, 12]
			]
		)

		// B1 meets T!B1:D1 in column B, C1 in column C; B2 and B3 meet T!A1:A3 in rows 2 and 3.
		expect(out).toEqual({ B1: 2, C1: 3, B2: 5, B3: 9 })
	})

	it("reads SUMIF's sum_range from its first cell with the range's size", () => {
		expect(
			calculate([
				["a", 1],
				["b", 2],
				["a", 4],
				['=SUMIF(A1:A3,"a",B1)', '=SUMIF(A1:A3,"a",B1:B2)', '=AVERAGEIF(A1:A3,"a",B1)']
			])
		).toEqual({
			A4: 5,
			B4: 5,
			C4: 2.5
		})
	})

	it("reads LOOKUP's one-cell result_vector along the lookup vector", () => {
		expect(calculate([[1, "x"], [2, "y"], [3, "z"], ["=LOOKUP(2.5,A1:A3,B1)"]])).toEqual({ A4: "y" })
	})

	it("counts INDEX's one-row array along the row", () => {
		// INDEX: "If array contains only one row or column, the corresponding row_num or column_num argument is
		// optional"; a number outside it is #REF!; 0 is the whole column or row.
		expect(
			calculate([
				[5, 6, 7],
				[1, 2, 3],
				["=INDEX(A1:C1,2)", "=INDEX(A1:C1,4)", "=SUM(INDEX(A1:C2,0,2))", "=INDEX(A1:C1,1,3)", "=SUM(INDEX(A1:C1,,0))"]
			])
		).toEqual({
			A3: 6,
			B3: "!#REF!",
			C3: 8,
			D3: 7,
			E3: 18
		})
	})

	it("gives HYPERLINK's friendly name as it is", () => {
		expect(calculate([[null, 4, '=HYPERLINK("#A1",A1)', '=HYPERLINK("#A1",B1)', '=HYPERLINK("#A1")']])).toEqual({
			C1: 0,
			D1: 4,
			E1: "#A1"
		})
	})

	it("reads serial 0 as 1900-01-00", () => {
		// ECMA-376 Part 1 §18.17.4.1: the 1900 date system's 0 is January 0, 1900; 60 is February 29, 1900.
		expect(calculate([["=DAY(0)", "=MONTH(0)", "=YEAR(0)", "=DAY(60)", "=MONTH(61)", "=DAY(B9)"]])).toEqual({
			A1: 0,
			B1: 1,
			C1: 1900,
			D1: 29,
			E1: 3,
			F1: 0
		})
	})
})

describe("the app's functions, from their pages' examples", () => {
	it("LOOKUP and XMATCH", () => {
		const rows: Typed[][] = [
			[4.14, "red"],
			[4.19, "orange"],
			[5.17, "yellow"],
			[5.77, "green"],
			[6.39, "blue"]
		]

		expect(
			calculate([
				...rows,
				[
					"=LOOKUP(4.19,A1:A5,B1:B5)",
					"=LOOKUP(5.75,A1:A5,B1:B5)",
					"=LOOKUP(7.66,A1:A5,B1:B5)",
					"=LOOKUP(0,A1:A5,B1:B5)",
					"=LOOKUP(5.75,A1:B5)"
				],
				[
					'=LOOKUP(2,1/(B1:B5="green"),A1:A5)',
					"=XMATCH(4.19,A1:A5)",
					"=XMATCH(5,A1:A5,1)",
					"=XMATCH(5,A1:A5,-1)",
					'=XMATCH("y*",B1:B5,2)'
				]
			])
		).toEqual({
			A6: "orange",
			B6: "yellow",
			C6: "blue",
			D6: "!#N/A",
			E6: "yellow",
			A7: 5.77,
			B7: 2,
			C7: 3,
			D7: 2,
			E7: 3
		})
	})

	// support.microsoft.com MATCH: with match_type 0 and a text lookup_value, ? and * are wildcards and ~ escapes them.
	it("MATCH with match_type 0 takes wildcards", () => {
		expect(
			calculate([
				["apple", "ac", '=MATCH("b*",A1:A5,0)', '=MATCH("a?c",B1:B3,0)', '=INDEX(A1:A5,MATCH("*err*",A1:A5,0))'],
				["Banana", "abc", '=MATCH("~*",A1:A5,0)', '=MATCH("x*",E:E,0)', '=MATCH("b*",{"a";"b";"b*";"c"},1)'],
				["cherry", "x", '=MATCH("a~?c",B1:B5,0)', '=MATCH("a?c",{"ac";"abc";"x"},0)', '=MATCH("B*",A1:A5,0)'],
				["*", "a?c", null, null, "xylophone"],
				["b*", null, null, null, null]
			])
		).toEqual({
			C1: 2,
			D1: 2,
			E1: "cherry",
			C2: 4,
			D2: 4,
			E2: 3,
			C3: 4,
			D3: 2,
			E3: 2
		})
	})

	it("RANK, RANK.EQ and RANK.AVG", () => {
		expect(
			calculate([
				[7, 3.5, 3.5, 1, 2],
				["=RANK.EQ(A1,A1:E1,1)", "=RANK.EQ(E1,A1:E1)", "=RANK(B1,A1:E1,1)", "=RANK.AVG(B1,A1:E1)", "=RANK(9,A1:E1)"]
			])
		).toEqual({
			A2: 5,
			B2: 4,
			C2: 3,
			D2: 2.5,
			E2: "!#N/A"
		})
	})

	it("CONCAT and the text pieces", () => {
		const text = "Little Red Riding Hood's red hood"

		expect(
			calculate([
				[`'${text}`, "a", 1, true],
				[
					'=CONCAT(B1:D1,"-",1/4)',
					'=TEXTBEFORE(A1,"Red")',
					'=TEXTBEFORE(A1,"red",2,1)',
					'=TEXTBEFORE(A1,"red",-2,1)',
					'=TEXTBEFORE(A1,"red",,1)'
				],
				[
					'=TEXTAFTER(A1,"Red")',
					'=TEXTAFTER(A1,"basket")',
					'=TEXTAFTER(A1,"red",-1)',
					'=TEXTAFTER(A1,"basket",,,,"none")',
					'=TEXTAFTER(A1,"hood",2,1,1)'
				],
				[
					'=INDEX(TEXTSPLIT("Dakota Lennon Sanchez"," "),1,2)',
					'=INDEX(TEXTSPLIT("a,b;c",",",";"),2,2)',
					'=INDEX(TEXTSPLIT("a,,b",",",,TRUE),1,2)'
				]
			])
		).toEqual({
			A2: "a1TRUE-0.25",
			B2: "Little ",
			C2: "Little Red Riding Hood's ",
			D2: "Little ",
			E2: "Little ",
			A3: " Riding Hood's red hood",
			B3: "!#N/A",
			C3: " hood",
			D3: "none",
			E3: "",
			A4: "Lennon",
			B4: "!#N/A",
			C4: "b"
		})
	})

	it("NUMBERVALUE, DOLLAR and FIXED", () => {
		expect(
			calculate([
				[
					'=NUMBERVALUE("2.500,27",",",".")',
					'=NUMBERVALUE("3.5%")',
					'=NUMBERVALUE(" 1 000 ")',
					'=NUMBERVALUE("1.2.3")',
					'=NUMBERVALUE("")'
				],
				["=DOLLAR(1234.567,2)", "=DOLLAR(1234.567,-2)", "=DOLLAR(-1234.567,-2)", "=DOLLAR(-0.123,4)", "=DOLLAR(99.888)"],
				["=FIXED(1234.567,1)", "=FIXED(1234.567,-1)", "=FIXED(-1234.567,-1,TRUE)", "=FIXED(44.332)", "=FIXED(0.5,0)"]
			])
		).toEqual({
			A1: 2500.27,
			B1: 0.035,
			C1: 1000,
			D1: "!#VALUE!",
			E1: 0,
			A2: "$1,234.57",
			B2: "$1,200",
			C2: "($1,200)",
			D2: "($0.1230)",
			E2: "$99.89",
			A3: "1,234.6",
			B3: "1,230",
			C3: "-1230",
			D3: "44.33",
			E3: "1"
		})
	})

	it("TYPE", () => {
		expect(
			calculate([["'Smith", "=TYPE(A1)", '=TYPE("MR. "&A1)', "=TYPE(2+A1)", "=TYPE({1,2;3,4})", "=TYPE(TRUE)", "=TYPE(Z9)"]])
		).toEqual({
			B1: 2,
			C1: 2,
			D1: 16,
			E1: 64,
			F1: 4,
			G1: 1
		})
	})

	it("FORECAST, TREND and FREQUENCY", () => {
		const ys = [133890, 135000, 135790, 137300, 138130, 139100, 139900, 141120, 141890, 143230, 144000, 145290]
		const out = calculate([
			[6, 7, 9, 15, 21],
			[20, 28, 31, 38, 40],
			ys,
			ys.map((_, index) => index + 1),
			[79, 85, 78, 85, 50, 81, 95, 88, 97],
			[70, 79, 89],
			[
				"=FORECAST(30,A1:E1,A2:E2)",
				"=FORECAST.LINEAR(30,A1:E1,A2:E2)",
				"=TREND(A3:L3,A4:L4)",
				"=INDEX(TREND(A3:L3,A4:L4,13),1,1)",
				"=INDEX(FREQUENCY(A5:I5,A6:C6),1)",
				"=INDEX(FREQUENCY(A5:I5,A6:C6),3)",
				"=INDEX(FREQUENCY(A5:I5,A6:C6),4)"
			]
		])
		expect(rounded(out, 6)).toEqual({
			A7: 10.607253,
			B7: 10.607253,
			C7: 133953.333333,
			D7: 146171.515152,
			E7: 1,
			F7: 4,
			G7: 2
		})
	})

	it("MODE, MODE.SNGL, MODE.MULT, KURT and AVERAGEIFS", () => {
		expect(
			rounded(
				calculate([
					[5.6, 4, 4, 3, 2, 4],
					[1, 2, 3, 4, 3, 2, 1, 2, 3, 5, 6, 1],
					[3, 4, 5, 2, 3, 4, 5, 6, 4, 7],
					[
						"=MODE(A1:F1)",
						"=MODE.SNGL(A1:F1)",
						"=INDEX(MODE.MULT(A2:L2),3)",
						"=KURT(A3:J3)",
						'=AVERAGEIFS(A2:L2,A2:L2,">2",A2:L2,"<5")',
						"=MODE(1,2)"
					]
				])
			)
		).toEqual({ A4: 4, B4: 4, C4: 3, D4: -0.151799637, E4: 3.25, F4: "!#N/A" })
	})

	it("TAKE, DROP, CHOOSECOLS and CHOOSEROWS", () => {
		expect(
			calculate([
				[1, 2, 3],
				[4, 5, 6],
				[7, 8, 9],
				[
					"=SUM(TAKE(A1:C3,2))",
					"=SUM(TAKE(A1:C3,-1,-2))",
					"=SUM(DROP(A1:C3,1,1))",
					"=SUM(CHOOSECOLS(A1:C3,1,-1))",
					"=SUM(CHOOSEROWS(A1:C3,2))",
					"=TAKE(A1:C3,0)",
					"=CHOOSECOLS(A1:C3,4)"
				]
			])
		).toEqual({ A4: 21, B4: 17, C4: 28, D4: 30, E4: 15, F4: "!#CALC!", G4: "!#VALUE!" })
	})
})

describe("formula text as the engine is given it", () => {
	it("passes every criteria argument through the criterion reader, and nothing else", () => {
		expect(engineFormula('COUNTIFS(A:A,B1,C:C,"x")+SUMIF(A1:A3,{1,2},B1:B3)+SUMIFS(D:D,A:A,(B1),C:C,)')).toBe(
			'COUNTIFS(A:A,FILEN.CRITERION(B1),C:C,FILEN.CRITERION("x"))+SUMIF(A1:A3,FILEN.CRITERION({1,2}),B1:B3)+' +
				"SUMIFS(D:D,A:A,FILEN.CRITERION((B1)),C:C,FILEN.CRITERION())"
		)
		expect(engineFormula("COUNT(A1,B1)+_xlfn.MAXIFS(A:A,B:B,C1)")).toBe("COUNT(A1,B1)+MAXIFS(A:A,B:B,FILEN.CRITERION(C1))")
	})

	it("resizes SUMIF's sum_range only where both are plain references", () => {
		expect(engineCellFormula("SUMIF($A$1:$A$10,C1,B5)")).toBe("=SUMIF($A$1:$A$10,FILEN.CRITERION(C1),B5:B14)")
		expect(engineCellFormula("SUMIF(A1:B2,C1,Sheet2!D4:D9)")).toBe("=SUMIF(A1:B2,FILEN.CRITERION(C1),'Sheet2'!D4:E5)")
		expect(engineCellFormula("SUMIF(A:A,C1,B:B)")).toBe("=SUMIF(A:A,FILEN.CRITERION(C1),B:B)")
		expect(engineCellFormula("SUMIF(A1:A3,C1,OFFSET(B1,0,0))")).toBe("=SUMIF(A1:A3,FILEN.CRITERION(C1),OFFSET(B1,0,0))")
	})

	it("intersects a formula that is one range alone", () => {
		expect(engineCellFormula("'PF calculator'!B4:P4")).toBe("=FILEN.INTERSECT('PF calculator'!B4:P4)")
		expect(engineCellFormula("A:A")).toBe("=FILEN.INTERSECT(A:A)")
		expect(engineCellFormula("A1")).toBe("=A1")
		expect(engineCellFormula("A1:A2+1")).toBe("=A1:A2+1")
	})

	it("spells no name over a column of a range", () => {
		expect(engineFormula("SUM(AA:AA)+AA", new Map([["AA", "'Data'!$B$4"]]))).toBe("SUM(AA:AA)+'Data'!$B$4")
	})

	it("knows a reference into another workbook in a quoted sheet name", () => {
		expect(holdsBracket("'[2]1.2 BUDGET'!N43")).toBe(true)
		expect(holdsBracket("'[x'&A1")).toBe(false)
		expect(holdsBracket('"[2]"&A1')).toBe(false)
	})

	it("spells a name of one cell as that cell, a one-cell range included", () => {
		expect(absoluteCell("'Incoming Hazmat'!$J$7:$J$7")).toBe("'Incoming Hazmat'!$J$7")
		expect(absoluteCell("Data!$A$1")).toBe("'Data'!$A$1")
		expect(absoluteCell("Data!$A$1:$A$2")).toBeNull()
		expect(absoluteCell("Data!$A$1:A1")).toBeNull()
	})
})

describe("SUBTOTAL and AGGREGATE over hidden rows", () => {
	// Rows 2 and 3 hidden by a filter, row 4 by hand.
	const states = [0, 2, 2, 1, 0]
	const rows: EngineSheet["rows"] = [
		[1, "=SUBTOTAL(9,A1:A5)", "=SUBTOTAL(109,A1:A5)", "=AGGREGATE(9,5,A1:A5)", "=AGGREGATE(9,4,A1:A5)", "=SUM(A1:A5)"],
		[2],
		[4],
		[8],
		[16]
	]

	it("leaves filtered rows out of every SUBTOTAL, hidden ones out of 101-111 and AGGREGATE's options 1, 3, 5 and 7", () => {
		const hidden = new Set<number>()
		const engine = new FormulaEngine(
			[{ name: "S", rows: rows.map(row => [...row]), formulas: [] }],
			[],
			false,
			undefined,
			(_sheet, row) => (hidden.has(row) ? (states[row] ?? 0) : 0)
		)

		try {
			expect([1, 2, 3, 4, 5].map(col => engine.result(0, 0, col).value)).toEqual([31, 31, 31, 31, 31])

			for (const row of [1, 2, 3]) hidden.add(row)

			// Nothing read the rows' state yet: the totals are calculated again only when told.
			const changed = engine.rowsChanged()

			// Every total is reported (the unchanged one too: over-reporting costs only work).
			expect(changed.map(cell => `${String(cell.col)}=${String(cell.value)}`).sort()).toEqual(["1=25", "2=17", "3=17", "4=31"])
			expect([1, 2, 3, 4, 5].map(col => engine.result(0, 0, col).value)).toEqual([25, 17, 17, 31, 31])
		} finally {
			engine.destroy()
		}
	})

	it("leaves hidden rows out from the build on, by the sheet's own index whatever the engine numbers it", () => {
		// A sheet named like a number comes first among a record's keys, before sheets listed ahead of it.
		const seen: number[] = []
		const engine = new FormulaEngine(
			[
				{ name: "Totals", rows: [["=SUBTOTAL(109,'2'!A1:A3)", "=SUBTOTAL(9,'2'!A1:A3)"]], formulas: [] },
				{ name: "2", rows: [[1], [2], [4]], formulas: [] }
			],
			[],
			false,
			undefined,
			(sheet, row) => {
				seen.push(sheet)

				return sheet === 1 && row === 1 ? 1 : sheet === 1 && row === 2 ? 2 : 0
			}
		)

		try {
			expect([engine.result(0, 0, 0).value, engine.result(0, 0, 1).value]).toEqual([1, 3])
			expect(new Set(seen)).toEqual(new Set([1]))
		} finally {
			engine.destroy()
		}
	})

	it("follows its totals through inserted and deleted rows", () => {
		const hidden = new Set<number>()
		const engine = new FormulaEngine(
			[{ name: "S", rows: [[1], [2], ["=SUBTOTAL(109,A1:A2)"]], formulas: [] }],
			[],
			false,
			undefined,
			(_sheet, row) => (hidden.has(row) ? 1 : 0)
		)

		try {
			engine.insert(0, "rows", 0, 2)
			hidden.add(2)
			engine.rowsChanged()
			expect(engine.result(0, 4, 0).value).toBe(2)
			engine.remove(0, "rows", 0, 1)
			hidden.clear()
			hidden.add(0)
			engine.rowsChanged()
			expect(engine.result(0, 3, 0).value).toBe(3)
		} finally {
			engine.destroy()
		}
	})
})

// Each formula alone in column A, its value by formula.
function column(formulas: readonly string[]): Record<string, unknown> {
	const values = rounded(calculate(formulas.map(formula => [`=${formula}`])))

	return Object.fromEntries(formulas.map((formula, row) => [formula, values[`A${String(row + 1)}`]]))
}

// Each case's expected value beside its formula.
function expectColumn(cases: Readonly<Record<string, unknown>>): void {
	expect(column(Object.keys(cases))).toEqual(cases)
}

describe("rounding and remainders as Excel calculates them", () => {
	it("rounds INT down and gives MOD the divisor's sign", () => {
		// "INT function", "MOD function"; ECMA-376 Part 1 §18.17.7.169, §18.17.7.218.
		expectColumn({
			"INT(8.9)": 8,
			"INT(-8.9)": -9,
			"INT(-2.7)": -3,
			"INT(-0.5)": -1,
			"MOD(3,2)": 1,
			"MOD(-3,2)": 1,
			"MOD(3,-2)": -1,
			"MOD(-3,-2)": -1,
			"MOD(-1.5,1)": 0.5,
			"MOD(6,-3)": 0,
			"MOD(6.3,2.1)": 0,
			"MOD(-6.3,2.1)": 0,
			"MOD(0.7,0.1)": 0,
			"MOD(5.1,1)": 0.1,
			"MOD(3,0)": "!#DIV/0!"
		})
	})

	it("rounds the decimal number Excel holds, with num_digits truncated", () => {
		// The pages' examples ("ROUND function", "ROUNDUP function", "ROUNDDOWN function", "TRUNC function"), and values
		// whose binary form is just below the decimal one.
		expectColumn({
			"ROUND(2.15,1)": 2.2,
			"ROUND(2.149,1)": 2.1,
			"ROUND(-1.475,2)": -1.48,
			"ROUND(21.5,-1)": 20,
			"ROUND(626.3,-3)": 1000,
			"ROUND(1.98,-1)": 0,
			"ROUND(-50.55,-2)": -100,
			"ROUND(1.005,2)": 1.01,
			"ROUND(2.675,2)": 2.68,
			"ROUND(1.234,1.9)": 1.2,
			"ROUNDUP(3.2,0)": 4,
			"ROUNDUP(76.9,0)": 77,
			"ROUNDUP(3.14159,3)": 3.142,
			"ROUNDUP(-3.14159,1)": -3.2,
			"ROUNDUP(31415.92654,-2)": 31500,
			"ROUNDUP(0.1+0.2,1)": 0.3,
			"ROUNDDOWN(3.14159,3)": 3.141,
			"ROUNDDOWN(-3.14159,1)": -3.1,
			"ROUNDDOWN(31415.92654,-2)": 31400,
			"ROUNDDOWN(0.29,2)": 0.29,
			"ROUNDDOWN(-0.29,2)": -0.29,
			"ROUNDDOWN(8.94-8,2)": 0.94,
			"TRUNC(8.9)": 8,
			"TRUNC(-8.9)": -8,
			"TRUNC(PI(),3)": 3.141,
			"TRUNC(4.35,2)": 4.35
		})
	})

	it("rounds EVEN and ODD away from zero, and truncates for ISEVEN and ISODD", () => {
		// "EVEN function", "ODD function"; ECMA-376 Part 1 §18.17.7.177 and §18.17.7.183 (ISODD(-15) is TRUE).
		expectColumn({
			"EVEN(1.5)": 2,
			"EVEN(3)": 4,
			"EVEN(-1)": -2,
			"EVEN(0)": 0,
			"ODD(1.5)": 3,
			"ODD(2)": 3,
			"ODD(-1)": -1,
			"ODD(-2)": -3,
			"ODD(0)": 1,
			"ISEVEN(12.456)": true,
			"ISEVEN(-15)": false,
			"ISODD(12.456)": false,
			"ISODD(-15)": true,
			"ISODD(-1.5)": true
		})
	})

	it("keeps a number that is already a multiple of the significance", () => {
		// "CEILING function": CEILING(1.5,0.1) is 1.5, a multiple kept as it is; the binary quotients of these are a step
		// off the whole number. LibreOffice 7.5 gives each as it is.
		expectColumn({
			"CEILING(0.07,0.01)": 0.07,
			"CEILING(2.1,0.3)": 2.1,
			"CEILING(-0.3,0.1)": -0.3,
			"CEILING.MATH(2.7,0.3)": 2.7,
			"CEILING.MATH(0.07,0.01)": 0.07,
			"FLOOR(0.3,0.1)": 0.3,
			"FLOOR.MATH(0.3,0.1)": 0.3,
			"FLOOR.MATH(0.6,0.2)": 0.6,
			"CEILING.PRECISE(0.07,0.01)": 0.07,
			"ISO.CEILING(0.07,0.01)": 0.07,
			"FLOOR.PRECISE(0.3,0.1)": 0.3,
			"FLOOR.PRECISE(2014.6,0.2)": 2014.6,
			"MROUND(0.3,0.1)": 0.3
		})
	})

	it("rounds to multiples as CEILING, FLOOR and their variants do", () => {
		// The pages' examples; CEILING's significance of 0 as LibreOffice gives it; MROUND's page shows it on the binary
		// value (6.05 is just below 6.05).
		expectColumn({
			"CEILING(2.5,1)": 3,
			"CEILING(-2.5,-2)": -4,
			"CEILING(-2.5,2)": -2,
			"CEILING(1.5,0.1)": 1.5,
			"CEILING(0.234,0.01)": 0.24,
			"CEILING(2.5,-2)": "!#NUM!",
			"CEILING(2.5,0)": 0,
			"FLOOR(3.7,2)": 2,
			"FLOOR(-2.5,-2)": -2,
			"FLOOR(2.5,-2)": "!#NUM!",
			"FLOOR(1.58,0.1)": 1.5,
			"FLOOR(0.234,0.01)": 0.23,
			"FLOOR(2.5,0)": "!#DIV/0!",
			"CEILING.MATH(24.3,5)": 25,
			"CEILING.MATH(6.7)": 7,
			"CEILING.MATH(-8.1,2)": -8,
			"CEILING.MATH(-5.5,2,-1)": -6,
			"FLOOR.MATH(24.3,5)": 20,
			"FLOOR.MATH(6.7)": 6,
			"FLOOR.MATH(-8.1,2)": -10,
			"FLOOR.MATH(-5.5,2,-1)": -4,
			"CEILING.PRECISE(4.3)": 5,
			"CEILING.PRECISE(-4.3)": -4,
			"CEILING.PRECISE(4.3,-2)": 6,
			"ISO.CEILING(-4.3,2)": -4,
			"FLOOR.PRECISE(-3.2,-1)": -4,
			"FLOOR.PRECISE(3.2,-1)": 3,
			"MROUND(10,3)": 9,
			"MROUND(-10,-3)": -9,
			"MROUND(1.3,0.2)": 1.4,
			"MROUND(5,-2)": "!#NUM!",
			"MROUND(6.05,0.1)": 6
		})
	})
})

describe("date differences as Excel calculates them", () => {
	it("counts DATEDIF in every unit, in either case", () => {
		// "DATEDIF function" and ECMA-376 Part 1 §18.17.7.75; "MD" and "YD" where the page is silent as LibreOffice
		// counts them, "MD" negative as the page's known issue says it can be.
		expectColumn({
			'DATEDIF(DATE(2001,1,1),DATE(2003,1,1),"Y")': 2,
			'DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"D")': 440,
			'DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"YD")': 75,
			'DATEDIF(DATE(2020,1,1),DATE(2021,3,1),"m")': 14,
			'DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"md")': 14,
			'DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"ym")': 2,
			'DATEDIF(DATE(2015,1,31),DATE(2015,3,1),"MD")': -2,
			'DATEDIF(DATE(2001,8,15),DATE(2002,6,1),"YD")': 290,
			'DATEDIF(DATE(2000,2,29),DATE(2001,2,28),"YD")': 365,
			'DATEDIF(DATE(2000,2,29),DATE(2004,2,28),"Y")': 3,
			'DATEDIF(DATE(2000,2,29),DATE(2001,2,28),"M")': 11,
			'DATEDIF(DATE(2001,6,1)+0.9,DATE(2001,6,2)+0.1,"D")': 1,
			'DATEDIF(1,61,"m")': 2,
			'DATEDIF(DATE(2001,6,2),DATE(2001,6,1),"D")': "!#NUM!",
			'DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"X")': "!#NUM!"
		})
	})

	it("moves a start on February's last day to the 30th in DAYS360's U.S. method", () => {
		// "DAYS360 function": the start date on its month's last day becomes the 30th; then an end on the 31st after a
		// start on the 30th becomes the 30th too.
		expectColumn({
			"DAYS360(DATE(2011,1,30),DATE(2011,12,31))": 330,
			"DAYS360(DATE(2011,1,1),DATE(2011,1,30))": 29,
			"DAYS360(DATE(2011,1,1),DATE(2011,12,31),TRUE)": 359,
			"DAYS360(DATE(2011,2,28),DATE(2011,3,31))": 30,
			"DAYS360(DATE(2011,2,28),DATE(2011,3,31),TRUE)": 32,
			"DAYS360(DATE(2011,1,29),DATE(2011,3,31))": 62,
			"DAYS360(DATE(2011,3,31),DATE(2011,2,28))": -32,
			"DAYS360(DATE(2011,2,28),DATE(2011,2,28))": 0
		})
	})
})

describe("arguments Excel truncates", () => {
	it("truncates positions, counts, offsets and flags rather than refusing them", () => {
		// Each page's "truncated" remark (CHOOSE, EDATE, EOMONTH, YEARFRAC, the base conversions' places, BASE), ECMA-376
		// Part 1 §18.17.7.344 for WEEKDAY, and LibreOffice for the text positions, DB and the cumulative payments where
		// the pages are silent.
		expectColumn({
			'MID("Fluid Flow",1.9,5.9)': "Fluid",
			'REPLACE("abcdefghijk",6.9,5.9,"*")': "abcde*k",
			'FIND("M","Miriam McGovern",3.9)': 8,
			'SEARCH("e","Statements",6.9)': 7,
			'SUBSTITUTE("Quarter 1, 2011","1","2",3.9)': "Quarter 1, 2012",
			'FIND("a","abc",0.5)': "!#VALUE!",
			"CHOOSE(2.9,1,2,3)": 2,
			"EDATE(DATE(2011,1,15),1.9)": 40589,
			"EDATE(DATE(2011,1,15),-1.9)": 40527,
			"EOMONTH(DATE(2011,1,1),1.9)": 40602,
			"EOMONTH(DATE(2011,1,1),-1.9)": 40543,
			"WEEKDAY(DATE(2008,2,14),2.9)": 4,
			"WEEKNUM(DATE(2012,3,9),2.9)": 11,
			"YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),3.9)": 0.578082192,
			"DEC2BIN(9.9)": "1001",
			"DEC2BIN(-9.9)": "1111110111",
			"DEC2HEX(100.7,4)": "0064",
			"DEC2OCT(58.9,3.9)": "072",
			'HEX2BIN("F",8.9)': "00001111",
			'BIN2HEX("11111011",4.9)': "00FB",
			"BASE(15.9,2,10.9)": "0000001111",
			'DECIMAL("FF",16.9)': 255,
			"DB(1000000,100000,6,1.9,7.9)": 186083.333333333,
			"DB(1000000,100000,6.5,1,7)": 173833.333333333,
			"CUMIPMT(0.0075,360,125000,13.9,24.9,0)": -11135.232130751,
			"CUMPRINC(0.0075,360,125000,13.9,24.9,0)": -934.107123421,
			// "BITRSHIFT function": shift_amount "must be an integer", and one outside the constraints is #NUM!.
			"BITRSHIFT(13,2.9)": "!#NUM!",
			"TDIST(1.959999998,60.9,2.9)": 0.05464493
		})
	})

	it("gives ROMAN #VALUE! out of 0 to 3999 and nothing for 0", () => {
		// "ROMAN function": negative and past 3999 are #VALUE!; LibreOffice gives "" for 0.
		expectColumn({
			"ROMAN(499,0)": "CDXCIX",
			"ROMAN(499.9)": "CDXCIX",
			"ROMAN(499,1)": "LDVLIV",
			"ROMAN(3999.9)": "MMMCMXCIX",
			"ROMAN(0)": "",
			"ROMAN(-1)": "!#VALUE!",
			"ROMAN(4000)": "!#VALUE!"
		})
	})
})
