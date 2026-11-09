import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula } from "../core/sheet/refs/formulaRefs"

// The app's statistics, matrix, array-shaping, text, conversion and information functions against each function's
// page on support.microsoft.com (cited by the test): the page's examples, then its stated errors and edges.

type Typed = string | number | boolean | null

// Builds an engine over one sheet "S" from cells as typed: "=..." is a formula in Excel's syntax, "'..." text,
// anything else the value. Returns the value of each formula cell by its A1 name ("!#N/A" for an error).
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

// Formulas alone, in one row: their values in order.
function values(...formulas: string[]): unknown[] {
	return Object.values(calculate([formulas.map(formula => `=${formula}`)]))
}

// Numbers to `decimals` decimals.
function rounded(list: unknown[], decimals = 9): unknown[] {
	return list.map(value => (typeof value === "number" ? Number(value.toFixed(decimals)) : value))
}

// Every value of an array result, through INDEX, row by row.
function grid(formula: string, rows: number, cols: number): unknown[][] {
	const cells: string[] = []

	for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) cells.push(`INDEX(${formula},${String(r)},${String(c)})`)

	const flat = values(...cells)

	return Array.from({ length: rows }, (_, r) => flat.slice(r * cols, (r + 1) * cols))
}

describe("BINOM.DIST.RANGE", () => {
	it("gives the page's probabilities", () => {
		const [single, span] = values("BINOM.DIST.RANGE(60,0.75,48)", "BINOM.DIST.RANGE(60,0.75,45,50)") as number[]

		expect(rounded([single, span], 3)).toEqual([0.084, 0.524])
		// The exact sums of the binomial terms, in rational arithmetic.
		expect(single).toBeCloseTo(0.0839749674290475, 14)
		expect(span).toBeCloseTo(0.5236297934718872, 13)
	})

	it("truncates the counts and answers the certain cases exactly", () => {
		const [truncated, none, all, whole] = values(
			"BINOM.DIST.RANGE(60.9,0.75,48.7)",
			"BINOM.DIST.RANGE(10,0,0)",
			"BINOM.DIST.RANGE(10,1,10)",
			"BINOM.DIST.RANGE(10,0.5,0,10)"
		) as number[]

		expect([truncated, none, all]).toEqual([values("BINOM.DIST.RANGE(60,0.75,48)")[0], 1, 1])
		expect(whole).toBeCloseTo(1, 14)
	})

	it("gives #NUM! outside each argument's bounds and #VALUE! for text", () => {
		// "If any arguments are outside of their constraints, BINOM.DIST.RANGE returns the #NUM! error value."
		expect(
			values(
				"BINOM.DIST.RANGE(-1,0.5,0)",
				"BINOM.DIST.RANGE(10,1.5,1)",
				"BINOM.DIST.RANGE(10,0.5,11)",
				"BINOM.DIST.RANGE(10,0.5,5,4)",
				'BINOM.DIST.RANGE("a",0.5,1)'
			)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#VALUE!"])
	})
})

describe("ERF.PRECISE and ERFC.PRECISE", () => {
	it("gives the pages' values", () => {
		expect(rounded(values("ERF.PRECISE(0.745)", "ERF.PRECISE(1)", "ERFC.PRECISE(1)"), 8)).toEqual([0.70792892, 0.84270079, 0.15729921])
	})

	it("is accurate across the line, negative x included", () => {
		const [a, b, c, d, e, f] = values(
			"ERF.PRECISE(-1)",
			"ERF.PRECISE(2.5)",
			"ERFC.PRECISE(3)",
			"ERFC.PRECISE(-1)",
			"ERF.PRECISE(0)",
			"ERFC.PRECISE(10)"
		) as number[]

		expect(a).toBeCloseTo(-0.842700792949715, 14)
		expect(b).toBeCloseTo(0.999593047982555, 14)
		expect((c ?? Number.NaN) / 2.20904969985854e-5).toBeCloseTo(1, 12)
		expect(d).toBeCloseTo(1.84270079294971, 13)
		expect(e).toBe(0)
		expect((f ?? Number.NaN) / 2.08848758376254e-45).toBeCloseTo(1, 12)
	})

	it("gives #VALUE! for text", () => {
		expect(values('ERF.PRECISE("x")', 'ERFC.PRECISE("x")')).toEqual(["!#VALUE!", "!#VALUE!"])
	})
})

describe("GESTEP", () => {
	it("gives the page's results", () => {
		expect(values("GESTEP(5,4)", "GESTEP(5,5)", "GESTEP(-4,-5)", "GESTEP(-1)")).toEqual([1, 1, 1, 0])
	})

	it("reads numeric text and gives #VALUE! for other nonnumeric values", () => {
		// "If any argument is nonnumeric, GESTEP returns the #VALUE! error value."
		expect(values('GESTEP("5",4)', 'GESTEP("dog",0)', "GESTEP(TRUE)")).toEqual([1, "!#VALUE!", "!#VALUE!"])
	})
})

describe("INTERCEPT", () => {
	it("gives the page's intercept", () => {
		expect(
			rounded(
				Object.values(
					calculate([
						[2, 6, "=INTERCEPT(A1:A5,B1:B5)"],
						[3, 5],
						[9, 11],
						[1, 7],
						[8, 5]
					])
				),
				7
			)
		).toEqual([0.0483871])
	})

	it("leaves text out, and gives #N/A for sizes that differ or no points and #DIV/0! for one x", () => {
		// "If known_y's and known_x's contain a different number of data points or contain no data points, INTERCEPT
		// returns the #N/A error value."
		expect(
			calculate([
				[1, 1, "=INTERCEPT(A1:A3,B1:B3)", "=INTERCEPT(A1:A3,B1:B2)", "=INTERCEPT(A5:A6,B5:B6)", "=INTERCEPT(A1:A2,C5:C6)"],
				[3, 2],
				["'x", 3],
				[],
				[null, null, 1],
				[null, null, 1]
			])
		).toEqual({ C1: -1, D1: "!#N/A", E1: "!#N/A", F1: "!#DIV/0!" })
	})
})

describe("PERMUT and PERMUTATIONA", () => {
	it("gives the pages' counts, the arguments truncated", () => {
		expect(
			values(
				"PERMUT(100,3)",
				"PERMUT(3,2)",
				"PERMUT(6.9,3.2)",
				"PERMUT(6,0)",
				"PERMUTATIONA(3,2)",
				"PERMUTATIONA(2,2)",
				"PERMUTATIONA(6.9,3.8)",
				"PERMUTATIONA(0,0)"
			)
		).toEqual([970200, 6, 120, 1, 9, 4, 216, 1])
	})

	it("gives #NUM! for the invalid counts the pages name", () => {
		// PERMUT: "If number ≤ 0 or if number_chosen < 0" and "If number < number_chosen"; PERMUTATIONA: "when the
		// total number is zero (0) and the chosen number is larger than zero (0)".
		expect(values("PERMUT(0,0)", "PERMUT(5,-1)", "PERMUT(3,4)", "PERMUTATIONA(0,3)", "PERMUTATIONA(-1,2)", 'PERMUT("a",1)')).toEqual([
			"!#NUM!",
			"!#NUM!",
			"!#NUM!",
			"!#NUM!",
			"!#NUM!",
			"!#VALUE!"
		])
	})
})

describe("PERCENTRANK, PERCENTRANK.INC and PERCENTRANK.EXC", () => {
	const data: Typed[][] = [[13], [12], [11], [8], [4], [3], [2], [1], [1], [1]]

	it("gives the inclusive pages' ranks, cut to three decimals", () => {
		const rows = data.map((row, index) => [
			...row,
			["=PERCENTRANK(A1:A10,2)", "=PERCENTRANK(A1:A10,4)", "=PERCENTRANK(A1:A10,8)", "=PERCENTRANK(A1:A10,5)"][index] ?? null,
			["=PERCENTRANK.INC(A1:A10,2)", "=PERCENTRANK.INC(A1:A10,4)", "=PERCENTRANK.INC(A1:A10,8)", "=PERCENTRANK.INC(A1:A10,5)"][
				index
			] ?? null
		])

		expect(calculate(rows)).toEqual({ B1: 0.333, B2: 0.555, B3: 0.666, B4: 0.583, C1: 0.333, C2: 0.555, C3: 0.666, C4: 0.583 })
	})

	it("gives the exclusive page's ranks, significance cutting rather than rounding", () => {
		expect(
			calculate([
				[1, "=PERCENTRANK.EXC(A1:A9,7)", "=PERCENTRANK.EXC(A1:A9,5.43)", "=PERCENTRANK.EXC(A1:A9,5.43,1)"],
				[2],
				[3],
				[6],
				[6],
				[6],
				[7],
				[8],
				[9]
			])
		).toEqual({ B1: 0.7, C1: 0.381, D1: 0.3 })
	})

	it("takes significance as decimals and interpolates between ranks", () => {
		expect(
			values(
				"PERCENTRANK.INC({1,2,3,4},1.25)",
				"PERCENTRANK.INC({1,2,3,4},3.75)",
				"PERCENTRANK.INC({1,2,3,4},3,2)",
				"PERCENTRANK.EXC({1,2,3,4},1.25)",
				"PERCENTRANK({1,2,3,4},3,4)"
			)
		).toEqual([0.083, 0.916, 0.66, 0.25, 0.6666])
	})

	it("gives #NUM! for no numbers or a significance below 1, and #VALUE! for x outside the numbers", () => {
		// "If the array is empty, PERCENTRANK returns the #NUM! error value." "If significance < 1, PERCENTRANK
		// returns the #NUM! error value."
		expect(
			calculate([
				["'a", "=PERCENTRANK(A1:A2,1)", "=PERCENTRANK.INC({1,2},1,0)", "=PERCENTRANK.EXC({1,2},0)", "=PERCENTRANK.INC({1,2},3)"]
			])
		).toEqual({ B1: "!#NUM!", C1: "!#NUM!", D1: "!#VALUE!", E1: "!#VALUE!" })
	})
})

describe("TRIMMEAN", () => {
	it("gives the page's mean", () => {
		expect(rounded(Object.values(calculate([[4, 5, 6, 7, 2, 3, 4, 5, 1, 2, 3, "=TRIMMEAN(A1:K1,0.2)"]])), 3)).toEqual([3.778])
	})

	it("rounds the count left out down to an even number", () => {
		// "If percent = 0.1, 10 percent of 30 data points equals 3 points. For symmetry, TRIMMEAN excludes a single
		// value from the top and bottom of the data set."
		expect(values("TRIMMEAN({1,2,3,100},0.4)", "TRIMMEAN({1,2,3,100},0.5)", "TRIMMEAN({1,2,3},1)")).toEqual([26.5, 2.5, 2])
	})

	it("gives #NUM! for percent outside 0 to 1", () => {
		// "If percent < 0 or percent > 1, TRIMMEAN returns the #NUM! error value."
		expect(values("TRIMMEAN({1,2},-0.1)", "TRIMMEAN({1,2},1.1)")).toEqual(["!#NUM!", "!#NUM!"])
	})
})

describe("PROB", () => {
	const data: Typed[][] = [
		[0, 0.2],
		[1, 0.3],
		[2, 0.1],
		[3, 0.4]
	]

	it("gives the page's probabilities", () => {
		expect(calculate([[...(data[0] ?? []), "=PROB(A1:A4,B1:B4,2)", "=PROB(A1:A4,B1:B4,1,3)"], ...data.slice(1)])).toEqual({
			C1: 0.1,
			D1: 0.8
		})
	})

	it("gives #NUM! for a probability out of bounds or not summing to 1, and #N/A for sizes that differ", () => {
		// "If any value in prob_range ≤ 0 or if any value in prob_range > 1", "If the sum of the values in prob_range is
		// not equal to 1", "If x_range and prob_range contain a different number of data points".
		expect(values("PROB({1,2},{0,1},1)", "PROB({1,2},{0.5,0.6},1)", "PROB({1,2,3},{0.5,0.5},1)")).toEqual(["!#NUM!", "!#NUM!", "!#N/A"])
	})
})

describe("PERCENTOF", () => {
	it("divides the subset's sum by the whole's", () => {
		expect(calculate([[1, "=PERCENTOF(A1:A2,A1:A4)", "=PERCENTOF(A9,A9)"], [2], [3], [4]])).toEqual({ B1: 0.3, C1: "!#DIV/0!" })
	})
})

describe("ERROR.TYPE", () => {
	it("numbers each error and gives #N/A for anything else", () => {
		expect(
			values(
				"ERROR.TYPE(1/0)",
				'ERROR.TYPE("a"+1)',
				"ERROR.TYPE(SQRT(-1))",
				"ERROR.TYPE(NA())",
				"ERROR.TYPE(TAKE({1},0))",
				"ERROR.TYPE(5)"
			)
		).toEqual([2, 3, 6, 7, 14, "!#N/A"])
	})

	it("reads an error in a cell, as the page's CHOOSE example does", () => {
		expect(
			calculate([["=1/0", '=IF(ERROR.TYPE(A1)<3,CHOOSE(ERROR.TYPE(A1),"Ranges do not intersect","The divisor is zero"))']])
		).toEqual({ A1: "!#DIV/0!", B1: "The divisor is zero" })
	})
})

describe("AREAS", () => {
	it("counts one area for a reference and gives #VALUE! for a value", () => {
		expect(values("AREAS(B2:D4)", "AREAS(A1)", "AREAS((B2:D4))", "AREAS(C:C)", "AREAS(INDEX(B2:D4,1,1))", "AREAS(5)")).toEqual([
			1,
			1,
			1,
			1,
			1,
			"!#VALUE!"
		])
	})
})

describe("CONVERT", () => {
	it("gives the page's conversions", () => {
		expect(
			rounded(
				values(
					'CONVERT(1,"lbm","kg")',
					'CONVERT(68,"F","C")',
					'CONVERT(CONVERT(100,"ft","m"),"ft","m")',
					'CONVERT(6,"C","F")',
					'CONVERT(6,"tsp","tbs")',
					'CONVERT(6,"mi","km")',
					'CONVERT(6,"km","mi")',
					'CONVERT(6,"in","ft")',
					'CONVERT(6,"cm","in")'
				)
			)
		).toEqual([0.45359237, 20, 9.290304, 42.8, 2, 9.656064, 3.728227153, 0.5, 2.362204724])
	})

	it("takes metric prefixes, squared and cubed, and binary prefixes on information", () => {
		expect(
			values(
				'CONVERT(1,"km2","m2")',
				'CONVERT(1,"cm^3","m3")',
				'CONVERT(1,"tspm","ml")',
				'CONVERT(1,"kibyte","bit")',
				'CONVERT(1,"Gibyte","byte")',
				'CONVERT(1,"dam","m")',
				'CONVERT(1500,"ms","sec")',
				'CONVERT(1,"mK","K")'
			)
		).toEqual([1e6, 1e-6, 5, 8192, 2 ** 30, 10, 1.5, 0.001])
	})

	it("converts temperatures between every scale", () => {
		expect(
			rounded(
				values(
					'CONVERT(0,"C","K")',
					'CONVERT(100,"C","Reau")',
					'CONVERT(0,"K","Rank")',
					'CONVERT(491.67,"Rank","F")',
					'CONVERT(-40,"fah","cel")'
				)
			)
		).toEqual([273.15, 80, 0, 32, -40])
	})

	it("gives #N/A for units of different groups, unknown units, wrong case and binary prefixes off information", () => {
		// "If the units are in different groups", "If the unit does not exist", "If the unit does not support a binary
		// prefix, CONVERT returns the #N/A error value." "Unit names and prefixes are case-sensitive."
		expect(
			values(
				'CONVERT(2.5,"ft","sec")',
				'CONVERT(1,"lbm","LBM")',
				'CONVERT(1,"kim","m")',
				'CONVERT(1,"pond","N")',
				'CONVERT("a","m","m")'
			)
		).toEqual(["!#N/A", "!#N/A", "!#N/A", "!#N/A", "!#VALUE!"])
	})
})

describe("MDETERM, MINVERSE and MUNIT", () => {
	it("gives MDETERM's page results", () => {
		expect(
			calculate([
				[1, 3, 8, 5, "=MDETERM(A1:D4)", "=MDETERM({3,6,1;1,1,0;3,10,2})", "=MDETERM({3,6;1,1})", "=MDETERM({1,3,8,5;1,3,6,1})"],
				[1, 3, 6, 1],
				[1, 1, 1, 0],
				[7, 3, 10, 2]
			])
		).toEqual({ E1: 88, F1: 1, G1: -3, H1: "!#VALUE!" })
	})

	it("inverts a matrix to the page's 2x2 formula and gives #NUM! for a singular one", () => {
		expect(grid("MINVERSE({4,-1;2,0})", 2, 2)).toEqual([
			[0, 0.5],
			[-1, 2]
		])
		expect(rounded(grid("MINVERSE({1,2,1;3,4,-1;0,2,0})", 3, 3).flat())).toEqual([0.25, 0.25, -0.75, 0, 0, 0.5, 0.75, -0.25, -0.25])
		// "Some square matrices cannot be inverted and will return the #NUM! error value with MINVERSE."
		expect(values("INDEX(MINVERSE({1,2;2,4}),1,1)", "INDEX(MINVERSE({1,2,3}),1,1)")).toEqual(["!#NUM!", "!#VALUE!"])
	})

	it("gives #VALUE! for an empty cell or text", () => {
		// "If any cells in array are empty or contain text"
		expect(
			calculate([
				[1, null, "=MDETERM(A1:B2)", "=INDEX(MINVERSE(A1:B2),1,1)"],
				["'x", 1]
			])
		).toEqual({ C1: "!#VALUE!", D1: "!#VALUE!" })
	})

	it("builds the identity matrix, and gives #VALUE! for a dimension of 0", () => {
		expect(grid("MUNIT(3)", 3, 3)).toEqual([
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1]
		])
		expect(values("INDEX(MUNIT(0),1,1)")).toEqual(["!#VALUE!"])
	})
})

