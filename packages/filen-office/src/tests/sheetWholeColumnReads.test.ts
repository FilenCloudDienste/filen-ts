import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula, engineSpillFormula, storedFormula } from "../core/sheet/refs/formulaRefs"
import { cells, firstTile, openFixture, tileEntry } from "./sheetSessionFixtures"
import { budget } from "./timing"

// Whole-column references end at the last cell of the columns the sheet's whole-column references cover: a cell
// written in the grid's last row elsewhere leaves each recalculation reading those columns' cells only, and one
// written far below them in a covered column holds the formulas that would read a million rows each.

function engine(rows: EngineSheet["rows"], held: string[] = []): FormulaEngine {
	return new FormulaEngine([{ name: "S", rows, formulas: [] }], [], false, (_, row, col) => held.push(`${String(row)},${String(col)}`))
}

const LAST = 1_048_575

function formula(text: string): string {
	return engineCellFormula(storedFormula(text)) ?? ""
}

function spillFormula(text: string): string {
	return engineSpillFormula(storedFormula(text)) ?? ""
}

describe("whole-column references after a cell in the grid's last row", () => {
	it("keep an edit feeding whole-column SUMIFS fast", { timeout: 60_000 }, async () => {
		let rows = ""

		for (let r = 1; r <= 100; r++)
			rows += `<row r="${String(r)}"><c r="A${String(r)}"><v>${String(r)}</v></c><c r="B${String(r)}"><v>${String(r % 10)}</v></c><c r="D${String(r)}"><f>SUMIFS($A:$A,$B:$B,${String(r % 10)})</f></c></row>`

		const opened = await openFixture({ sheets: [{ name: "S", body: `<sheetData>${rows}</sheetData>` }] })
		const sheet = opened.info.sheets[0]?.id ?? 0
		const { session } = opened
		const timed = async (row: number, col: number, input: string): Promise<number> => {
			const start = performance.now()

			expect((await session.command({ type: "cells.set", sheet, cells: cells([[row, col, input]]) })).ok).toBe(true)

			return performance.now() - start
		}

		await session.intent()
		await timed(4, 1, "3")
		await timed(LAST, 4, "x")

		expect(await timed(5, 1, "7")).toBeLessThan(budget(2_000))
		expect(await timed(6, 0, "70")).toBeLessThan(budget(2_000))

		const tile = await firstTile(session, sheet)

		// Rows 7 and 17, 27… have criterion 7: 7 is B6's own row (A6 = 6) and A7 is now 70.
		expect(tileEntry(tile, 6, 3)?.text).toBe(String(6 + 70 + 17 + 27 + 37 + 47 + 57 + 67 + 77 + 87 + 97))
		session.close()
	})

	it("holds the whole-column formulas when a cell lands a million rows below their columns' cells", { timeout: 60_000 }, () => {
		const rows: EngineSheet["rows"] = []

		for (let r = 1; r <= 100; r++) rows.push([r, r % 10, null, `=SUMIFS($A:$A,$B:$B,${String(r % 10)})`])

		const held: string[] = []
		const built = engine(rows, held)

		try {
			const start = performance.now()

			built.set(0, [{ row: LAST, col: 0, content: 5 }])
			built.set(0, [{ row: 5, col: 1, content: 7 }])

			expect(performance.now() - start).toBeLessThan(budget(10_000))
			expect(held).toHaveLength(100)
			expect(built.result(0, 0, 3)).toEqual({ value: 460 })
		} finally {
			built.destroy()
		}
	})

	it("leaves formulas calculating as data grows down the columns they read", () => {
		const rows: EngineSheet["rows"] = []

		for (let r = 1; r <= 100; r++) rows.push([r, r % 10, null, `=SUMIFS($A:$A,$B:$B,${String(r % 10)})`])

		const held: string[] = []
		const built = engine(rows, held)

		try {
			built.set(
				0,
				Array.from({ length: 150 }, (_, i) => [
					{ row: 100 + i, col: 0, content: 1 },
					{ row: 100 + i, col: 1, content: 1 }
				]).flat()
			)

			expect(held).toEqual([])
			expect(built.result(0, 0, 3)).toEqual({ value: 1 + 11 + 21 + 31 + 41 + 51 + 61 + 71 + 81 + 91 + 150 })
		} finally {
			built.destroy()
		}
	})
})

