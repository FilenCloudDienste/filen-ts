import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula, spannedReferences } from "../core/sheet/refs/formulaRefs"
import { budget, cpuMs } from "./timing"

// A sheet as the workbook gives it to the engine: each formula in the engine's text.
function sheet(name: string, rows: EngineSheet["rows"], formulas: EngineSheet["formulas"] = []): EngineSheet {
	const engineText = <T>(value: T): T | string =>
		typeof value === "string" && value.startsWith("=") ? (engineCellFormula(value.slice(1)) ?? value) : value

	return {
		name,
		rows: rows.map(row => row.map(engineText)),
		formulas: formulas.map(cell => ({ ...cell, content: engineText(cell.content) }))
	}
}

function withEngine(sheets: EngineSheet[], check: (engine: FormulaEngine) => void, held?: () => void): void {
	const engine = new FormulaEngine(sheets, [], false, held)

	try {
		check(engine)
	} finally {
		engine.destroy()
	}
}

// The values of a sheet's column C after the engine built, row by row.
function columnC(engine: FormulaEngine, rows: number): unknown[] {
	return Array.from({ length: rows }, (_, row) => engine.result(0, row, 2).value)
}

describe("criteria functions", () => {
	it("count, sum, average and find extremes as Excel's do", () => {
		withEngine(
			[
				sheet("S", [
					["a", 1, '=COUNTIF(A1:A5,"a")'],
					["b", 2, '=SUMIF(A1:A5,"a",B1:B5)'],
					["a", "x", '=AVERAGEIF(A1:A5,"a",B1:B5)'],
					["a", 0, '=COUNTIFS(A1:A5,"a",B1:B5,">0")'],
					[null, 5, '=SUMIFS(B1:B5,A1:A5,"a",B1:B5,"<5")'],
					[null, null, '=MAXIFS(B1:B5,A1:A5,"zz")'],
					[null, null, '=MINIFS(B1:B5,A1:A5,"a")'],
					[null, null, "=AVERAGEIF(B4:B4,0)"],
					[null, null, '=COUNTIFS(A1:A5,"a",B1:B4,">0")'],
					[null, null, '=SUMIF(A1:A5,"")']
				])
			],
			engine => {
				expect(columnC(engine, 10)).toEqual([3, 1, 0.5, 1, 1, 0, 0, 0, "#VALUE!", 0])
			}
		)
	})

	it("give the first error among the cells they add up", () => {
		withEngine(
			[
				sheet("S", [
					["a", "=1/0", '=SUMIF(A1:A2,"a",B1:B2)'],
					["b", 2, '=SUMIF(A1:A2,"b",B1:B2)']
				])
			],
			engine => {
				expect(columnC(engine, 2)).toEqual(["#DIV/0!", 2])
			}
		)
	})

	it("keep no result per range and criterion: a running count over distinct values builds in linear memory", () => {
		const rows = 4000
		const cells: EngineSheet["rows"] = Array.from({ length: rows }, (_, row) => [
			`v${String(row)}`,
			row,
			`=COUNTIF($A$1:A${String(row + 1)},A${String(row + 1)})+SUMIF($A$1:A${String(row + 1)},A${String(row + 1)},$B$1:B${String(row + 1)})`
		])
		const start = cpuMs()

		withEngine([sheet("S", cells)], engine => {
			const elapsed = cpuMs() - start
			const ranges = (
				engine as unknown as {
					readonly engine: {
						readonly dependencyGraph: { readonly rangeMapping: { readonly rangeMapping: Map<number, Map<string, unknown>> } }
					}
				}
			).engine.dependencyGraph.rangeMapping.rangeMapping
			let cached = 0

			for (const vertex of ranges.get(0)?.values() ?? [])
				cached += (vertex as { readonly criterionFunctionCache: Map<unknown, unknown> }).criterionFunctionCache.size

			expect(cached).toBe(0)
			expect(engine.result(0, rows - 1, 2).value).toBe(1 + rows - 1)
			expect(elapsed).toBeLessThan(budget(4000))
		})
	})
})

describe("lookups", () => {
	it("build over one shared table without joining its cells again for each formula", () => {
		const rows = 5000
		const cells: EngineSheet["rows"] = Array.from({ length: rows }, (_, row) => [
			`v${String(row)}`,
			row,
			`=VLOOKUP(A${String(row + 1)},$A$1:$B$${String(rows)},2,FALSE)+MATCH(A${String(row + 1)},$A$1:$A$${String(rows)},0)+XLOOKUP(A${String(row + 1)},$A$1:$A$${String(rows)},$B$1:$B$${String(rows)})`
		])
		const start = cpuMs()

		withEngine([sheet("S", cells)], engine => {
			const elapsed = cpuMs() - start

			expect(engine.result(0, rows - 1, 2).value).toBe(3 * (rows - 1) + 1)
			expect(elapsed).toBeLessThan(budget(5000))
		})
	})
})

describe("text compared with accents and without case", () => {
	it("tells é from e in comparisons, criteria, lookups and UNIQUE", () => {
		withEngine(
			[
				sheet("S", [
					["résumé", 1, '="é"="e"'],
					["resume", 2, '=COUNTIF(A1:A2,"resume")'],
					[null, null, '=MATCH("resume",A1:A2,0)'],
					[null, null, '=VLOOKUP("resume",A1:B2,2,FALSE)'],
					[null, null, '=XLOOKUP("resume",A1:A2,B1:B2)'],
					[null, null, "=ROWS(UNIQUE(A1:A2))"],
					[null, null, '=MATCH("RESUME",A1:A2,0)'],
					[null, null, '="E"="e"'],
					[null, null, '=COUNTIF(A1:A2,"r*")'],
					[null, null, '=MATCH("RÉSUMÉ",A1:A2,0)']
				])
			],
			engine => {
				expect(columnC(engine, 10)).toEqual([false, 1, 2, 2, 2, 2, 2, true, 2, 1])
			}
		)
	})
})

