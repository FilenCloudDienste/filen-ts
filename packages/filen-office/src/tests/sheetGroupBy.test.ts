import { describe, expect, it } from "vitest"
import { results as resultsBelow, type Typed } from "./sheetEngineFixtures"

// GROUPBY and PIVOTBY against their pages on support.microsoft.com ("GROUPBY function", "PIVOTBY function"). The
// pages show their example data only as pictures, so the examples run on a small table of the same shape (year,
// category, product, sales, units). Formulas are stored as a file stores them; a function in a LAMBDA's place is
// written as a file stores it (_xleta.SUM).

const DATA: Typed[][] = [
	["Year", "Category", "Product", "Sales", "Units"],
	[2023, "Fruit", "Apple", 10, 1],
	[2023, "Fruit", "Banana", 20, 2],
	[2023, "Veg", "Carrot", 5, 3],
	[2024, "Fruit", "apple", 30, 4],
	[2024, "Veg", "Carrot", 15, 5],
	[2024, "Veg", "Leek", 40, 6],
	[2022, "Fruit", "Banana", 7, 7]
]

// A number as the engine gives it (15 significant digits).
function close(value: number): unknown {
	return expect.closeTo(value, 12)
}

// The results of formulas written below the table, one per row.
function results(formulas: string[]): unknown[] {
	return resultsBelow(DATA, formulas, { stored: true })
}

// The size of a result and the values at the given 1-based positions.
function cells(formula: string, positions: [number, number][]): unknown[] {
	return results([
		`=ROWS(${formula})`,
		`=COLUMNS(${formula})`,
		...positions.map(([row, col]) => `=INDEX(${formula},${String(row)},${String(col)})`)
	])
}