describe("LINEST, LOGEST and GROWTH", () => {
	const buildings: Typed[][] = [
		[2310, 2, 2, 20, 142000],
		[2333, 2, 2, 12, 144000],
		[2356, 3, 1.5, 33, 151000],
		[2379, 3, 2, 43, 150000],
		[2402, 2, 3, 53, 139000],
		[2425, 4, 2, 23, 169000],
		[2448, 2, 1.5, 99, 126000],
		[2471, 2, 2, 34, 142900],
		[2494, 3, 3, 23, 163000],
		[2517, 4, 4, 55, 169000],
		[2540, 2, 3, 22, 149000]
	]

	it("gives Example 1's slope and intercept", () => {
		expect(grid("LINEST({1;9;5;7},{0;4;2;3},,FALSE)", 1, 2)).toEqual([[2, 1]])
	})

	it("gives Example 3's coefficients and statistics", () => {
		const rows: Typed[][] = buildings.map(row => [...row])
		const formula = "LINEST(E1:E11,A1:D11,TRUE,TRUE)"

		for (let r = 1; r <= 5; r++)
			for (let c = 1; c <= 5; c++) (rows[r - 1] as Typed[])[4 + c] = `=INDEX(${formula},${String(r)},${String(c)})`

		const result = calculate(rows)
		const at = (r: number, c: number): unknown => result[`${String.fromCharCode(69 + c)}${String(r)}`]
		const expected: [number, number, number, number][] = [
			[1, 1, -234.2371645, 7],
			[1, 2, 2553.21066, 5],
			[1, 3, 12529.76817, 5],
			[1, 4, 27.64138737, 7],
			[1, 5, 52317.83051, 5],
			[2, 1, 13.26801148, 7],
			[2, 2, 530.6691519, 6],
			[2, 3, 400.0668382, 6],
			[2, 4, 5.429374042, 8],
			[2, 5, 12237.3616, 4],
			[3, 1, 0.996747993, 9],
			[3, 2, 970.5784629, 6],
			[4, 1, 459.7536742, 6],
			[4, 2, 6, 9],
			[5, 1, 1732393319, 0],
			[5, 2, 5652135.316, 2]
		]

		for (const [r, c, value, digits] of expected) expect(at(r, c) as number).toBeCloseTo(value, digits)

		expect([at(3, 3), at(4, 5), at(5, 4)]).toEqual(["!#N/A", "!#N/A", "!#N/A"])
	})

	it("gives Example 2's estimate through LINEST's own values", () => {
		// =SUM(LINEST(B1:B6, A1:A6)*{9,1}) is $11,000: the slope 1000 and the intercept 2000.
		expect(grid("LINEST({3100;4500;4400;5400;7500;8100},{1;2;3;4;5;6})", 1, 2)).toEqual([[1000, 2000]])
	})

	it("leaves a redundant predictor out with 0 coefficient and 0 standard error, df counting it", () => {
		// "Removed X columns can be recognized in LINEST output as having 0 coefficients in addition to 0 se values."
		// "each X column that was removed due to collinearity increases the value of df by 1"
		const [m2, m1, b, se2, df] = values(
			"INDEX(LINEST({3;5;7;10},{1,2;2,4;3,6;4,8},TRUE,TRUE),1,1)",
			"INDEX(LINEST({3;5;7;10},{1,2;2,4;3,6;4,8},TRUE,TRUE),1,2)",
			"INDEX(LINEST({3;5;7;10},{1,2;2,4;3,6;4,8},TRUE,TRUE),1,3)",
			"INDEX(LINEST({3;5;7;10},{1,2;2,4;3,6;4,8},TRUE,TRUE),2,1)",
			"INDEX(LINEST({3;5;7;10},{1,2;2,4;3,6;4,8},TRUE,TRUE),4,2)"
		) as number[]

		expect([m2, se2, df]).toEqual([0, 0, 2])
		expect(m1).toBeCloseTo(2.3, 12)
		expect(b).toBeCloseTo(0.5, 12)
	})

	it("returns 0 rather than an error for collinear data, as the page's remark has it", () => {
		// "if the data points of the known_y's argument are 0 and the data points of the known_x's argument are 1:
		// LINEST returns a value of 0."
		expect(grid("LINEST({0;0;0},{1;1;1})", 1, 2)).toEqual([[0, 0]])
	})

	it("gives #N/A for seb without a constant, and #VALUE! for text in the data", () => {
		// "seb = #N/A when const is FALSE"
		expect(values("INDEX(LINEST({1;2;4},{1;2;3},FALSE,TRUE),2,2)", 'INDEX(LINEST({1;"a";4}),1,1)')).toEqual(["!#N/A", "!#VALUE!"])
	})

	const units: Typed[][] = [[11, 33100], [12, 47300], [13, 69000], [14, 102000], [15, 150000], [16, 220000], [17], [18]]

	it("gives LOGEST's base and constant for the page's units, the single result 1.4633", () => {
		const rows = units.map((row, index) =>
			index === 0 ? [...row, "=INDEX(LOGEST(B1:B6,A1:A6),1,1)", "=INDEX(LOGEST(B1:B6,A1:A6),1,2)"] : row
		)
		const result = calculate(rows)

		expect(result["C1"] as number).toBeCloseTo(1.463275628, 9)
		expect(result["D1"] as number).toBeCloseTo(495.3047702, 6)
	})

	it("gives GROWTH's page predictions", () => {
		const rows = units.map((row, index) =>
			index === 0
				? [
						...row,
						"=INDEX(GROWTH(B1:B6,A1:A6),1,1)",
						"=INDEX(GROWTH(B1:B6,A1:A6),6,1)",
						"=INDEX(GROWTH(B1:B6,A1:A6,A7:A8),1,1)",
						"=INDEX(GROWTH(B1:B6,A1:A6,A7:A8),2,1)"
					]
				: row
		)

		expect(rounded(Object.values(calculate(rows)), 0)).toEqual([32618, 218822, 320197, 468536])
	})

	it("gives #NUM! for a y at or below 0 in LOGEST and GROWTH", () => {
		expect(values("INDEX(LOGEST({1;0;3}),1,1)", "INDEX(GROWTH({1;-2;3}),1,1)")).toEqual(["!#NUM!", "!#NUM!"])
	})
})

