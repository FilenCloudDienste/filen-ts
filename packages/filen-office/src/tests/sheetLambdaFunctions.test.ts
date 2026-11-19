import { describe, expect, it } from "vitest"
import { FormulaEngine } from "../core/sheet/formula/index"
import { MAX_LEVELS } from "../core/sheet/formula/functions/lambda"
import { engineCellFormula, engineFormula, shownFormula, storedFormula } from "../core/sheet/refs/formulaRefs"
import { calculate as calculateTyped, type Typed } from "./sheetEngineFixtures"

// LET, LAMBDA and the LAMBDA helpers against their pages on support.microsoft.com (each case cites it). Formulas are
// typed as in Excel and stored as a file stores them (storedFormula: _xlfn. and _xlpm. prefixes).

function calculate(rows: Typed[][]): Record<string, unknown> {
	return calculateTyped(rows, { stored: true })
}

describe("LET", () => {
	it("binds names in order, each in scope from the next argument", () => {
		// "LET function": =LET(x, 5, SUM(x, 1)) returns 6.
		expect(calculate([["=LET(x, 5, SUM(x, 1))", "=LET(x,2,y,x*3,x+y)", "=LET(x,1,LET(x,x+10,x)+x)"]])).toEqual({
			A1: 6,
			B1: 8,
			C1: 12
		})
	})

	it("binds a range, which functions read as one", () => {
		expect(calculate([[1, 2, 3, "=LET(r,A1:C1,SUM(r)*COUNT(r))"]])).toEqual({ D1: 18 })
	})

	it("reads a cell its value names, and refuses a missing calculation", () => {
		expect(calculate([[4, "=LET(v,A1,v*v)", "=LET(x,1)", "=LET(x,1,y,2)"]])).toEqual({ B1: 16, C1: "!#VALUE!", D1: "!#VALUE!" })
	})
})

