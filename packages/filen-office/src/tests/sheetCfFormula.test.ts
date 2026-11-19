import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { FormulaEvaluator, ruleTruth, type FormulaHost } from "../core/sheet/cf/formula/evaluate"
import { parseFormula } from "../core/sheet/cf/formula/syntax"
import { FormulaError, Unsupported, numberText, type FormulaRef, type Scalar } from "../core/sheet/cf/formula/values"
import { meetsValidation } from "../core/sheet/dv/validate"
import type { DvRule } from "../core/sheet/dv/rules"
import { budget } from "./timing"

// Rule formulas (conditional formats, validations) read and calculated as Excel does: array semantics, relative
// references moved from the anchor, the functions those rules use, and what is not calculated refused.

function grid(
	cells: Record<string, Scalar>,
	names: Record<string, string> = {},
	sheets: Record<string, number> = { One: 0 },
	extent: { readonly rows: number; readonly cols: number } = { rows: 100, cols: 30 }
): FormulaHost {
	const key = (sheet: number, row: number, col: number): string => `${String(sheet)}:${String(row)}:${String(col)}`
	const map = new Map<string, Scalar>()

	for (const [address, value] of Object.entries(cells)) {
		const match = /^(?:(\w+)!)?([A-Z]+)(\d+)$/u.exec(address)

		if (match === null) throw new Error(address)

		const col = [...(match[2] ?? "")].reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1

		map.set(key(sheets[match[1] ?? "One"] ?? 0, Number(match[3]) - 1, col), value)
	}

	return {
		value: (sheet, row, col) => map.get(key(sheet, row, col)) ?? null,
		forEach(ref: FormulaRef, visit) {
			const found: [number, number, Scalar][] = []

			for (const [k, value] of map) {
				const [sheet, row, col] = k.split(":").map(Number) as [number, number, number]

				if (
					sheet === ref.sheet &&
					row >= ref.startRow &&
					row <= ref.endRow &&
					col >= ref.startCol &&
					col <= ref.endCol &&
					value !== null
				)
					found.push([row, col, value])
			}

			found.sort((a, b) => a[0] - b[0] || a[1] - b[1])

			for (const [row, col, value] of found) visit(row, col, value)
		},
		extent: () => extent,
		sheetByName: name => sheets[Object.keys(sheets).find(candidate => candidate.toUpperCase() === name.toUpperCase()) ?? ""] ?? null,
		definedName: name => names[name.toUpperCase()] ?? null,
		today: () => 45_000,
		now: () => 45_000.5,
		date1904: false
	}
}

function evaluate(host: FormulaHost, formula: string, at: [number, number] = [0, 0], anchor: [number, number] = [0, 0]): Scalar {
	const evaluator = new FormulaEvaluator(host)

	return evaluator.scalar(evaluator.evaluate(formula, { sheet: 0, anchorRow: anchor[0], anchorCol: anchor[1], row: at[0], col: at[1] }))
}