describe("SORTBY", () => {
	it("sorts rows by several keys, ascending then descending, stably", () => {
		const rows: Typed[][] = [
			["'Tom", "'West", 52],
			["'Fred", "'East", 65],
			["'Amy", "'West", 22],
			["'Sal", "'East", 73],
			["'Fritz", "'West", 52]
		]

		expect(calculate([...rows, ...[1, 2, 3, 4, 5].map(r => [`=INDEX(SORTBY(A1:C5,B1:B5,1,C1:C5,-1),${String(r)},1)`])])).toEqual({
			A6: "Sal",
			A7: "Fred",
			A8: "Tom",
			A9: "Fritz",
			A10: "Amy"
		})
	})

	it("sorts columns by a row, numbers before text before logical values, blanks last", () => {
		expect(grid('SORTBY({1,2,3,4},{"b",TRUE,3,"a"})', 1, 4)).toEqual([[3, 4, 1, 2]])
		expect(grid('SORTBY({1,2,3,4},{"b",TRUE,3,"a"},-1)', 1, 4)).toEqual([[2, 1, 4, 3]])
	})

	it("gives #VALUE! for a sort order other than 1 or -1 and for by arrays of the wrong size", () => {
		// "If the sort order argument is not -1, or 1, the formula will result in a #VALUE! error." "All of the
		// arguments must be the same size."
		expect(
			values("INDEX(SORTBY({1;2},{2;1},2),1,1)", "INDEX(SORTBY({1;2},{2;1;3}),1,1)", "INDEX(SORTBY({1;2},{2;1},,{1,2}),1,1)")
		).toEqual(["!#VALUE!", "!#VALUE!", "!#VALUE!"])
	})
})