describe("LAMBDA", () => {
	it("is #CALC! when not called, and calls in place or by a LET name", () => {
		// "LAMBDA function": a LAMBDA in a cell without a call is #CALC!; =LAMBDA(number, number + 1)(1) returns 2.
		expect(calculate([["=LAMBDA(x,x+1)", "=LAMBDA(number, number + 1)(1)", "=LET(f,LAMBDA(a,b,a*b),f(3,4)+f(1,2))"]])).toEqual({
			A1: "!#CALC!",
			B1: 2,
			C1: 14
		})
	})

	it("is #VALUE! for the wrong number of arguments", () => {
		expect(calculate([["=LAMBDA(x,y,x+y)(1)", "=LAMBDA(x,x)(1,2)"]])).toEqual({ A1: "!#VALUE!", B1: "!#VALUE!" })
	})

	it("calls a parameter given a LAMBDA, stored with its prefix where it is called too", () => {
		// "LAMBDA function": a LAMBDA may be passed to another and called there; the file stores every use of a
		// parameter as _xlpm. (Excel reads a bare h( as an unknown function).
		const stored = "_xlfn.LET(_xlpm.g,_xlfn.LAMBDA(_xlpm.h,_xlpm.v,_xlpm.h(_xlpm.v)),_xlpm.g(_xlfn.LAMBDA(_xlpm.z,_xlpm.z*2),3))"

		expect(storedFormula(shownFormula(stored))).toBe(stored)
		expect(storedFormula("LAMBDA(n,SUM(n))")).toBe("_xlfn.LAMBDA(_xlpm.n,SUM(_xlpm.n))")
		expect(
			calculate([["=LET(g,LAMBDA(h,v,h(v)),g(LAMBDA(z,z*2),3))", "=LET(f,LAMBDA(me,n,IF(n<=0,0,n+me(me,n-1))),f(f,10))"]])
		).toEqual({ A1: 6, B1: 55 })
	})

	it("recurses as deep as MAX_LEVELS calls, whatever the engine's stack, and is #NUM! past it", () => {
		// "LAMBDA function": "Excel can return a #NUM! error if there are too many recursive calls". f(f,n) is n + 1 calls.
		const sum = (n: number): string => `=LET(f,LAMBDA(me,n,IF(n<=0,0,n+me(me,n-1))),f(f,${String(n)}))`
		// Each call evaluates twenty expressions inside one another.
		const deep = (n: number): string =>
			`=LET(f,LAMBDA(me,n,IF(n<=0,0,ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(ABS(1+me(me,n-1))))))))))))))))))),f(f,${String(n)}))`
		const last = MAX_LEVELS - 1

		expect(calculate([[sum(last), sum(last + 1), deep(150), sum(10)]])).toEqual({
			A1: (last * (last + 1)) / 2,
			B1: "!#NUM!",
			C1: 150,
			D1: 55
		})
	})

	it("never keeps or sets aside a call reaching a volatile function: each draws its own value, and too deep is #NUM!", () => {
		// "RAND function": a new random number every time it is calculated. f(f,n) recurses n times to RAND; g calls it
		// twice with the same arguments, deep enough that a call that may be set aside would be.
		const random = "f,LAMBDA(me,n,IF(n<=0,RAND(),me(me,n-1)))"
		const twice = (n: number): string => `=LET(${random},g,LAMBDA(n,f(f,n)-f(f,n)),g(${String(n)}))`
		const results = calculate([[twice(30), twice(30), twice(30), twice(200), "=LET(f,LAMBDA(me,n,IF(n<=0,1,me(me,n-1))),f(f,200))"]])

		expect([results["A1"], results["B1"], results["C1"]].every(value => typeof value === "number")).toBe(true)
		expect([results["A1"], results["B1"], results["C1"]].some(value => value !== 0)).toBe(true)
		expect(results["D1"]).toBe("!#NUM!")
		// Without a volatile function, the same depth calculates.
		expect(results["E1"]).toBe(1)
	})

	it("treats a defined name's LAMBDA reaching a volatile function the same way", () => {
		const lambdas = new Set(["RND"])
		const aliases = new Map<string, string>()
		const cell = (formula: string): string => engineCellFormula(storedFormula(formula), aliases, lambdas) ?? ""
		const engine = new FormulaEngine(
			[{ name: "S", rows: [[cell("LET(g,LAMBDA(n,Rnd(n)-Rnd(n)),g(30))"), cell("Rnd(200)")]], formulas: [] }],
			[{ name: "Rnd", expression: engineFormula(storedFormula("LAMBDA(n,IF(n<=0,RAND(),Rnd(n-1)))"), aliases, lambdas) }]
		)

		try {
			expect(engine.result(0, 0, 0).value).not.toBe(0)
			expect(engine.result(0, 0, 0).error).toBeUndefined()
			expect(engine.result(0, 0, 1)).toEqual({ value: "#NUM!", error: true })
		} finally {
			engine.destroy()
		}
	})

	it("reads IF's condition inside a LAMBDA as the engine's IF does outside one", () => {
		expect(
			calculate([["", '=IF("",1,2)', '=LAMBDA(x,IF("",1,2))(0)', "=LAMBDA(x,IF(A1,1,2))(0)", '=LAMBDA(x,IF("no",1,2))(0)']])
		).toEqual({
			B1: 2,
			C1: 2,
			D1: 2,
			E1: "!#VALUE!"
		})
	})

	it("calculates only the branch IF takes, so recursion ends at its last call", () => {
		// "IF function": the value_if_false is returned when the test is FALSE; the other is never needed.
		expect(
			calculate([["=LET(f,LAMBDA(me,n,IF(n=0,{1;2},VSTACK(me(me,n-1),n))),ROWS(f(f,300)))", '=LAMBDA(x,IF(x,,"no"))(TRUE)']])
		).toEqual({
			A1: 302,
			B1: 0
		})
	})

	it("gives each cell what it gives alone, however many recalculate together", () => {
		const cell = "=LET(f,LAMBDA(me,n,IF(n<=0,0,n+me(me,n-1))),f(f,1000))"
		const results = Object.values(calculate([Array.from({ length: 60 }, () => cell)]))

		expect(results).toEqual(Array.from({ length: 60 }, () => 500500))
	})

	it("tells long texts apart that differ only between their ends", () => {
		// Calls are found by a sample of a long text, then compared whole: texts alike at both ends stay apart.
		const text = (middle: number): string => `"${"a".repeat(300)}"&${String(middle)}&"${"b".repeat(300)}"`
		const list = `VSTACK(${[1, 2, 3, 2, 1].map(text).join(",")})`
		const sum = `=LET(f,LAMBDA(me,l,IF(ROWS(l)=1,VALUE(MID(INDEX(l,1),301,1)),VALUE(MID(INDEX(l,1),301,1))+me(me,DROP(l,1)))),g,LAMBDA(me,n,IF(n<=0,f(f,${list}),me(me,n-1))),g(g,60))`

		expect(calculate([[sum]])).toEqual({ A1: 9 })
	})

	it("recurses over a list of a thousand rows, and over a captured array of a thousand values", () => {
		// The common list recursion: the first value, then the LAMBDA over the rest (DROP).
		expect(
			calculate([
				[
					"=LET(f,LAMBDA(me,l,IF(ROWS(l)=1,INDEX(l,1),INDEX(l,1)+me(me,DROP(l,1)))),f(f,SEQUENCE(1000)))",
					"=LET(d,SEQUENCE(1000),f,LAMBDA(me,n,IF(n<=0,0,INDEX(d,n)+me(me,n-1))),f(f,1000))",
					'=LET(f,LAMBDA(me,n,IF(n<=0,0,ROWS(INDIRECT("A1:A"&n))+me(me,n-1))),f(f,300))',
					"=LET(f,LAMBDA(me,n,IF(n<=0,0,(TODAY()>0)+me(me,n-1))),f(f,300))"
				]
			])
		).toEqual({ A1: 500500, B1: 500500, C1: 45150, D1: 300 })
	})

	it("sees the names in scope where it is written, not where it is called", () => {
		expect(calculate([["=LET(y,1,f,LAMBDA(x,x+y),y,100,f(1))"]])).toEqual({ A1: 2 })
	})

	it("tells an argument left out (ISOMITTED)", () => {
		// "ISOMITTED function": =LAMBDA(x,y, IF(ISOMITTED(y),"Missing second argument",x+y))(1,)
		expect(
			calculate([
				[
					'=LAMBDA(x,y, IF(ISOMITTED(y),"Missing second argument",x+y))(1,)',
					'=LAMBDA(x,y, IF(ISOMITTED(y),"Missing second argument",x+y))(1,2)'
				]
			])
		).toEqual({ A1: "Missing second argument", B1: 3 })
	})
})