describe("numbers at Excel's 15 digits", () => {
	it("keeps 1.0000000000001 and 1 apart, and 0.1+0.2 equal to 0.3", () => {
		withEngine(
			[
				sheet("S", [
					[1.0000000000001, 1, "=A1-B1"],
					[null, null, "=A1=B1"],
					[null, null, "=A1>B1"],
					[null, null, "=COUNTIF(A1:B1,1)"],
					[null, null, "=0.1+0.2=0.3"],
					[null, null, "=SUM(0.1,0.2)-0.3"]
				])
			],
			engine => {
				const [difference, ...rest] = columnC(engine, 6)

				expect(difference).not.toBe(0)
				expect(rest).toEqual([false, true, 1, true, 0])
			}
		)
	})
})

describe("Excel's newer error values", () => {
	it("reads a cell holding #NULL!, #CALC! or #GETTING_DATA as that error", () => {
		withEngine(
			[
				sheet("S", [
					["#NULL!", "=ISERROR(A1)", "=ERROR.TYPE(A1)"],
					["#CALC!", "=IFERROR(A2,7)", "=ERROR.TYPE(A2)"],
					["#GETTING_DATA", "=A3", "=ERROR.TYPE(A3)"],
					["#BUSY!", "=ISERR(A4)", "=ERROR.TYPE(A4)"],
					["#FIELD!", "=A5", "=ERROR.TYPE(A5)"]
				])
			],
			engine => {
				expect(columnC(engine, 5)).toEqual([1, 14, 8, "#N/A", 13])
				expect(engine.result(0, 0, 1)).toEqual({ value: true })
				expect(engine.result(0, 1, 1)).toEqual({ value: 7 })
				expect(engine.result(0, 2, 1)).toEqual({ value: "#GETTING_DATA", error: true })
				expect(engine.result(0, 3, 1)).toEqual({ value: true })
				expect(engine.result(0, 0, 0)).toEqual({ value: "#NULL!", error: true })
			}
		)
	})
})

describe("3-D references", () => {
	it("are spelled sheet by sheet as an argument of their own to SUM and its kind", () => {
		const functions = new Set(["SUM", "COUNT"])
		const sheets = ["Data", "Plan", "Mar 1", "Last"]

		expect(spannedReferences("SUM('Data:Mar 1'!A1)*2", sheets, functions)).toBe("SUM(Data!A1,Plan!A1,'Mar 1'!A1)*2")
		expect(spannedReferences("COUNT( Last:Plan!$A$1:B2 ,1)", sheets, functions)).toBe(
			"COUNT( Plan!$A$1:B2,'Mar 1'!$A$1:B2,Last!$A$1:B2 ,1)"
		)
		expect(spannedReferences("A1+1", sheets, functions)).toBe("A1+1")
		expect(spannedReferences("Data:Plan!A1+1", sheets, functions)).toBeNull()
		expect(spannedReferences("SUM(Data:Plan!A1+1)", sheets, functions)).toBeNull()
		expect(spannedReferences("VLOOKUP(1,Data:Plan!A1:B2,2)", sheets, functions)).toBeNull()
		expect(spannedReferences("SUM(Data:May!A1)", sheets, functions)).toBeNull()
		expect(spannedReferences('SUM(Data:Plan!A1,"(")', sheets, functions)).toBe('SUM(Data!A1,Plan!A1,"(")')
		// The engine's text quotes a 3-D reference whole.
		expect(engineCellFormula("SUM(Jan:Mar!A1)")).toBe("=SUM('Jan:Mar'!A1)")
	})

	it("calculate across the sheets between their ends, and follow an edit on one", () => {
		const engine = new FormulaEngine(
			[
				sheet("Jan", [[1], [10]]),
				sheet("Feb", [[2], ["x"]]),
				sheet("Mar", [[3], [30]]),
				sheet("Sum", [["=SUM(Jan:Mar!A1)", "=COUNT(Mar:Jan!A1:A2)", "=AVERAGE(Feb:Mar!A1)"]])
			],
			[],
			false,
			() => undefined
		)

		try {
			expect(engine.result(3, 0, 0)).toEqual({ value: 6 })
			expect(engine.result(3, 0, 1)).toEqual({ value: 5 })
			expect(engine.result(3, 0, 2)).toEqual({ value: 2.5 })

			const changed = engine.set(1, [{ row: 0, col: 0, content: 20 }])

			expect(changed.find(cell => cell.sheet === 3 && cell.col === 0)?.value).toBe(24)
			expect(engine.result(3, 0, 2)).toEqual({ value: 11.5 })
			expect(engine.set(3, [{ row: 1, col: 0, content: "=MAX(Jan:Feb!A2)", fallback: 0 }])[0]?.value).toBe(10)
		} finally {
			engine.destroy()
		}
	})

	it("keep the stored result where Excel takes no 3-D reference", () => {
		const held: string[] = []
		const engine = new FormulaEngine(
			[sheet("Jan", [[1]]), sheet("Feb", [["=Jan:Feb!A1+1"]], [{ row: 0, col: 0, content: "=Jan:Feb!A1+1", fallback: 9 }])],
			[],
			false,
			(sheetIndex, row, col) => held.push(`${String(sheetIndex)}:${String(row)},${String(col)}`)
		)

		try {
			expect(engine.result(1, 0, 0)).toEqual({ value: 9 })
			expect(held).toEqual(["1:0,0"])
		} finally {
			engine.destroy()
		}
	})
})