describe("SORT", () => {
	it("orders as SORTBY and the Sort command do, ignoring hyphens and apostrophes", () => {
		// "Sort data in a range or table": the default sort order ignores apostrophes and hyphens.
		expect(grid('SORT({"-b";"a";"\'c"})', 3, 1)).toEqual([["a"], ["-b"], ["'c"]])
		expect(grid('SORT({"b",TRUE,3,"a"},,,TRUE)', 1, 4)).toEqual(grid('SORTBY({"b",TRUE,3,"a"},{"b",TRUE,3,"a"})', 1, 4))
	})

	it("sorts errors in the data with the rest instead of giving the first one", () => {
		expect(grid("SORT({2;#N/A;1})", 3, 1)).toEqual([[1], [2], ["!#N/A"]])
		expect(grid("SORT({2,#N/A;1,5})", 2, 2)).toEqual([
			[1, 5],
			[2, "!#N/A"]
		])
	})

	it("sorts by a column or row of the given index, descending when asked, blanks last", () => {
		const rows: Typed[][] = [
			[3, "'c"],
			[null, "'z"],
			[1, "'a"],
			[2, "'b"],
			["=INDEX(SORT(A1:B4,1,-1),1,2)", "=INDEX(SORT(A1:B4,1,-1),4,2)", "=INDEX(SORT(A1:B4,2,-1),1,2)"]
		]

		expect(calculate(rows)).toEqual({ A5: "c", B5: "z", C5: "z" })
		expect(grid("SORT({3,1,2;30,10,20},2,1,TRUE)", 2, 3)).toEqual([
			[1, 2, 3],
			[10, 20, 30]
		])
	})

	it("sorts by several keys given as arrays of indexes and orders", () => {
		expect(grid("SORT({1,1;2,0;1,3},{1,2},{1,-1})", 3, 2)).toEqual([
			[1, 3],
			[1, 1],
			[2, 0]
		])
		expect(grid("SORT({1,1;2,0;1,3},{1,2},-1)", 3, 2)).toEqual([
			[2, 0],
			[1, 3],
			[1, 1]
		])
	})

	it("gives #VALUE! for a sort order other than 1 or -1 and an index outside the array", () => {
		expect(
			values(
				"INDEX(SORT({1;2},1,2),1,1)",
				"INDEX(SORT({1;2},0),1,1)",
				"INDEX(SORT({1;2},2),1,1)",
				"INDEX(SORT({1,2;3,4},{1,2},{1,-1,1}),1,1)",
				"INDEX(SORT({1;2},#DIV/0!),1,1)"
			)
		).toEqual(["!#VALUE!", "!#VALUE!", "!#VALUE!", "!#VALUE!", "!#DIV/0!"])
	})
})