describe("the LAMBDA helpers", () => {
	it("MAP gives the LAMBDA of each value, over parallel arrays", () => {
		// "MAP function": =MAP(A1:C2, LAMBDA(a, IF(a>4,a*a,a))).
		expect(
			calculate([
				[1, 2, 5, "=INDEX(MAP(A1:C2, LAMBDA(a, IF(a>4,a*a,a))),1,3)", "=SUM(MAP(A1:C2,LAMBDA(a,IF(a>4,a*a,a))))"],
				[6, 3, 4, "=SUM(MAP(A1:C1,A2:C2,LAMBDA(a,b,a*b)))", "=MAP(A1:C1,LAMBDA(a,b,a))"]
			])
		).toEqual({ D1: 25, E1: 71, D2: 32, E2: "!#VALUE!" })
	})

	it("REDUCE folds, from the first value without an initial one; SCAN keeps each step", () => {
		// "REDUCE function": =REDUCE(, A1:C2, LAMBDA(a,b,a+b^2)) is the sum of squares.
		expect(
			calculate([
				[
					1,
					2,
					3,
					"=REDUCE(, A1:C2, LAMBDA(a,b,a+b^2))",
					"=REDUCE(1,A1:C2,LAMBDA(a,b,IF(b>2,a*b,a)))",
					"=INDEX(SCAN(0,A1:C1,LAMBDA(a,b,a+b)),1,3)"
				],
				[
					4,
					5,
					6,
					"=REDUCE(0,A1:C2,LAMBDA(a,n,IF(ISEVEN(n),1+a, a)))",
					"=SUM(SCAN(0,A2:C2,LAMBDA(a,b,a+b)))",
					"=REDUCE(0,A1:C1,LAMBDA(a,a))"
				]
			])
		).toEqual({ D1: 91, E1: 360, F1: 6, D2: 3, E2: 28, F2: "!#VALUE!" })
	})

	it("BYROW and BYCOL give one value per row or column; an array from the LAMBDA is #CALC!", () => {
		// "BYROW function": "anything but a single value returned from the LAMBDA function returns a #CALC error".
		expect(
			calculate([
				[
					1,
					2,
					"=INDEX(BYROW(A1:B2,LAMBDA(r,SUM(r))),2,1)",
					"=INDEX(BYCOL(A1:B2,LAMBDA(c,MAX(c))),1,2)",
					"=INDEX(BYROW(A1:B2,LAMBDA(r,r)),1,1)"
				],
				[3, 4, "=BYROW(A1:B2)", null, null]
			])
		).toEqual({ C1: 7, D1: 4, E1: "!#CALC!", C2: "!#CALC!" })
	})

	it("MAKEARRAY builds from 1-based positions and refuses a size below 1", () => {
		// "MAKEARRAY function": "Setting a row or col argument to a value < 1 or to a non-number returns a #VALUE! error."
		expect(
			calculate([
				[
					"=INDEX(MAKEARRAY(3,3,LAMBDA(r,c,r*c)),3,2)",
					"=SUM(MAKEARRAY(2,3,LAMBDA(r,c,r+c)))",
					"=MAKEARRAY(0,2,LAMBDA(r,c,1))",
					'=MAKEARRAY("a",2,LAMBDA(r,c,1))'
				]
			])
		).toEqual({ A1: 6, B1: 21, C1: "!#VALUE!", D1: "!#VALUE!" })
	})
})