describe("rule formulas", () => {
	it("moves relative references from the anchor and keeps absolute ones", () => {
		const host = grid({ A1: 1, A2: 5, B2: 7, C1: 10 })

		expect(evaluate(host, "A1>3", [1, 0])).toBe(true)
		expect(evaluate(host, "A1>3", [0, 0])).toBe(false)
		expect(evaluate(host, "$C$1-A1", [1, 1])).toBe(3)
		expect(evaluate(host, "A$1+1", [1, 0])).toBe(2)
		// Relative references wrap round the grid, as Excel's do in conditional formats.
		expect(evaluate(host, "A1", [0, 0], [1, 1])).toBe(null)
	})

	it("compares as Excel does: blank as the other side's empty, text above numbers, text without case", () => {
		const host = grid({ A1: "abc", A2: 0 })

		expect(evaluate(host, '"ABC"=A1')).toBe(true)
		expect(evaluate(host, "A1>99999")).toBe(true)
		expect(evaluate(host, "B1=0")).toBe(true)
		expect(evaluate(host, 'B1=""')).toBe(true)
		expect(evaluate(host, "TRUE>1")).toBe(true)
		expect(evaluate(host, "-2^2")).toBe(4)
		expect(evaluate(host, '"5"+1')).toBe(6)
		expect(evaluate(host, '"x"+1')).toBe(FormulaError.VALUE)
		expect(evaluate(host, "1/0")).toBe(FormulaError.DIV0)
		expect(evaluate(host, "50%")).toBe(0.5)
	})

	it("calculates the functions rules use", () => {
		const host = grid({ A1: "Apples", A2: 3, A3: 4, A4: 5, B1: "  x  y ", C1: 45_000 })

		expect(evaluate(host, 'NOT(ISERROR(SEARCH("pp",A1)))')).toBe(true)
		expect(evaluate(host, 'ISERROR(SEARCH("zz",A1))')).toBe(true)
		expect(evaluate(host, 'SEARCH("p?l",A1)')).toBe(2)
		expect(evaluate(host, 'FIND("a",A1)')).toBe(FormulaError.VALUE)
		expect(evaluate(host, "LEN(TRIM(B1))")).toBe(3)
		expect(evaluate(host, 'LEFT(A1,LEN("app"))="app"')).toBe(true)
		expect(evaluate(host, "MEDIAN(A2:A4)")).toBe(4)
		expect(evaluate(host, "SUM(A1:A4)")).toBe(12)
		expect(evaluate(host, "AVERAGE(A2:A4)")).toBe(4)
		expect(evaluate(host, 'COUNTIF(A1:A4,">3")')).toBe(2)
		expect(evaluate(host, 'COUNTIF(A1:A4,"app*")')).toBe(1)
		expect(evaluate(host, 'COUNTIFS(A2:A4,">2",A2:A4,"<5")')).toBe(2)
		expect(evaluate(host, "COUNTBLANK(A1:A6)")).toBe(2)
		expect(evaluate(host, "VLOOKUP(4,A2:A4,1,FALSE)")).toBe(4)
		expect(evaluate(host, "MATCH(5,A2:A4,0)")).toBe(3)
		expect(evaluate(host, "INDEX(A2:A4,2)")).toBe(4)
		expect(evaluate(host, 'IF(A2>2,"big","small")')).toBe("big")
		expect(evaluate(host, "AND(A2>2,A3>3)")).toBe(true)
		expect(evaluate(host, "OR(A2>9,A3>9)")).toBe(false)
		expect(evaluate(host, "MOD(ROW(),2)=0", [3, 0])).toBe(true)
		expect(evaluate(host, "FLOOR(C1,1)=TODAY()")).toBe(true)
		expect(evaluate(host, "YEAR(C1)")).toBe(2023)
		expect(evaluate(host, "MONTH(EDATE(C1,-1))")).toBe(2)
		expect(evaluate(host, "WEEKDAY(DATE(2023,3,15))")).toBe(4)
		expect(evaluate(host, "ISBLANK(Z9)")).toBe(true)
		expect(evaluate(host, "ADDRESS(2,3,4)")).toBe("C2")
		expect(evaluate(host, 'SUM(INDIRECT("A2:A3"))')).toBe(7)
		expect(evaluate(host, "SUM(OFFSET(A2,1,0,2,1))")).toBe(9)
		expect(evaluate(host, "SUMPRODUCT((A2:A4>3)*1)")).toBe(2)
		expect(evaluate(host, 'TEXT(C1,"yyyy-mm-dd")')).toBe("2023-03-15")
		// support.microsoft.com "PROPER function" examples.
		expect(evaluate(host, 'PROPER("this is a TITLE")')).toBe("This Is A Title")
		expect(evaluate(host, 'PROPER("2-way street")')).toBe("2-Way Street")
		expect(evaluate(host, 'PROPER("76BudGet")')).toBe("76Budget")
	})

	it("evaluates as an array formula, giving the top-left value", () => {
		const host = grid({ A1: "x", B1: "y", C1: "x" })

		expect(evaluate(host, 'OR($A1:$C1="y")')).toBe(true)
		expect(evaluate(host, 'AND($A1:$C1="x")')).toBe(false)
		expect(evaluate(host, "A1:C1")).toBe("x")
	})

	it("reads defined names and other sheets", () => {
		const host = grid({ A1: 2, "Two!B3": 9 }, { LIMIT: "One!$A$1*2" }, { One: 0, Two: 1 })

		expect(evaluate(host, "Limit")).toBe(4)
		expect(evaluate(host, "Two!B3+'Two'!$B$3")).toBe(18)
		expect(evaluate(host, "Missing")).toBe(FormulaError.NAME)
	})

	it("refuses what it does not calculate rather than guessing", () => {
		const host = grid({})

		expect(() => evaluate(host, 'WEBSERVICE("x")')).toThrow(Unsupported)
		// A name that is no function at all is Excel's #NAME? (a misspelt ISERROR).
		expect(evaluate(host, "ISERRROR(A1)")).toBe(FormulaError.NAME)
		expect(evaluate(host, "ISERROR(ISERRROR(A1))")).toBe(true)
		expect(() => evaluate(host, "Table1[Col]")).toThrow(Unsupported)
		expect(() => evaluate(host, "A1 B1")).toThrow(Unsupported)
		expect(() => evaluate(host, "Nowhere!A1")).toThrow(Unsupported)
		expect(() => parseFormula("SUM(")).toThrow(Unsupported)
	})

	it("knows which formulas move with the cell and which are volatile", () => {
		expect(parseFormula("$A$1>5").relative).toBe(false)
		expect(parseFormula("A1>5").relative).toBe(true)
		expect(parseFormula("ROW()=2").relative).toBe(true)
		expect(parseFormula("TODAY()").volatile).toBe(true)
	})

	it("counts a rule that reads a defined name as moving with the cell", () => {
		const host = grid({}, { ROWISEVEN: "MOD(ROW(),2)=0" })

		// Names are evaluated at each cell: a rule of a relative name alone must not be calculated once.
		expect(parseFormula("RowIsEven").relative).toBe(true)
		expect(parseFormula("AND(RowIsEven,$A$1=0)").relative).toBe(true)
		expect([0, 1, 2, 3].map(row => evaluate(host, "RowIsEven", [row, 0]))).toEqual([false, true, false, true])
		expect(parseFormula("$A$1+$B$2>0").relative).toBe(false)
	})

	it("takes only TRUE and non-zero numbers as a rule holding", () => {
		expect(ruleTruth(true)).toBe(true)
		expect(ruleTruth(2)).toBe(true)
		expect(ruleTruth(0)).toBe(false)
		expect(ruleTruth("TRUE")).toBe(false)
		expect(ruleTruth(null)).toBe(false)
	})

	it("writes numbers as Excel's text functions see them", () => {
		expect(numberText(0.1 + 0.2)).toBe("0.3")
		expect(numberText(1e20)).toBe("1E+20")
		expect(numberText(-12.5)).toBe("-12.5")
		expect(numberText(123456789012345680)).toBe("1.23456789012346E+17")
	})

	it("keeps a reference's whole shape past the sheet's used rows, its cells there blank", () => {
		const host = grid({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, B3: 1, B4: 1, B5: 1 }, {}, { One: 0 }, { rows: 5, cols: 2 })

		expect(evaluate(host, 'SUMPRODUCT(--($A$1:$A$10=""))')).toBe(5)
		// Pairs A1 with B3: 1 + 2 + 3.
		expect(evaluate(host, "SUMPRODUCT($A$1:$A$8,$B$3:$B$10)")).toBe(6)
		expect(evaluate(host, "SUMPRODUCT($A$1:$A$4,$B$2:$B$5)")).toBe(2 + 3 + 4)
		expect(evaluate(host, "ROWS(--$A$1:$A$10)")).toBe(10)
		expect(evaluate(host, 'COUNTIF($A$1:$A$10,"")')).toBe(5)
		expect(evaluate(host, "COUNT(--($A$1:$A$10=0))")).toBe(10)
		expect(evaluate(host, "OR($A$6:$A$10=0)")).toBe(true)
		// A whole column is read as what it holds and a blank rest, not cell by cell.
		expect(evaluate(host, 'SUMPRODUCT(--($A:$A=""))')).toBe(1_048_576 - 5)
		expect(evaluate(host, 'SUMPRODUCT(($A:$A="")*($B:$B=""))')).toBe(1_048_576 - 5)
		expect(evaluate(host, "INDEX(--$A$1:$A$10,9)")).toBe(0)
		expect(evaluate(host, "INDEX(--$A$1:$A$10,2)")).toBe(2)
	})

	it("compares and subtracts numbers to Excel's 15 significant digits", () => {
		const host = grid({ A1: 0.1, A2: 0.2, A3: 0.3, B1: 1, B2: 1.00000000000001 })

		expect(evaluate(host, "A1+A2=A3")).toBe(true)
		expect(evaluate(host, "A1+A2<>A3")).toBe(false)
		expect(evaluate(host, "A1+A2>A3")).toBe(false)
		expect(evaluate(host, "A1+A2<=A3")).toBe(true)
		expect(evaluate(host, "A1+A2-A3")).toBe(0)
		expect(evaluate(host, "A3-A1-A2")).toBe(0)
		// A difference in the 15th digit is a difference.
		expect(evaluate(host, "B1=B2")).toBe(false)
		expect(evaluate(host, "B2>B1")).toBe(true)
		expect(evaluate(host, 'COUNTIF(A1:A3,"="&(A1+A2))')).toBe(1)
	})
})