describe("TOCOL and TOROW", () => {
	const names: Typed[][] = [
		["'Ben", "'Peter", "'Mary", "'Sam"],
		["'John", "'Hillary", "'Jenny", "'James"],
		["'Agnes", "'Harry", null, null]
	]

	it("reads by row by default and by column when asked, a blank giving 0 unless ignored", () => {
		const formulas = (formula: string, count: number): Typed[] =>
			Array.from({ length: count }, (_, index) => `=INDEX(${formula},${String(index + 1)},1)`)
		const result = calculate([
			...names,
			formulas("TOCOL(A1:D3)", 12),
			formulas("TOCOL(A1:D3,1)", 10),
			formulas("TOCOL(A1:D3,,TRUE)", 4)
		])

		expect(Object.values(result).slice(0, 12)).toEqual([
			"Ben",
			"Peter",
			"Mary",
			"Sam",
			"John",
			"Hillary",
			"Jenny",
			"James",
			"Agnes",
			"Harry",
			0,
			0
		])
		expect(Object.values(result).slice(12, 22)).toEqual([
			"Ben",
			"Peter",
			"Mary",
			"Sam",
			"John",
			"Hillary",
			"Jenny",
			"James",
			"Agnes",
			"Harry"
		])
		expect(Object.values(result).slice(22)).toEqual(["Ben", "John", "Agnes", "Peter"])
	})

	it("leaves errors out when asked, and gives #CALC! when nothing is left and #VALUE! for another mode", () => {
		expect(grid("TOROW({1,#N/A,3},2)", 1, 2)).toEqual([[1, 3]])
		expect(values("INDEX(TOCOL(Z1:Z2,1),1,1)", "INDEX(TOROW({1},4),1,1)")).toEqual(["!#CALC!", "!#VALUE!"])
	})
})