describe("GROUPBY", () => {
	it("totals values by group, sorted, with a grand total", () => {
		// "GROUPBY function": =GROUPBY(A2:A76,D2:D76,SUM), total sales by year.
		expect(
			cells("GROUPBY(A2:A8,D2:D8,_xleta.SUM)", [
				[1, 1],
				[1, 2],
				[2, 2],
				[3, 1],
				[3, 2],
				[4, 1],
				[4, 2]
			])
		).toEqual([4, 2, 2022, 7, 35, 2024, 85, "Total", 127])
	})

	it("sorts by a value column descending", () => {
		// "GROUPBY function": =GROUPBY(C2:C76,D2:D76,SUM,,,-2), total sales by product, by sales descending. Text
		// groups case-insensitively, shown as first met; a tie keeps the groups' own order.
		expect(
			cells("GROUPBY(C2:C8,D2:D8,_xleta.SUM,,,-2)", [
				[1, 1],
				[1, 2],
				[2, 1],
				[3, 1],
				[3, 2],
				[4, 1],
				[5, 1]
			])
		).toEqual([5, 2, "Apple", 40, "Leek", "Banana", 27, "Carrot", "Total"])
	})

	it("guesses headers from text above a number, shown only with several group levels", () => {
		expect(
			results([
				"=ROWS(GROUPBY(A1:A8,D1:D8,_xleta.SUM))",
				"=INDEX(GROUPBY(A1:A8,D1:D8,_xleta.SUM),1,1)",
				"=ROWS(GROUPBY(A1:B8,D1:D8,_xleta.SUM))",
				"=INDEX(GROUPBY(A1:B8,D1:D8,_xleta.SUM),1,2)",
				"=INDEX(GROUPBY(A1:B8,D1:D8,_xleta.SUM),1,3)"
			])
		).toEqual([4, 2022, 10, "Category", "Sales"])
	})

	it("reads field_headers 0 to 3", () => {
		expect(
			results([
				"=ROWS(GROUPBY(A1:A8,D1:D8,_xleta.SUM,0))",
				"=INDEX(GROUPBY(A1:A8,D1:D8,_xleta.SUM,0),4,1)",
				"=ROWS(GROUPBY(A1:A8,D1:D8,_xleta.SUM,1))",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.SUM,2),1,1)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.SUM,2),1,2)",
				"=INDEX(GROUPBY(A1:A8,D1:D8,_xleta.SUM,3),1,1)",
				"=INDEX(GROUPBY(A1:A8,D1:D8,_xleta.SUM,3),2,2)",
				"=GROUPBY(A1:A8,D1:D8,_xleta.SUM,4)"
			])
		).toEqual([5, "Year", 4, "Row Field 1", "Value 1", "Year", 7, "!#VALUE!"])
	})

	it("adds subtotals by default with two row fields, below each group", () => {
		const formula = "GROUPBY(A2:B8,D2:D8,_xleta.SUM)"

		expect(
			cells(formula, [
				[1, 1],
				[1, 2],
				[1, 3],
				[2, 1],
				[2, 3],
				[5, 1],
				[5, 3],
				[9, 1],
				[9, 3]
			])
		).toEqual([9, 3, 2022, "Fruit", 7, 2022, 7, 2023, 35, "Total", 127])
		expect(results([`=ISBLANK(INDEX(${formula},2,2))`])).toEqual([true])
	})

	it("reads total_depth: none, grand totals only, and totals at the top", () => {
		expect(
			results([
				"=ROWS(GROUPBY(A2:A8,D2:D8,_xleta.SUM,,0))",
				"=ROWS(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,1))",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.SUM,,-1),1,1)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.SUM,,-1),2,1)",
				"=ROWS(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,-2))",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,-2),4,3)",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,-2),5,2)",
				"=ROWS(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,5))"
			])
		).toEqual([3, 6, "Total", 2022, 9, 35, "Fruit", 9])
	})

	it("sorts by row fields (a vector of them), and by a value within each level", () => {
		expect(
			results([
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,{-1,2}),1,1)",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,{-1,-2}),1,2)",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,-3),1,1)",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,-3),1,2)",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,-3),2,2)",
				"=INDEX(GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,-3),3,1)",
				"=GROUPBY(A2:B8,D2:D8,_xleta.SUM,,0,{1,3})",
				"=GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,0)",
				"=GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,3)"
			])
		).toEqual([2024, "Veg", 2024, "Veg", "Fruit", 2023, "!#VALUE!", "!#VALUE!", "!#VALUE!"])
	})

	it("keeps only the rows filter_array marks", () => {
		expect(
			results([
				'=ROWS(GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,,B2:B8="Fruit"))',
				'=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,,B2:B8="Fruit"),2,2)',
				'=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,,B2:B8="Fruit"),4,2)',
				'=GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,,B2:B8="x")',
				'=GROUPBY(A2:A8,D2:D8,_xleta.SUM,,,,B2:B7="Fruit")'
			])
		).toEqual([4, 30, 67, "!#CALC!", "!#VALUE!"])
	})

	it("sorts each field on its own in a table relationship, without subtotals", () => {
		const formula = "GROUPBY(A2:B8,D2:D8,_xleta.SUM,,,-2,,1)"

		expect(
			cells(formula, [
				[1, 1],
				[1, 2],
				[2, 1],
				[3, 1],
				[3, 2],
				[6, 3]
			])
		).toEqual([6, 3, 2023, "Veg", 2024, 2022, "Fruit", 127])
		expect(results(["=GROUPBY(A2:B8,D2:D8,_xleta.SUM,,,,,2)"])).toEqual(["!#VALUE!"])
	})

	it("calls a LAMBDA or a named function with each group's values", () => {
		expect(
			results([
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.AVERAGE),4,2)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.COUNT),2,2)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.PERCENTOF),3,2)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,_xleta.PERCENTOF),4,2)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,LAMBDA(x,MAX(x))),3,2)",
				"=INDEX(GROUPBY(A2:A8,D2:D8,LAMBDA(part,all,SUM(part)/SUM(all))),1,2)",
				"=INDEX(GROUPBY(A2:A8,C2:C8,_xleta.ARRAYTOTEXT),2,2)"
			])
		).toEqual([close(127 / 7), 3, close(85 / 127), 1, 40, close(7 / 127), "Apple, Banana, Carrot"])
	})

	it("lays several functions out by column (HSTACK) or by row (VSTACK), named in a header", () => {
		const across = "GROUPBY(A2:A8,D2:D8,HSTACK(_xleta.SUM,_xleta.AVERAGE))"
		const down = "GROUPBY(A2:A8,D2:D8,VSTACK(_xleta.SUM,_xleta.AVERAGE))"

		expect(
			cells(across, [
				[1, 2],
				[1, 3],
				[2, 2],
				[3, 3]
			])
		).toEqual([5, 3, "SUM", "AVERAGE", 7, close(35 / 3)])
		expect(
			cells(down, [
				[1, 2],
				[2, 2],
				[2, 3],
				[3, 1],
				[3, 3]
			])
		).toEqual([8, 3, "SUM", "AVERAGE", 7, 2023, 35])
	})

	it("aggregates several value columns", () => {
		expect(
			results([
				"=COLUMNS(GROUPBY(A2:A8,D2:E8,_xleta.SUM))",
				"=INDEX(GROUPBY(A2:A8,D2:E8,_xleta.SUM),3,3)",
				"=INDEX(GROUPBY(A1:A8,D1:E8,_xleta.SUM,3),1,3)"
			])
		).toEqual([3, 15, "Units"])
	})

	it("refuses mismatched sizes, a function that is not one, and a LAMBDA of the wrong arity", () => {
		expect(
			results([
				"=GROUPBY(A2:A8,D2:D7,_xleta.SUM)",
				"=GROUPBY(A2:A8,D2:D8,5)",
				"=GROUPBY(A2:A8,D2:D8,LAMBDA(a,b,c,a))",
				"=GROUPBY(A2:A8,D2:D8)"
			])
		).toEqual(["!#VALUE!", "!#VALUE!", "!#VALUE!", "!#VALUE!"])
	})
})