describe("whole-column references ending at their columns' cells", () => {
	it("pair columns of different lengths, and read cells written past the end", () => {
		const rows: EngineSheet["rows"] = [
			[1, 1, 10, "=SUMIFS(C:C,B:B,1)", "=SUMPRODUCT(A:A,B:B)", "=SUM(A:A)"],
			[2, 1, 20],
			[3, 2]
		]

		for (let r = 3; r < 200; r++) rows.push([])

		rows.push([null, null, null, null, null, null, null, null, "far"])

		const built = engine(rows)

		try {
			expect([3, 4, 5].map(col => built.result(0, 0, col).value)).toEqual([30, 9, 6])

			built.set(0, [{ row: 500, col: 0, content: 100 }])

			expect(built.result(0, 0, 5)).toEqual({ value: 106 })

			built.set(0, [
				{ row: 600, col: 1, content: 1 },
				{ row: 600, col: 2, content: 1000 }
			])

			expect(built.result(0, 0, 3)).toEqual({ value: 1030 })
		} finally {
			built.destroy()
		}
	})

	it("read the moved cells after rows are inserted or removed above them", () => {
		const built = engine([[1, "=SUM(A:A)"], [2], [3]])

		try {
			built.insert(0, "rows", 0, 5)

			expect(built.result(0, 5, 1)).toEqual({ value: 6 })

			built.set(0, [{ row: 7, col: 0, content: 30 }])

			expect(built.result(0, 5, 1)).toEqual({ value: 33 })

			built.remove(0, "rows", 0, 5)
			built.set(0, [{ row: 1, col: 0, content: 20 }])

			expect(built.result(0, 0, 1)).toEqual({ value: 51 })
		} finally {
			built.destroy()
		}
	})

	it("read a spilled array's cells below the column's other cells", () => {
		const built = engine([[1, null, null, "=SUM(B:B)"], [2], [3], [], [], [null, "=ARRAYFORMULA(A1:A3*2)"]])

		try {
			expect(built.result(0, 0, 3)).toEqual({ value: 12 })

			built.set(0, [
				{ row: 0, col: 4, content: "=SUM(C:C)" },
				{ row: 10, col: 2, content: "=ARRAYFORMULA(A1:A3*10)" }
			])

			expect(built.result(0, 0, 4)).toEqual({ value: 60 })
		} finally {
			built.destroy()
		}
	})

	// A dynamic array writes the cells it spills straight into the engine: whole-column and whole-row references
	// read them though they land past the cells written before.
	it("read the cells a dynamic array spills below a column's or past a row's other cells", () => {
		const built = engine([
			[null, null, formula("SUM(A:A)")],
			[null, 1],
			[null, null, null, null, formula("SUM(2:2)")]
		])

		try {
			expect(built.result(0, 0, 2)).toEqual({ value: 0 })

			built.set(0, [{ row: 0, col: 0, content: spillFormula("SEQUENCE(10)"), spill: { rows: 1, cols: 1 } }])

			expect(built.result(0, 9, 0)).toEqual({ value: 10 })
			expect(built.result(0, 0, 2)).toEqual({ value: 55 })

			built.set(0, [{ row: 0, col: 5, content: formula("SUM(A:A)") }])

			expect(built.result(0, 0, 5)).toEqual({ value: 55 })

			built.set(0, [{ row: 1, col: 6, content: spillFormula("SEQUENCE(1,10)"), spill: { rows: 1, cols: 1 } }])

			expect(built.result(0, 1, 15)).toEqual({ value: 10 })
			expect(built.result(0, 2, 4)).toEqual({ value: 58 })

			// Shrunk: the cells it no longer reaches are read as empty.
			built.set(0, [{ row: 0, col: 0, content: spillFormula("SEQUENCE(3)") }])

			expect(built.result(0, 0, 2)).toEqual({ value: 6 })
		} finally {
			built.destroy()
		}
	})

	// A large spill is written in parts, each calculated: every part's cells are read, not only the first part's.
	it("read every cell of a dynamic array spilled in several parts", () => {
		const built = engine([[null, null, formula("SUM(A:A)")], [], [null, null, null, null, formula("SUM(2:2)")]])

		try {
			built.set(0, [{ row: 0, col: 0, content: spillFormula("SEQUENCE(10000)"), spill: { rows: 1, cols: 1 } }])

			expect(built.result(0, 9_999, 0)).toEqual({ value: 10_000 })
			expect(built.result(0, 0, 2)).toEqual({ value: 50_005_000 })

			built.set(0, [{ row: 0, col: 5, content: formula("SUM(A:A)") }])

			expect(built.result(0, 0, 5)).toEqual({ value: 50_005_000 })

			built.set(0, [{ row: 1, col: 6, content: spillFormula("SEQUENCE(1,10000)"), spill: { rows: 1, cols: 1 } }])

			expect(built.result(0, 1, 10_005)).toEqual({ value: 10_000 })
			// The row's A2 (2) of the column's spill too.
			expect(built.result(0, 2, 4)).toEqual({ value: 50_005_002 })
		} finally {
			built.destroy()
		}
	})

	it("read the cells a dynamic array spills on its first calculation after the build, past the file's cells", () => {
		const anchor = spillFormula("SEQUENCE(B1)")
		const built = new FormulaEngine(
			[
				{
					name: "S",
					rows: [[anchor, 1, formula("SUM(A:A)")]],
					formulas: [{ row: 0, col: 0, content: anchor, spill: { rows: 1, cols: 1 } }]
				}
			],
			[]
		)

		try {
			expect(built.result(0, 0, 2)).toEqual({ value: 1 })

			built.set(0, [{ row: 0, col: 1, content: 10 }])

			expect(built.result(0, 9, 0)).toEqual({ value: 10 })
			expect(built.result(0, 0, 2)).toEqual({ value: 55 })
		} finally {
			built.destroy()
		}
	})

	it("count every row of a whole column as Excel does, and read a row past the cells as empty", () => {
		const rows: EngineSheet["rows"] = [[1, 5, "=COUNTBLANK(A:A)", "=INDEX(B:B,150)", "=ROWS(A:A)"], [2]]

		for (let r = 2; r < 299; r++) rows.push([])

		rows.push([null, null, null, null, null, "=FILEN.INTERSECT(A:A)", "=FILEN.INTERSECT(1:1)"])

		const built = engine(rows)

		try {
			expect([2, 3, 4].map(col => built.result(0, 0, col).value)).toEqual([1_048_574, 0, 1_048_576])
			expect(built.result(0, 299, 5)).toEqual({ value: 0 })
			expect(built.result(0, 299, 6)).toEqual({ value: 0 })
		} finally {
			built.destroy()
		}
	})

	// Excel's columns have 1,048,576 rows: a blank-matching criterion counts every empty one, as COUNTBLANK does.
	it("count a whole column's blanks to its last row in COUNTIF, COUNTIFS and SUMPRODUCT, as COUNTBLANK does", () => {
		const rows: EngineSheet["rows"] = [
			[
				1,
				"x",
				"=COUNTBLANK(A:A)",
				'=COUNTIF(A:A,"")',
				'=ARRAYFORMULA(SUMPRODUCT(--(A:A="")))',
				'=COUNTIFS(A:A,"",B:B,"")',
				'=COUNTIF(A:A,"<>")',
				'=COUNTIF(A:A,"<>1")',
				"=ARRAYFORMULA(SUMPRODUCT((A:A=1)*1))",
				"=ARRAYFORMULA(SUMPRODUCT(1/A:A))",
				"=ARRAYFORMULA(SUMPRODUCT((A:A=MAX(A:A))*1))"
			],
			[2, null],
			[null, "y"]
		]
		const built = engine(rows)

		try {
			expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map(col => built.result(0, 0, col).value)).toEqual([
				1_048_574,
				1_048_574,
				1_048_574,
				1_048_573,
				2,
				1_048_575,
				1,
				"#DIV/0!",
				1
			])
		} finally {
			built.destroy()
		}
	})

	it("read a held cell written past their end, as any other cell", () => {
		const rows: EngineSheet["rows"] = Array.from({ length: 10 }, (_, r) => [r + 1])

		rows[0]?.push(null, "=SUM(A:A)", "=COUNTA(A:A)")

		const built = engine(rows)

		try {
			built.set(0, [{ row: 499, col: 0, content: "=Nope!A1" }])

			expect([2, 3].map(col => built.result(0, 0, col).value)).toEqual(["#REF!", 11])
		} finally {
			built.destroy()
		}
	})

	// Excel finds the first blank of A at A11, and LOOKUP's last match in the column's last row.
	it("find a blank past their end, the first and the last", () => {
		const rows: EngineSheet["rows"] = Array.from({ length: 100 }, (_, r) => (r < 10 ? [r + 1, 1] : [null, 1]))

		rows[0]?.push(
			null,
			"=ARRAYFORMULA(SUMPRODUCT(MATCH(TRUE(),ISBLANK(A:A),0)))",
			"=ARRAYFORMULA(XMATCH(TRUE(),ISBLANK(A:A)))",
			'=ARRAYFORMULA(LOOKUP(2,1/(A:A=""),ROW(A:A)))',
			"=ARRAYFORMULA(XMATCH(TRUE(),ISBLANK(A:A),0,-1))",
			"=ARRAYFORMULA(LOOKUP(2,1/(A:A=5),ROW(A:A)))"
		)

		const built = engine(rows)

		try {
			expect([3, 4, 5, 6].map(col => built.result(0, 0, col).value)).toEqual([11, 11, 1_048_576, 1_048_576])
			expect(built.result(0, 0, 7).value).not.toBe(1_048_576)
		} finally {
			built.destroy()
		}
	})

	it("pair whole columns of different sheets, whatever each sheet's length", () => {
		const one: EngineSheet["rows"] = Array.from({ length: 5 }, (_, r) => [null, (r + 1) * 10])
		const two: EngineSheet["rows"] = Array.from({ length: 50 }, (_, r) => [r < 5 ? "k" : "x"])

		one[0]?.push(null, '=SUMIFS(One!B:B,Two!A:A,"k")', '=ARRAYFORMULA(SUMPRODUCT(One!B:B,--(Two!A:A="x")))')

		const built = new FormulaEngine(
			[
				{ name: "One", rows: one, formulas: [] },
				{ name: "Two", rows: two, formulas: [] }
			],
			[],
			false,
			() => undefined
		)

		try {
			expect([3, 4].map(col => built.result(0, 0, col).value)).toEqual([150, 0])

			built.set(1, [{ row: 2, col: 0, content: "x" }])

			expect([3, 4].map(col => built.result(0, 0, col).value)).toEqual([120, 30])
		} finally {
			built.destroy()
		}
	})

	it("pair whole columns reached through defined names, names in names too, as direct references", () => {
		const one: EngineSheet["rows"] = Array.from({ length: 5 }, (_, r) => [null, (r + 1) * 10])
		const two: EngineSheet["rows"] = Array.from({ length: 50 }, (_, r) => [r < 5 ? "k" : "x"])

		one[0]?.push(null, '=SUMIFS(rngB,rngKeys,"k")')

		const built = new FormulaEngine(
			[
				{ name: "One", rows: one, formulas: [] },
				{ name: "Two", rows: two, formulas: [] }
			],
			[
				{ name: "rngB", expression: "One!$B:$B" },
				{ name: "rngA", expression: "Two!$A:$A" },
				{ name: "rngKeys", expression: "rngA" }
			],
			false,
			() => undefined
		)

		try {
			expect(built.result(0, 0, 3)).toEqual({ value: 150 })
		} finally {
			built.destroy()
		}
	})

	it("read ROW and COLUMN of a range as arrays where the call evaluates arrays", () => {
		const rows: EngineSheet["rows"] = Array.from({ length: 10 }, (_, r) => [r + 1])

		rows[0]?.push(
			null,
			"=ARRAYFORMULA(SUMPRODUCT(ROW(A1:A3)))",
			"=ARRAYFORMULA(SUMPRODUCT(COLUMN(A1:C1)))",
			"=ARRAYFORMULA(LOOKUP(2,1/(A:A=5),ROW(A:A)))",
			"=ROW(A3:A5)"
		)

		const built = engine(rows)

		try {
			expect([2, 3, 4, 5].map(col => built.result(0, 0, col).value)).toEqual([6, 6, 5, 3])
		} finally {
			built.destroy()
		}
	})

	// What reads a whole column's empty rows by position (or where the engine cannot tell what they give) is not
	// calculated: it keeps the file's result, or shows the engine's failure, never a value Excel would not give.
	it("hold what reads a whole column's empty rest by position, never a wrong value", () => {
		const rows: EngineSheet["rows"] = Array.from({ length: 10 }, (_, r) => [r + 1])
		const formulas = [
			'=ARRAYFORMULA(SUMPRODUCT(ROW(A:A)*(A:A="")))',
			"=INDEX((TAKE(A:A,-2)),1,1)",
			'=ARRAYFORMULA(SUMPRODUCT(ROW(A:A)*(A:A="")))'
		]

		rows[0]?.push(null, ...formulas)

		const built = new FormulaEngine(
			[
				{
					name: "S",
					rows,
					formulas: [
						{ row: 0, col: 2, content: formulas[0] ?? "", fallback: 549_755_289_545 },
						{ row: 0, col: 3, content: formulas[1] ?? "", fallback: 7 }
					]
				}
			],
			[],
			false,
			() => undefined
		)

		try {
			expect([2, 3].map(col => built.result(0, 0, col).value)).toEqual([549_755_289_545, 7])
			expect(built.result(0, 0, 4)).toEqual({ value: "#ERROR!", error: true })
		} finally {
			built.destroy()
		}
	})
})