describe("WRAPCOLS and WRAPROWS", () => {
	const letters: Typed[][] = [["'A", "'B", "'C", "'D", "'E", "'F", "'G"]]

	it("wraps the page's row by columns and by rows, padding with #N/A or pad_with", () => {
		const at = (formula: string, r: number, c: number): string => `=INDEX(${formula},${String(r)},${String(c)})`

		expect(
			Object.values(
				calculate([
					...letters,
					[
						at("WRAPCOLS(A1:G1,3)", 1, 3),
						at("WRAPCOLS(A1:G1,3)", 2, 3),
						at('WRAPCOLS(A1:G1,3,"x")', 3, 3),
						at("WRAPCOLS(A1:G1,3)", 3, 1)
					],
					[
						at("WRAPROWS(A1:G1,3)", 3, 1),
						at("WRAPROWS(A1:G1,3)", 3, 2),
						at('WRAPROWS(A1:G1,3,"x")', 3, 3),
						at("WRAPROWS(A1:G1,3)", 1, 3)
					]
				])
			)
		).toEqual(["G", "!#N/A", "x", "C", "G", "!#N/A", "x", "C"])
	})

	it("gives #VALUE! for a block and #NUM! for a wrap_count below 1", () => {
		// "Excel returns a #VALUE when vector is not a one-dimensional array." "Excel returns a #NUM when wrap_count is
		// less than 1."
		expect(values("INDEX(WRAPCOLS({1,2;3,4},2),1,1)", "INDEX(WRAPROWS({1,2},0),1,1)")).toEqual(["!#VALUE!", "!#NUM!"])
	})
})