// The criteria functions over whole columns: a blank-matching criterion counts the column's every blank arithmetically,
// never one by one (a million positions a column, sixteen million over sixteen columns).
describe("criteria over whole columns", () => {
	const host = grid({
		A1: "a",
		A2: "b",
		A3: "a",
		A5: "a",
		A6: "b",
		C1: "done",
		C2: "open",
		C4: "done",
		C5: "open",
		D1: 1,
		D2: 2,
		D3: 3,
		D4: 4,
		D5: 5,
		D6: 6,
		D7: 7
	})
	const ROWS = 1_048_576

	it("count, sum and average as over the used range, the blanks past it counted", () => {
		expect(evaluate(host, 'COUNTIFS($A:$A,"a",$C:$C,"<>done")')).toBe(2)
		expect(evaluate(host, 'COUNTIFS($A$1:$A$10,"a",$C$1:$C$10,"<>done")')).toBe(2)
		expect(evaluate(host, 'COUNTIFS($C:$C,"<>done")')).toBe(ROWS - 2)
		expect(evaluate(host, 'COUNTIFS($C$1:$C$10,"<>done")')).toBe(8)
		expect(evaluate(host, 'COUNTIFS($A:$A,"<>b",$C:$C,"")')).toBe(ROWS - 5)
		expect(evaluate(host, 'COUNTIFS($A$1:$A$10,"<>b",$C$1:$C$10,"")')).toBe(5)
		// Mixed: a pair blanks fail limits the count to its own matches, tested against the blank-accepting one.
		expect(evaluate(host, 'COUNTIFS($A:$A,"<>b",$C:$C,"open")')).toBe(1)
		expect(evaluate(host, 'COUNTIFS($C:$C,"open",$A:$A,"<>b")')).toBe(1)
		expect(evaluate(host, 'SUMIFS($D:$D,$C:$C,"<>done")')).toBe(23)
		expect(evaluate(host, 'SUMIFS($D$1:$D$10,$C$1:$C$10,"<>done")')).toBe(23)
		expect(evaluate(host, 'SUMIFS($D:$D,$A:$A,"<>b",$C:$C,"")')).toBe(10)
		expect(evaluate(host, 'SUMIF($C:$C,"<>done",$D:$D)')).toBe(23)
		expect(evaluate(host, 'AVERAGEIFS($D:$D,$C:$C,"<>done",$A:$A,"a")')).toBe(4)
		expect(evaluate(host, 'AVERAGEIF($C:$C,"",$D:$D)')).toBeCloseTo(16 / 3, 12)
		expect(evaluate(host, 'COUNTIFS($A:$A,"x",$C:$C,"<>done")')).toBe(0)
	})

	it("take sixteen whole columns without running out of room, and quickly", () => {
		expect(evaluate(host, 'COUNTIFS($A:$P,"<>x")')).toBe(16 * ROWS)
		expect(evaluate(host, 'COUNTIFS($A:$P,"<>a",$A:$P,"<>b")')).toBe(16 * ROWS - 5)
		expect(evaluate(host, 'SUMIFS($A:$P,$A:$P,"<>x")')).toBe(28)

		const start = performance.now()

		for (let row = 0; row < 200; row++) evaluate(host, 'COUNTIFS($C:$C,"<>done",$A:$A,$A1)', [row, 4], [0, 4])

		expect(performance.now() - start).toBeLessThan(budget(1_000))
	})
})