describe("whole-column lookups over columns running to the grid's last row", () => {
	// 300 lookups over D:E, whose only cell past row 300 is in the grid's last row: each costs the cells there are.
	function lookups(formula: (row: number) => string): EngineSheet["rows"] {
		const rows: EngineSheet["rows"] = []

		for (let r = 1; r <= 300; r++) rows.push([r, formula(r), null, r, r * 10])

		while (rows.length < LAST) rows.push([])

		rows.push([null, null, null, null, "last"])

		return rows
	}

	it.each([
		["VLOOKUP", (r: number) => `=VLOOKUP(A${String(r)},$D:$E,2,0)`],
		["MATCH", (r: number) => `=INDEX($E:$E,MATCH(A${String(r)},$D:$D,0))`],
		["XLOOKUP", (r: number) => `=XLOOKUP(A${String(r)},$D:$D,$E:$E)`]
	])("builds the engine for %s in the time its cells take, and finds a value written below them", { timeout: 60_000 }, (_, formula) => {
		const rows = lookups(formula)
		const start = process.cpuUsage().user
		const built = engine(rows)

		try {
			expect((process.cpuUsage().user - start) / 1000).toBeLessThan(budget(3_000))
			expect(built.result(0, 0, 1)).toEqual({ value: 10 })
			expect(built.result(0, 299, 1)).toEqual({ value: 3000 })

			// A key no row holds yet, then written far below the others: the lookup reads it.
			built.set(0, [{ row: 0, col: 0, content: 777 }])

			expect(built.result(0, 0, 1).value).toBe("#N/A")

			built.set(0, [
				{ row: 5000, col: 3, content: 777 },
				{ row: 5000, col: 4, content: 7 }
			])

			expect(built.result(0, 0, 1)).toEqual({ value: 7 })
		} finally {
			built.destroy()
		}
	})
})