describe("EXPAND", () => {
	it("grows the page's arrays, padding with #N/A or pad_with", () => {
		const rows: Typed[][] = [
			[1, 2],
			[3, 4]
		]

		expect(
			Object.values(
				calculate([
					...rows,
					[
						"=INDEX(EXPAND(A1:B2,3,3),3,3)",
						"=INDEX(EXPAND(A1:B2,3,3),2,2)",
						'=INDEX(EXPAND(A1,3,3,"-"),2,3)',
						"=ROWS(EXPAND(A1:B2,,4))"
					]
				])
			)
		).toEqual(["!#N/A", 4, "-", 2])
	})

	it("gives #VALUE! for a size below the array's and #NUM! past the grid", () => {
		// "Excel returns a #VALUE error when the rows or columns argument is less than the rows or columns in the array
		// argument." "Excel returns a #NUM when array is too large."
		expect(values("INDEX(EXPAND({1,2;3,4},1,2),1,1)", "INDEX(EXPAND({1},2000000,1),1,1)")).toEqual(["!#VALUE!", "!#NUM!"])
	})
})

describe("RANDARRAY", () => {
	it("gives numbers within the bounds, whole when asked", () => {
		const checks = values(
			"AND(INDEX(RANDARRAY(3,3,5,10,TRUE),3,3)>=5,INDEX(RANDARRAY(3,3,5,10,TRUE),3,3)<=10,MOD(INDEX(RANDARRAY(3,3,5,10,TRUE),2,2),1)=0)",
			"AND(RANDARRAY()>=0,RANDARRAY()<1)",
			"ROWS(RANDARRAY(4,2))*10+COLUMNS(RANDARRAY(4,2))"
		)

		expect(checks).toEqual([true, true, 42])
	})

	it("gives #VALUE! for a minimum not below the maximum", () => {
		// "The minimum number argument must be less than the maximum number, otherwise RANDARRAY will return a #VALUE!
		// error."
		expect(values("RANDARRAY(1,1,5,1)")).toEqual(["!#VALUE!"])
	})
})