// Wildcards in rule formulas (support.microsoft.com "Using wildcard characters in searches"): ? any one character,
// * any run, ~ making the next character literal, case ignored. Matched without backtracking.
describe("wildcards in rule formulas", () => {
	it("match ?, *, ~ and case, and give SEARCH's position", () => {
		const host = grid({ A1: "abc", A2: "ABC", A3: "a*c", A4: "a?c", A5: "axc", A6: "ac", B1: "x~y" })

		expect(evaluate(host, 'COUNTIF(A1:A6,"a?c")')).toBe(5)
		expect(evaluate(host, 'COUNTIF(A1:A6,"a~*c")')).toBe(1)
		expect(evaluate(host, 'COUNTIF(A1:A6,"a~?c")')).toBe(1)
		expect(evaluate(host, 'COUNTIF(A1:A6,"~a?c")')).toBe(5)
		expect(evaluate(host, 'COUNTIF(A1:A6,"A*")')).toBe(6)
		expect(evaluate(host, 'COUNTIF(A1:A6,"<>a*c")')).toBe(0)
		expect(evaluate(host, 'COUNTIF(B1,"x~~y")')).toBe(1)
		expect(evaluate(host, 'MATCH("A~?C",A1:A6,0)')).toBe(4)
		expect(evaluate(host, 'MATCH("*X*",A1:A6,0)')).toBe(5)
		expect(evaluate(host, 'VLOOKUP("a?c",A3:A6,1,FALSE)')).toBe("a*c")
		expect(evaluate(host, 'SEARCH("b?d","abcbxd")')).toBe(4)
		expect(evaluate(host, 'SEARCH("C*X","abcbxd")')).toBe(3)
		expect(evaluate(host, 'SEARCH("~*","a*b")')).toBe(2)
		expect(evaluate(host, 'SEARCH("b*","abcb",3)')).toBe(4)
		expect(evaluate(host, 'SEARCH("?","abc",3)')).toBe(3)
		expect(evaluate(host, 'SEARCH("x?","abc")')).toBe(FormulaError.VALUE)
	})

	it.each([3_000, 30_000])("tell at once that ten stars do not match %i characters", length => {
		const host = grid({ A1: "a".repeat(length) })
		const pattern = `${"*a".repeat(9)}*b`
		const start = performance.now()

		// A containsText rule's formula (conditional.ts impliedFormula), COUNTIF and MATCH.
		expect(evaluate(host, `NOT(ISERROR(SEARCH("${pattern}",A1)))`)).toBe(false)
		expect(evaluate(host, `COUNTIF(A1,"${pattern}")`)).toBe(0)
		expect(evaluate(host, `MATCH("${pattern}",A1:A1,0)`)).toBe(FormulaError.NA)
		expect(evaluate(host, `COUNTIF(A1,"${pattern.slice(0, -1)}")`)).toBe(1)
		expect(performance.now() - start).toBeLessThan(budget(1_000))
	})
})