describe("PIVOTBY", () => {
	it("totals values by row and column groups", () => {
		// "PIVOTBY function": =PIVOTBY(C2:C76,A2:A76,D2:D76,SUM), total sales by product and year.
		const formula = "PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM)"

		expect(
			cells(formula, [
				[1, 2],
				[1, 4],
				[1, 5],
				[2, 1],
				[2, 4],
				[2, 5],
				[3, 2],
				[6, 1],
				[6, 5]
			])
		).toEqual([6, 5, 2022, 2024, "Total", "Apple", 30, 40, 7, "Total", 127])
		expect(results([`=ISBLANK(INDEX(${formula},2,2))`, `=ISBLANK(INDEX(${formula},1,1))`])).toEqual([true, true])
	})

	it("sorts rows by a value column descending", () => {
		// "PIVOTBY function": =PIVOTBY(C2:C76,A2:A76,D2:D76,SUM,,,-2).
		expect(
			results([
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,-2),2,1)",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,-2),3,1)",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,-2),4,1)"
			])
		).toEqual(["Apple", "Leek", "Banana"])
	})

	it("passes the set relative_to names as a two-argument function's second value", () => {
		expect(
			results([
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.PERCENTOF),2,4)",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.PERCENTOF,,,,,,,1),2,4)",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.PERCENTOF,,,,,,,2),2,4)",
				"=PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.PERCENTOF,,,,,,,5)"
			])
		).toEqual([close(30 / 85), 0.75, close(30 / 127), "!#VALUE!"])
	})

	it("reads col_total_depth and col_sort_order", () => {
		expect(
			results([
				"=COLUMNS(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,0))",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,-1),1,2)",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,,-1),1,2)",
				"=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,,-2),1,2)"
			])
		).toEqual([4, "Total", 2024, 2024])
	})

	it("shows the field headers with several row group levels, and subtotals", () => {
		const formula = "PIVOTBY(A1:B8,C1:C8,D1:D8,_xleta.SUM)"

		expect(
			cells(formula, [
				[1, 2],
				[1, 3],
				[2, 1],
				[2, 2],
				[2, 3],
				[3, 1],
				[3, 4],
				[4, 7],
				[11, 7]
			])
		).toEqual([11, 7, "Product", "Apple", "Year", "Category", "Sales", 2022, 7, 7, 127])
	})

	it("keeps only the rows filter_array marks", () => {
		expect(
			results([
				'=ROWS(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,,,B2:B8="Veg"))',
				'=COLUMNS(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,,,B2:B8="Veg"))',
				'=INDEX(PIVOTBY(C2:C8,A2:A8,D2:D8,_xleta.SUM,,,,,,B2:B8="Veg"),3,3)'
			])
		).toEqual([4, 4, 40])
	})

	it("refuses mismatched sizes", () => {
		expect(results(["=PIVOTBY(C2:C8,A2:A7,D2:D8,_xleta.SUM)", "=PIVOTBY(C2:C8,A2:A8,D2:D8)"])).toEqual(["!#VALUE!", "!#VALUE!"])
	})
})