describe("TRIMRANGE", () => {
	const rows: Typed[][] = [[], [null, null, 1, null], [null, 2, null, 3], []]

	it("trims blank rows and columns at the edges, both by default", () => {
		const formulas = [
			"=ROWS(TRIMRANGE(A1:E4))",
			"=COLUMNS(TRIMRANGE(A1:E4))",
			"=INDEX(TRIMRANGE(A1:E4),1,2)",
			"=ROWS(TRIMRANGE(A1:E4,1,0))",
			"=COLUMNS(TRIMRANGE(A1:E4,0,2))",
			"=ROWS(TRIMRANGE(A1:E4,0,0))"
		]

		expect(Object.values(calculate([...rows, formulas]))).toEqual([2, 3, 1, 3, 4, 4])
	})

	it("gives #VALUE! for a mode outside 0 to 3", () => {
		expect(values("ROWS(TRIMRANGE(Z1:Z2,4))")).toEqual(["!#VALUE!"])
	})
})

describe("ARRAYTOTEXT and VALUETOTEXT", () => {
	it("gives the pages' concise and strict texts", () => {
		expect(
			calculate([
				[true, '="a"+1', "=ARRAYTOTEXT(A1:B3,0)", "=ARRAYTOTEXT(A1:B3,1)"],
				[1234.01234, "'Seattle"],
				["'Hello", "'1,123"]
			])
		).toEqual({
			B1: "!#VALUE!",
			C1: "TRUE, #VALUE!, 1234.01234, Seattle, Hello, 1,123",
			D1: '{TRUE,#VALUE!;1234.01234,"Seattle";"Hello","1,123"}'
		})
		expect(
			calculate([
				[true, "=VALUETOTEXT(A1,0)", "=VALUETOTEXT(A1,1)"],
				[1234.01234, "=VALUETOTEXT(A2,0)", "=VALUETOTEXT(A2,1)"],
				["'Hello", "=VALUETOTEXT(A3,0)", "=VALUETOTEXT(A3,1)"],
				['="a"+1', "=VALUETOTEXT(A4,0)", "=VALUETOTEXT(A4,1)"],
				[1234, "=VALUETOTEXT(A5,0)", "=VALUETOTEXT(A5,1)"]
			])
		).toEqual({
			B1: "TRUE",
			C1: "TRUE",
			B2: "1234.01234",
			C2: "1234.01234",
			B3: "Hello",
			C3: '"Hello"',
			A4: "!#VALUE!",
			B4: "#VALUE!",
			C4: "#VALUE!",
			B5: "1234",
			C5: "1234"
		})
	})

	it("doubles quotes in strict text, and gives #VALUE! for a format other than 0 or 1", () => {
		// "If format is anything other than 0 or 1, VALUETOTEXT returns the #VALUE! error value."
		expect(values('VALUETOTEXT("say ""hi""",1)', "VALUETOTEXT(1,2)", "ARRAYTOTEXT({1,2},0.5)")).toEqual([
			'"say ""hi"""',
			"!#VALUE!",
			"!#VALUE!"
		])
	})
})

describe("BAHTTEXT", () => {
	it("gives the page's Thai text", () => {
		expect(values("BAHTTEXT(1234)")).toEqual(["หนึ่งพันสองร้อยสามสิบสี่บาทถ้วน"])
	})

	it("says ten as สิบ, twenty as ยี่สิบ, a final one past ten as เอ็ด, and satang after baht", () => {
		expect(
			values(
				"BAHTTEXT(11)",
				"BAHTTEXT(21)",
				"BAHTTEXT(101)",
				"BAHTTEXT(12.5)",
				"BAHTTEXT(0.65)",
				"BAHTTEXT(-1)",
				"BAHTTEXT(0)",
				"BAHTTEXT(1000000)"
			)
		).toEqual([
			"สิบเอ็ดบาทถ้วน",
			"ยี่สิบเอ็ดบาทถ้วน",
			"หนึ่งร้อยเอ็ดบาทถ้วน",
			"สิบสองบาทห้าสิบสตางค์",
			"หกสิบห้าสตางค์",
			"ลบหนึ่งบาทถ้วน",
			"ศูนย์บาทถ้วน",
			"หนึ่งล้านบาทถ้วน"
		])
	})
})

describe("ENCODEURL", () => {
	it("encodes the page's URL, keeping letters, digits and - . _ ~", () => {
		expect(
			values(
				'ENCODEURL("http://contoso.sharepoint.com/Finance/Profit and Loss Statement.xlsx")',
				'ENCODEURL("a-b_c~d!*é")',
				"ENCODEURL(0.5)"
			)
		).toEqual(["http%3A%2F%2Fcontoso.sharepoint.com%2FFinance%2FProfit%20and%20Loss%20Statement.xlsx", "a-b_c~d%21%2A%C3%A9", "0.5"])
	})
})