// A tile's cells evaluated as one pass: a range its rules read for every cell is read once, with the same results.
describe("rule formulas evaluated as one pass", () => {
	const formulas = [
		"COUNTIF($A$1:$A$50,$A1)>1",
		"ISNUMBER(MATCH($A1,$B$1:$B$50,0))",
		"VLOOKUP($A1,$B$1:$C$50,2,FALSE)",
		"SUMPRODUCT(($A$1:$A$50=$A1)*1)",
		'COUNTIF($A$1:$A$50,"<>"&$A1)'
	]

	function cells(): Record<string, Scalar> {
		const values: Record<string, Scalar> = {}

		for (let r = 1; r <= 50; r++) {
			values[`A${String(r)}`] = r % 7 === 0 ? String(r % 5) : r % 5
			values[`B${String(r)}`] = r % 3 === 0 ? `${String(r)}` : r
			values[`C${String(r)}`] = `c${String(r)}`
		}

		return values
	}

	// Each formula over the rows, in a pass or not; and how often each range was walked.
	function run(host: FormulaHost, pass: boolean): { results: Scalar[]; walks: Map<string, number> } {
		const walks = new Map<string, number>()
		const spied: FormulaHost = {
			...host,
			forEach: (ref, visit) => {
				const key = `${String(ref.startRow)}:${String(ref.startCol)}:${String(ref.endRow)}:${String(ref.endCol)}`

				walks.set(key, (walks.get(key) ?? 0) + 1)
				host.forEach(ref, visit)
			}
		}
		const evaluator = new FormulaEvaluator(spied)
		const results: Scalar[] = []
		const all = (): void => {
			for (const formula of formulas) {
				const parsed = parseFormula(formula)

				for (let row = 0; row < 50; row++)
					results.push(evaluator.scalar(evaluator.evaluate(parsed, { sheet: 0, anchorRow: 0, anchorCol: 4, row, col: 4 })))
			}
		}

		if (pass) evaluator.pass(all)
		else all()

		return { results, walks }
	}

	it("gives the results each cell gives alone, reading each range a bounded number of times", () => {
		const host = grid(cells())
		const alone = run(host, false)
		const passed = run(host, true)

		expect(passed.results).toEqual(alone.results)
		// Alone, the ranges are read once per cell or more; in a pass twice for each use made of them (asked, then
		// kept): column A's counts and its array.
		expect(Math.max(...alone.walks.values())).toBeGreaterThanOrEqual(50)
		expect(passed.walks.get("0:0:49:0")).toBe(4)
		expect(passed.walks.get("0:1:49:1")).toBe(2)
		expect(passed.walks.get("0:1:49:2")).toBe(2)
	})

	it("reads what changed in the next pass, on its own sheet and another", () => {
		const values = cells()
		const host = grid(values, {}, { One: 0, Two: 1 })
		const evaluator = new FormulaEvaluator(host)
		const first = (formula: string): Scalar[] =>
			evaluator.pass(() =>
				[0, 1, 2].map(row =>
					evaluator.scalar(evaluator.evaluate(parseFormula(formula), { sheet: 0, anchorRow: 0, anchorCol: 4, row, col: 4 }))
				)
			)

		expect(first("COUNTIF($A$1:$A$50,1)")).toEqual([9, 9, 9])
		expect(first("COUNTIF(Two!$A$1:$A$5,1)")).toEqual([0, 0, 0])

		const edited = grid({ ...values, A2: 1, "Two!A1": 1 }, {}, { One: 0, Two: 1 })
		const next = new FormulaEvaluator(edited)
		const again = (formula: string): Scalar[] =>
			next.pass(() =>
				[0, 1, 2].map(row =>
					next.scalar(next.evaluate(parseFormula(formula), { sheet: 0, anchorRow: 0, anchorCol: 4, row, col: 4 }))
				)
			)

		expect(again("COUNTIF($A$1:$A$50,1)")).toEqual([10, 10, 10])
		expect(again("COUNTIF(Two!$A$1:$A$5,1)")).toEqual([1, 1, 1])
	})

	it("keeps nothing past a pass: the host's next answer is read", () => {
		const values: Record<string, Scalar> = { A1: 1, A2: 1, A3: 2 }
		let host = grid(values)
		const evaluator = new FormulaEvaluator({
			value: (sheet, row, col) => host.value(sheet, row, col),
			forEach: (ref, visit) => {
				host.forEach(ref, visit)
			},
			extent: sheet => host.extent(sheet),
			sheetByName: name => host.sheetByName(name),
			definedName: (name, sheet) => host.definedName(name, sheet),
			today: () => host.today(),
			now: () => host.now(),
			date1904: false
		})
		const counts = (): Scalar[] =>
			evaluator.pass(() =>
				[0, 1, 2].map(row =>
					evaluator.scalar(
						evaluator.evaluate(parseFormula("COUNTIF($A$1:$A$3,1)"), { sheet: 0, anchorRow: 0, anchorCol: 1, row, col: 1 })
					)
				)
			)

		expect(counts()).toEqual([2, 2, 2])

		host = grid({ ...values, A3: 1 })

		expect(counts()).toEqual([3, 3, 3])
	})

	// A range read for one cell (a relative one, or one past what a pass keeps) is let go with the cell, not held to the
	// pass's end with what was made of it.
	it("holds no array read for a single cell until the pass ends", async () => {
		setFlagsFromString("--expose-gc")

		const gc = runInNewContext("gc") as () => void
		const values: Record<string, Scalar> = {}

		for (let r = 1; r <= 50; r++) {
			values[`A${String(r)}`] = r
			values[`B${String(r)}`] = r
		}

		const formulas = [
			"MATCH($A1,B1:B50,0)",
			"VLOOKUP($A1,B1:C50,1,FALSE)",
			// Kept from its second cell on, the next can no longer be: its arrays are each cell's own.
			"MATCH($A1,$D$1:$D$600000,0)",
			"MATCH($A1,$E$1:$E$600000,0)"
		]
		const evaluator = new FormulaEvaluator(grid(values, {}, { One: 0 }, { rows: 700_000, cols: 30 }))
		const read = evaluator.array.bind(evaluator)
		// What the collector let go of while the pass ran, by formula.
		const collected = formulas.map(() => 0)
		const registry = new FinalizationRegistry<number>(at => {
			collected[at] = (collected[at] ?? 0) + 1
		})
		let current = 0

		evaluator.array = value => {
			const array = read(value)

			registry.register(array, current)

			return array
		}

		evaluator.pass(() => {
			for (const [at, formula] of formulas.entries()) {
				const parsed = parseFormula(formula)

				current = at

				for (let row = 0; row < 5; row++)
					evaluator.scalar(evaluator.evaluate(parsed, { sheet: 0, anchorRow: 0, anchorCol: 25, row, col: 25 }))
			}

			gc()
		})

		// The registry reports in tasks of its own.
		for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0))

		// Every cell's own array; of the kept range, the first cell's (asked, not yet kept).
		expect(collected).toEqual([5, 5, 1, 5])
	})

	it("leaves data validation to see the entry under check", () => {
		const rule: DvRule = {
			ranges: [{ startRow: 0, startCol: 0, endRow: 49, endCol: 0 }],
			type: "custom",
			operator: "between",
			formula1: "COUNTIF($A$1:$A$50,A1)=1",
			formula2: null,
			allowBlank: true,
			hideDropDown: false,
			showInputMessage: false,
			showErrorMessage: true,
			errorStyle: "stop",
			errorTitle: null,
			error: null,
			promptTitle: null,
			prompt: null,
			extended: false
		}
		const host = grid({ A1: "x", A2: "y" })

		expect(meetsValidation(rule, { sheet: 0, row: 2, col: 0 }, "x", host)).toBe(false)
		expect(meetsValidation(rule, { sheet: 0, row: 2, col: 0 }, "z", host)).toBe(true)
		expect(meetsValidation(rule, { sheet: 0, row: 0, col: 0 }, "y", host)).toBe(false)
	})
})