describe("recalculation through LET and the LAMBDA helpers", () => {
	it("follows the cells they read, after rows are inserted too", () => {
		const formulas = ["=LET(x,A1,x*2)", "=SUM(MAP(A1:A2,LAMBDA(v,v*10)))", "=REDUCE(0,A1:A2,LAMBDA(a,b,a+b))"]
		const engine = new FormulaEngine(
			[{ name: "S", rows: [[1, ...formulas.map(text => engineCellFormula(storedFormula(text.slice(1))) ?? "")], [2]], formulas: [] }],
			[]
		)

		try {
			const values = (row: number): unknown[] => [1, 2, 3].map(col => engine.result(0, row, col).value)

			expect(values(0)).toEqual([2, 30, 3])
			engine.set(0, [{ row: 0, col: 0, content: 5 }])
			expect(values(0)).toEqual([10, 70, 7])
			engine.insert(0, "rows", 0, 1)
			engine.set(0, [{ row: 2, col: 0, content: 4 }])
			expect(values(1)).toEqual([10, 90, 9])
		} finally {
			engine.destroy()
		}
	})
})

describe("a function named in a LAMBDA's place", () => {
	it("is called with the values a helper gives (stored as _xleta.)", () => {
		expect(
			calculate([
				[1, 2, "=INDEX(BYROW(A1:B2,_xleta.SUM),2,1)", "=INDEX(BYCOL(A1:B2,_xleta.MAX),1,2)", "=SUM(MAP(A1:B2,_xleta.ABS))"],
				[-3, 4, "=REDUCE(0,A1:B2,_xleta.MAX)", null, null]
			])
		).toEqual({ C1: 1, D1: 4, E1: 10, C2: 4 })
	})
})
