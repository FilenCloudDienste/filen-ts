import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineCell, type EngineName, type EngineSheet, type RecalculatedCell } from "../core/sheet/formula/index"
import { sparseBlockCount, sparseRangeThreshold } from "../core/sheet/formula/sparseRanges"
import { engineCellFormula, engineSpillFormula, storedFormula } from "../core/sheet/refs/formulaRefs"
import type { SizeAxis } from "../core/sheet/sizes/sizes"
import { liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"

// Large finite blocks joined to the cells the sheet stores in them alone (formula/sparseRanges.ts): every result is
// the one the engine gives when it joins every address of the block, which these tests build side by side (the sparse
// join off) and compare after each edit.

// A cell as typed: "=..." a formula in Excel's syntax, "#=..." a dynamic-array one, "!=..." the engine's own formula
// text, anything else the value.
type Typed = string | number | boolean | null

function content(cell: Typed): EngineCell["content"] {
	if (typeof cell !== "string") return cell
	if (cell.startsWith("#=")) return engineSpillFormula(storedFormula(cell.slice(2))) ?? ""
	if (cell.startsWith("!=")) return cell.slice(1)
	if (cell.startsWith("=")) return engineCellFormula(storedFormula(cell.slice(1))) ?? ""

	return cell
}

// The size past which the sparse engine of a pair joins a block sparsely: small, so the full engine beside it builds
// quickly.
const SMALL = 200

function under<T>(cells: number, work: () => T): T {
	const previous = sparseRangeThreshold(cells)

	try {
		return work()
	} finally {
		sparseRangeThreshold(previous)
	}
}

interface Internals {
	readonly engine: {
		readonly dependencyGraph: { readonly addressMapping: { getStrategyForSheetOrThrow(sheet: number): { readonly mapping: unknown } } }
		getAllSheetsDimensions(): Record<string, { readonly width: number; readonly height: number }>
	}
}

function graphOf(engine: FormulaEngine): Internals["engine"]["dependencyGraph"] {
	return (engine as unknown as Internals).engine.dependencyGraph
}

type Grid = Map<string, Typed>

const key = (row: number, col: number): string => `${String(row)},${String(col)}`

function rowsOf(grid: Grid): EngineSheet["rows"] {
	const rows: EngineSheet["rows"] = []

	for (const [at, cell] of grid) {
		const [row = 0, col = 0] = at.split(",").map(Number)

		while (rows.length <= row) rows.push([])

		const line = rows[row] as EngineSheet["rows"][number]

		while (line.length <= col) line.push(null)

		line[col] = content(cell)
	}

	return rows
}

interface Spill {
	readonly sheet: number
	readonly row: number
	readonly col: number
}

// The sheets a pair is built from: each a grid of typed cells, and its dynamic arrays (their own cells, spilling 1×1
// as the file had them).
interface Book {
	readonly sheets: readonly { readonly name: string; readonly grid: Grid }[]
	readonly spills?: readonly Spill[]
	readonly names?: readonly EngineName[]
}

function engineOf(book: Book): FormulaEngine {
	return new FormulaEngine(
		book.sheets.map((sheet, index) => ({
			name: sheet.name,
			rows: rowsOf(sheet.grid),
			formulas: (book.spills ?? [])
				.filter(spill => spill.sheet === index)
				.map(({ row, col }) => ({ row, col, content: content(sheet.grid.get(key(row, col)) ?? null), spill: { rows: 1, cols: 1 } }))
		})),
		[...(book.names ?? [])]
	)
}

// Two engines over one workbook, the sparse join on in one and off in the other, edited alike.
class Pair {
	readonly sparse: FormulaEngine
	readonly full: FormulaEngine

	constructor(book: Book) {
		this.sparse = under(SMALL, () => engineOf(book))
		this.full = under(Number.POSITIVE_INFINITY, () => engineOf(book))
	}

	edit(work: (engine: FormulaEngine) => unknown): void {
		under(SMALL, () => work(this.sparse))
		under(Number.POSITIVE_INFINITY, () => work(this.full))
	}

	set(sheet: number, row: number, col: number, typed: Typed, spill = false): void {
		this.edit(engine => engine.set(sheet, [{ row, col, content: content(typed), ...(spill && { spill: { rows: 1, cols: 1 } }) }]))
	}

	blocks(): number {
		return sparseBlockCount(graphOf(this.sparse))
	}

	// Each engine's results of the cells listed, an error as "!" and its text.
	results(cells: readonly (readonly [number, number, number])[]): { sparse: unknown[]; full: unknown[] } {
		const read = (engine: FormulaEngine): unknown[] =>
			cells.map(([sheet, row, col]) => {
				const result = engine.result(sheet, row, col)

				return result.error === true ? `!${String(result.value)}` : result.value
			})

		return { sparse: read(this.sparse), full: read(this.full) }
	}

	// The results of the cells listed, and each sheet's height and width as the engine reads them (they decide whether
	// it applies a row or column inserted or removed, and where whole columns end).
	same(cells: readonly (readonly [number, number, number])[], step: string): void {
		const { sparse, full } = this.results(cells)

		expect(sparse, step).toEqual(full)

		const dimensions = (engine: FormulaEngine): unknown => (engine as unknown as Internals).engine.getAllSheetsDimensions()

		expect(dimensions(this.sparse), `${step}: sheet dimensions`).toEqual(dimensions(this.full))
	}

	// An edit, then the results of the cells listed, and the cells each engine reports recalculated: the sparse one
	// reports every one the full one does, as it does, and no other, but for cells whose value the edit left as it was
	// (the full join reports some of those). `source` is where a cell was before the edit (rows or columns moved), null
	// for one the edit made.
	step(
		work: (engine: FormulaEngine) => RecalculatedCell[],
		cells: readonly (readonly [number, number, number])[],
		step: string,
		source: (sheet: number, row: number, col: number) => readonly [number, number, number] | null = (sheet, row, col) => [
			sheet,
			row,
			col
		]
	): void {
		const value = (engine: FormulaEngine, [sheet, row, col]: readonly [number, number, number]): unknown => {
			const result = engine.result(sheet, row, col)

			return result.error === true ? `!${String(result.value)}` : result.value
		}
		const before = new Map(cells.map(cell => [cell.join(","), value(this.sparse, cell)]))
		const reported = (changes: readonly RecalculatedCell[]): Map<string, string> =>
			new Map(
				changes.map(change => [
					`${String(change.sheet)},${String(change.row)},${String(change.col)}`,
					JSON.stringify([change.value, change.error, change.stale, change.spill, change.spilled])
				])
			)
		const sparse = reported(under(SMALL, () => work(this.sparse)))
		const full = reported(under(Number.POSITIVE_INFINITY, () => work(this.full)))

		this.same(cells, step)

		for (const [at, change] of full) {
			if (sparse.has(at)) {
				expect(sparse.get(at), `${step}: change at ${at}`).toBe(change)

				continue
			}

			const [sheet = 0, row = 0, col = 0] = at.split(",").map(Number)
			const from = source(sheet, row, col)

			expect(from, `${step}: unreported change at ${at}`).not.toBeNull()
			expect(before.has(at), `${step}: change at ${at} outside the cells compared`).toBe(true)
			expect(value(this.sparse, [sheet, row, col]), `${step}: unreported change at ${at}`).toEqual(before.get(from?.join(",") ?? ""))
		}

		for (const at of sparse.keys()) expect(full.has(at), `${step}: change at ${at} the full join does not report`).toBe(true)
	}

	destroy(): void {
		this.sparse.destroy()
		this.full.destroy()
	}
}

// A seeded generator (mulberry32), so a failing case can be run again.
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// A random value of every kind a block may hold: numbers (whole and not), text (numeric text too), logical values,
// a formula's empty text, a formula reading a cell outside the block, and (`errors`) error values.
function value(next: () => number, errors: boolean): Typed {
	const kinds = errors ? 9 : 7

	switch (Math.floor(next() * kinds)) {
		case 0:
			return Math.floor(next() * 200) - 100
		case 1:
			return Math.round((next() * 20 - 10) * 1000) / 1000 + 0.1
		case 2:
			return ["a", "b", "10", " ", "TRUE"][Math.floor(next() * 5)] ?? "a"
		case 3:
			return next() < 0.5
		case 4:
			return '=""'
		case 5:
			return "=A1*2"
		case 6:
			return Math.floor(next() * 5)
		case 7:
			return "=1/0"
		default:
			return "=NA()"
	}
}

// The functions of the engine's aggregation read (its reduce), as Excel names them, aliases included.
const REDUCED = [
	"SUM",
	"SUMSQ",
	"MAX",
	"MIN",
	"MAXA",
	"MINA",
	"COUNT",
	"COUNTA",
	"AVERAGE",
	"AVERAGEA",
	"PRODUCT",
	"VAR.S",
	"VAR.P",
	"VARA",
	"VARPA",
	"STDEV.S",
	"STDEV.P",
	"STDEVA",
	"STDEVPA",
	"VAR",
	"VARP",
	"STDEV",
	"STDEVP"
]

const SUBTOTALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]

// What the tests read a block with: `block` a large block, `column` one column of it (a vector past SMALL cells),
// `other` a second block.
function readers(block: string, column: string, other: string): string[] {
	return [
		...REDUCED.map(name => `${name}(${block})`),
		...REDUCED.map(name => `${name}(${block},2,TRUE)`),
		...SUBTOTALS.map(code => `SUBTOTAL(${String(code)},${block})`),
		`COUNTBLANK(${block})`,
		`ROWS(${block})`,
		`COLUMNS(${block})`,
		`INDEX(${block},5,3)`,
		`INDEX(${block},1,1)`,
		`SUM(INDEX(${block},0,2))`,
		`MATCH(1,${column},0)`,
		`MATCH("a",${column},0)`,
		`MATCH(TRUE,${column},0)`,
		`MATCH(5,${column},1)`,
		`MATCH(5,${column},-1)`,
		`SUMPRODUCT(${block})`,
		`SUMPRODUCT(${block},${block})`,
		`SUMPRODUCT((${block}>0)*1)`,
		`SUMIF(${block},">0")`,
		`SUMIF(${block},"<>")`,
		`COUNTIF(${block},"a")`,
		`COUNTIF(${block},"")`,
		`COUNTIF(${block},">1")`,
		`MEDIAN(${block})`,
		`LARGE(${block},2)`,
		`AGGREGATE(9,6,${block})`,
		`SUM(${block})+COUNT(${block})`,
		`SUM(${block},${other})`,
		`COUNTA(${block},${other})`
	]
}

// A sheet "S" holding random cells in a block and beside it, and a sheet "F" of formulas reading it (whole columns and
// rows of S beside the blocks too: one over a block has it joined in full, tested below). `dense`: the block's first
// rows are filled, so the engine stores S densely.
function book(seed: number, errors: boolean, dense: boolean): { book: Book; formulas: number } {
	const next = random(seed)
	const grid: Grid = new Map()

	for (let row = 0; row < 20; row++) for (let col = 0; col < 3; col++) grid.set(key(row, col), Math.floor(next() * 50))

	if (dense) {
		for (let row = 0; row < 40; row++) for (let col = 3; col < 40; col++) if (next() < 0.9) grid.set(key(row, col), value(next, errors))
	}

	// Scattered over the block (dense: over its stored rows, which keep the sheet dense).
	for (let index = 0; index < 150; index++) {
		const row = 2 + Math.floor(next() * (dense ? 38 : 300))
		const col = 11 + Math.floor(next() * 30)

		grid.set(key(row, col), value(next, errors))
	}

	const formulas = [
		// A shorter block read once (sum alone), then the block one row longer: it reads the first's result and its own
		// last row, the first's stored cells for the functions read of it no other way.
		"SUM(S!P3:AS300)",
		"COUNT(S!P3:AS301)",
		"AVERAGE(S!P3:AS301)",
		"MAX(S!P3:AS301)",
		"COUNTA(S!P3:AS301)",
		"SUM(S!P3:AS301)",
		...readers("S!L3:AO300", "S!M3:M300", "S!AP1:BS300"),
		"SUM(S!A:A)",
		"COUNTA(S!A:C)",
		"COUNTBLANK(S!B:B)",
		"ROWS(S!A:A)",
		"SUM(S!310:320)",
		'SUM(INDIRECT("S!L3:AO300"))',
		"SUM(OFFSET(S!L3,0,0,298,30))"
	]
	const sheetF: Grid = new Map(formulas.map((formula, row) => [key(row, 0), `=${formula}`]))

	return {
		book: {
			sheets: [
				{ name: "S", grid },
				{ name: "F", grid: sheetF }
			]
		},
		formulas: formulas.length
	}
}

function formulaCells(count: number): [number, number, number][] {
	return Array.from({ length: count }, (_, row) => [1, row, 0] as [number, number, number])
}

// S's cells in the block and around it, as each engine shows them.
function sheetCells(rows: number, cols: number): [number, number, number][] {
	const cells: [number, number, number][] = []

	for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) cells.push([0, row, col])

	return cells
}

function strategy(engine: FormulaEngine, sheet: number): "sparse" | "dense" {
	return graphOf(engine).addressMapping.getStrategyForSheetOrThrow(sheet).mapping instanceof Map ? "sparse" : "dense"
}

describe("large blocks joined to their stored cells", () => {
	it("give every function the result of the full join, over random sparse and dense data", () => {
		for (const dense of [false, true]) {
			for (const errors of [false, true]) {
				for (let seed = 1; seed <= 4; seed++) {
					const { book: workbook, formulas } = book(seed * 7919 + (dense ? 1 : 0) + (errors ? 2 : 0), errors, dense)
					const pair = new Pair(workbook)

					try {
						expect(strategy(pair.sparse, 0)).toBe(dense ? "dense" : "sparse")
						expect(pair.blocks()).toBeGreaterThanOrEqual(3)
						pair.same(formulaCells(formulas), `seed ${String(seed)} dense ${String(dense)} errors ${String(errors)}`)

						// Not all errors: the comparison reads numbers.
						if (!errors) {
							const { sparse } = pair.results(formulaCells(formulas))

							expect(sparse.filter(result => typeof result === "number" && result !== 0).length).toBeGreaterThan(formulas / 2)
						}
					} finally {
						pair.destroy()
					}
				}
			}
		}
	})

	it("follow edits: cells set and cleared, written past the end, rows and columns inserted and removed, undone", () => {
		for (const dense of [false, true]) {
			const { book: workbook, formulas } = book(dense ? 31 : 17, false, dense)
			const pair = new Pair(workbook)
			const cells = [...formulaCells(formulas), ...sheetCells(12, 45)]
			let step = 0
			const check = (what: string): void => pair.same(cells, `${String(++step)} ${what} dense ${String(dense)}`)
			const move = (kind: "insert" | "remove", axis: SizeAxis, at: number, count: number, undoing = false): void =>
				pair.edit(engine =>
					kind === "insert" ? engine.insert(0, axis, at, count, undoing) : engine.remove(0, axis, at, count, undoing)
				)

			try {
				check("built")
				pair.set(0, 100, 20, 7)
				check("set a number in the block")
				pair.set(0, 100, 20, "a")
				check("set text over it")
				pair.set(0, 100, 20, "=1/0")
				check("an error")
				pair.set(0, 100, 20, null)
				check("cleared")
				pair.set(0, 150, 30, '=""')
				check("empty text")
				pair.set(0, 300, 12, 5)
				check("written past the end")
				move("insert", "rows", 150, 2)
				check("rows inserted in the block: the cell past the end is in it")
				pair.set(0, 301, 13, 4)
				check("written at the new end")
				move("remove", "rows", 150, 2, true)
				check("the insert undone")
				move("insert", "rows", 150, 2)
				check("and redone")
				move("insert", "rows", 0, 1)
				check("a row inserted before the block")
				move("remove", "rows", 0, 1)
				check("and removed")
				move("remove", "rows", 50, 3)
				check("rows removed in the block")
				move("insert", "rows", 50, 3, true)
				check("the removal undone (the rows back, empty)")
				move("insert", "cols", 20, 2)
				check("columns inserted in the block")
				pair.set(0, 10, 21, 9)
				check("written in an inserted column")
				move("remove", "cols", 20, 2, true)
				check("the insert undone")
				move("insert", "cols", 5, 1)
				check("a column inserted before the block")
				move("remove", "cols", 5, 1)
				check("and removed")
				move("remove", "cols", 12, 4)
				check("columns removed in the block")
				move("insert", "cols", 12, 4, true)
				check("the removal undone")
				move("remove", "rows", 0, 400)
				check("every row of the block removed")
				pair.set(0, 5, 15, 3)
				check("a cell written where the block was")
			} finally {
				pair.destroy()
			}
		}
	})

	it("read a formula inside the block that reads the block as the full join does", () => {
		const grid: Grid = new Map<string, Typed>([
			[key(0, 0), 1],
			[key(9, 12), "=SUM(L3:AO300)"],
			[key(10, 12), 4],
			[key(11, 0), "=COUNT(L3:AO300)"]
		])
		const pair = new Pair({ sheets: [{ name: "S", grid }] })

		try {
			const cells: [number, number, number][] = [
				[0, 9, 12],
				[0, 11, 0]
			]

			pair.same(cells, "built")
			pair.set(0, 20, 20, 5)
			pair.same(cells, "set")
		} finally {
			pair.destroy()
		}
	})

	it("read a one-column block's cells row by row whatever order they were written in", () => {
		const grid: Grid = new Map<string, Typed>([[key(0, 2), "=SUM(A1:A300)"]])
		const pair = new Pair({ sheets: [{ name: "S", grid }] })

		try {
			const cells: [number, number, number][] = [[0, 0, 2]]

			// Summed row by row, 1e20 and -1e20 cancel before 0.1 is added; in the order written, 0.1 is lost.
			pair.set(0, 249, 0, 0.1)
			pair.set(0, 99, 0, -1e20)
			pair.set(0, 49, 0, 1e20)
			pair.same(cells, "numbers written bottom up")
			expect(pair.results(cells).sparse).toEqual([0.1])
			expect(pair.blocks()).toBe(1)

			// The first error row by row is the one given.
			pair.set(0, 199, 0, "=1/0")
			pair.set(0, 9, 0, "=NA()")
			pair.same(cells, "errors written bottom up")
			expect(pair.results(cells).sparse).toEqual(["!#N/A"])
		} finally {
			pair.destroy()
		}
	})

	it("join a dynamic array spilling into a block, and an array formula spilling there", () => {
		const grid: Grid = new Map<string, Typed>([
			[key(0, 0), 3],
			[key(1, 0), 2],
			[key(2, 0), 1],
			[key(3, 0), "=SUM(L3:AO300)"],
			[key(4, 0), "=COUNT(L3:AO300)"],
			[key(5, 0), "=COUNTBLANK(L3:AO300)"],
			[key(6, 0), "=MAX(L3:AO300)"],
			[key(40, 13), "#=SEQUENCE(A1)"],
			[key(41, 13), 2],
			[key(42, 13), 3]
		])
		const pair = new Pair({ sheets: [{ name: "S", grid }], spills: [{ sheet: 0, row: 40, col: 13 }] })
		const cells = [...sheetCells(8, 2), ...sheetCells(60, 20)]

		try {
			expect(pair.blocks()).toBe(1)
			pair.same(cells, "built")
			pair.set(0, 0, 0, 6)
			pair.same(cells, "the dynamic array grown")
			pair.set(0, 0, 0, 1)
			pair.same(cells, "shrunk")
			// A new dynamic array spilling into the block.
			pair.set(0, 70, 14, "#=SEQUENCE(4,2,10)", true)
			pair.same([...cells, ...sheetCells(80, 20)], "spilled into the block")
			// An array formula of the engine's own (a predicted array, not a dynamic one) from outside the block (J51)
			// over its first column (L51).
			pair.set(0, 50, 9, "!=TRANSPOSE(A1:A3)")
			pair.same(cells, "an array formula spilled into the block")
			pair.set(0, 2, 0, 50)
			pair.same(cells, "its values changed")
			pair.set(0, 50, 11, 1)
			pair.same(cells, "a value in its way")
			pair.set(0, 50, 11, null)
			pair.same(cells, "cleared again")
			pair.set(0, 2, 0, 70)
			pair.same(cells, "its values changed again")
		} finally {
			pair.destroy()
		}
	})

	it("are read by dynamic arrays as the full join reads them", () => {
		const grid: Grid = new Map<string, Typed>([
			[key(0, 0), 2],
			[key(5, 12), 4],
			[key(8, 20), 6],
			[key(0, 2), "#=SUM(L3:AO300)*SEQUENCE(A1)"],
			[key(0, 4), "#=COUNTIF(L3:AO300,{4,6})"],
			[key(0, 7), "#=INDEX(L3:AO300,{4,7},{2,10})"]
		])
		const pair = new Pair({
			sheets: [{ name: "S", grid }],
			spills: [
				{ sheet: 0, row: 0, col: 2 },
				{ sheet: 0, row: 0, col: 4 },
				{ sheet: 0, row: 0, col: 7 }
			]
		})
		const cells = sheetCells(6, 10)

		try {
			expect(pair.blocks()).toBe(1)
			pair.same(cells, "built")
			pair.set(0, 0, 0, 3)
			pair.same(cells, "grown")
			pair.set(0, 100, 30, 6)
			pair.same(cells, "a cell of the block written")
		} finally {
			pair.destroy()
		}
	})

	it("are read again when the sheet holding them is removed", () => {
		const grid: Grid = new Map<string, Typed>([
			[key(0, 0), "=SUM(T!L3:AO300)"],
			[key(1, 0), "=COUNTBLANK(T!L3:AO300)"],
			[key(2, 0), "=ROWS(T!L3:AO300)"]
		])
		const other: Grid = new Map<string, Typed>([[key(0, 0), 1]])
		const pair = new Pair({
			sheets: [
				{ name: "S", grid },
				{ name: "T", grid: other }
			]
		})
		const cells = sheetCells(3, 1)

		try {
			pair.same(cells, "built")
			pair.edit(engine => engine.removeLastSheet())
			pair.same(cells, "the sheet removed")
			expect(pair.results(cells).sparse[0]).toBe("!#REF!")
		} finally {
			pair.destroy()
		}
	})

	it("tell what reads a cell of a block, an empty one included, as the full join does", () => {
		const grid: Grid = new Map<string, Typed>([
			[key(0, 0), "=SUM(L3:AO300)"],
			[key(1, 0), "=A1*2"],
			[key(2, 0), "=SUM(B:B)"],
			[key(3, 0), "=COUNT(N10:N20)"],
			[key(4, 0), "=SUM(L3:AO300)+COUNTA(L3:AO301)"],
			[key(10, 12), 5]
		])
		const pair = new Pair({ sheets: [{ name: "S", grid }] })
		const shown = (engine: FormulaEngine, row: number, col: number): string[] =>
			engine
				.dependents([{ sheet: 0, row, col }])
				.map(cell => `${String(cell.row)},${String(cell.col)}`)
				.sort()

		try {
			expect(pair.blocks()).toBe(1)

			for (const [row, col] of [
				[10, 12],
				[20, 12],
				[15, 13],
				[100, 30],
				[300, 30],
				[400, 30]
			] as const) {
				expect(shown(pair.sparse, row, col), `${String(row)},${String(col)}`).toEqual(shown(pair.full, row, col))
			}

			expect(shown(pair.sparse, 100, 30)).toEqual(["0,0", "1,0", "4,0"])
		} finally {
			pair.destroy()
		}
	})

	it("read a defined name over a block as the full join does", () => {
		const grid: Grid = new Map<string, Typed>([
			[key(0, 0), "=SUM(Big)"],
			[key(1, 0), "=COUNTA(Big)"],
			[key(2, 0), "=ROWS(Big)"],
			[key(5, 12), 4]
		])
		const pair = new Pair({ sheets: [{ name: "S", grid }], names: [{ name: "Big", expression: "S!$L$3:$AO$300" }] })
		const cells = sheetCells(3, 1)

		try {
			pair.same(cells, "built")
			pair.set(0, 50, 20, 6)
			pair.same(cells, "set")
			pair.edit(engine => engine.insert(0, "rows", 10, 1))
			pair.same(cells, "rows inserted")
		} finally {
			pair.destroy()
		}
	})
})

// Where a cell was before rows or columns were inserted (`count` > 0) or removed (`count` < 0) at `at` of sheet `moved`:
// null for one inserted.
function shifted(
	moved: number,
	axis: SizeAxis,
	at: number,
	count: number
): (sheet: number, row: number, col: number) => readonly [number, number, number] | null {
	return (sheet, row, col) => {
		const index = axis === "rows" ? row : col

		if (sheet !== moved || index < at) return [sheet, row, col]
		if (count > 0 && index < at + count) return null

		const before = index - count

		return axis === "rows" ? [sheet, before, col] : [sheet, row, before]
	}
}

describe("large blocks past the stored cells, under whole ranges, and on merged sheets", () => {
	// 20 rows of data in A:C, the block (and a name over it) reaching far past them, as the full engine's empty cells
	// made the sheet reach.
	function data(extra: readonly (readonly [number, number, Typed])[]): Grid {
		const grid: Grid = new Map()

		for (let row = 0; row < 20; row++) for (let col = 0; col < 3; col++) grid.set(key(row, col), row * (col + 1))

		for (const [row, col, cell] of extra) grid.set(key(row, col), cell)

		return grid
	}

	it("move with rows and columns inserted and removed past the sheet's stored cells", () => {
		const grid = data([
			[0, 4, "=SUM(L1:AO400)"],
			[1, 4, "=COUNTBLANK(L1:AO400)"],
			[2, 4, "=COUNT(L1:AO400)"],
			[3, 4, "=SUM(Big)"],
			[4, 4, "=COUNTA(Big)"],
			[5, 4, "=ROWS(Big)*100+COLUMNS(Big)"]
		])
		const pair = new Pair({ sheets: [{ name: "S", grid }], names: [{ name: "Big", expression: "S!$L$1:$AO$400" }] })
		const cells = [...sheetCells(8, 6), [0, 4, 11] as const, [0, 4, 40] as const, [0, 399, 11] as const, [0, 400, 11] as const]
		const move = (kind: "insert" | "remove", axis: SizeAxis, at: number, count: number): void =>
			pair.step(
				engine => (kind === "insert" ? engine.insert(0, axis, at, count) : engine.remove(0, axis, at, count)),
				cells,
				`${kind} ${axis} ${String(at)}+${String(count)}`,
				shifted(0, axis, at, kind === "insert" ? count : -count)
			)
		const write = (row: number, col: number, typed: Typed): void =>
			pair.step(engine => engine.set(0, [{ row, col, content: content(typed) }]), cells, `write ${String(row)},${String(col)}`)

		try {
			// The name's block is the formulas' own.
			expect(pair.blocks()).toBe(1)
			pair.same(cells, "built")
			move("insert", "rows", 30, 1)
			write(400, 11, 5)
			move("remove", "rows", 30, 1)
			write(399, 11, 6)
			move("remove", "rows", 30, 1)
			write(399, 11, 7)
			move("insert", "cols", 5, 1)
			write(4, 11, 5)
			move("remove", "cols", 5, 1)
			write(4, 40, 5)
			move("remove", "cols", 5, 1)
			write(4, 40, 6)
			// The far corner removed with the last rows and columns of the block: what is left reaches as far.
			move("remove", "rows", 390, 20)
			move("insert", "rows", 100, 2)
			write(380, 20, 8)
			move("remove", "cols", 38, 5)
			move("insert", "cols", 20, 1)
			write(10, 36, 9)
			// Past the block, then before it.
			move("insert", "rows", 600, 3)
			move("remove", "rows", 450, 3)
			move("insert", "rows", 0, 2)
			move("remove", "cols", 0, 1)
			expect(pair.blocks()).toBe(1)
		} finally {
			pair.destroy()
		}
	})

	it("move on a sheet that stores nothing, and give #REF! where the full join does", () => {
		const pair = new Pair({
			sheets: [
				{ name: "S", grid: new Map() },
				{ name: "F", grid: new Map<string, Typed>([[key(13, 2), '=XLOOKUP(5,S!G9:G300,S!I7:I300,"nf")']]) },
				{ name: "E", grid: new Map<string, Typed>([[key(23, 4), '=XLOOKUP(1,F!J9:J300,F!G1:G300,"nf")']]) }
			]
		})
		const cells: [number, number, number][] = [
			[2, 23, 4],
			[1, 13, 2]
		]
		const shown = (engine: FormulaEngine): string[] =>
			engine
				.dependents([{ sheet: 0, row: 41, col: 4 }])
				.map(cell => `${String(cell.sheet)},${String(cell.row)},${String(cell.col)}`)
				.sort()

		try {
			expect(pair.blocks()).toBe(4)
			pair.same(cells, "built")
			pair.step(engine => engine.remove(0, "cols", 2, 2), cells, "S columns C:D removed")
			expect(shown(pair.sparse)).toEqual(shown(pair.full))
			pair.step(engine => engine.remove(1, "cols", 9, 2), cells, "F columns J:K removed")
			expect(pair.results(cells).sparse[0]).toBe("!#REF!")
		} finally {
			pair.destroy()
		}
	})

	it("are joined in full under a whole column or row, read as far as the full join's empty cells reach", () => {
		for (const whole of ["=INDEX(M:M,500)", "=COUNTBLANK(M:M)", "=SUM(5:6)", "#=L:L"]) {
			const grid = data([[0, 4, "=SUM(L1:N400)"]])
			const pair = new Pair({ sheets: [{ name: "S", grid }] })
			const cells = [...sheetCells(12, 10), [0, 450, 6] as const]

			try {
				expect(pair.blocks()).toBe(1)
				pair.step(engine => engine.set(0, [{ row: 0, col: 8, content: content(whole), spill: { rows: 1, cols: 1 } }]), cells, whole)
				expect(pair.blocks(), whole).toBe(0)
				pair.step(engine => engine.set(0, [{ row: 5, col: 6, content: 9 }]), cells, `${whole}: G6 written`)
				pair.step(engine => engine.remove(0, "cols", 12, 1), cells, `${whole}: column M removed`)
				pair.step(engine => engine.remove(0, "rows", 4, 1), cells, `${whole}: row 5 removed`, shifted(0, "rows", 4, -1))
			} finally {
				pair.destroy()
			}
		}

		// The whole column first, or in the same formula: the block is never joined sparsely.
		for (const [first, second] of [
			["=SUM(M:M)", "=SUM(L1:N400)"],
			["=SUM(L1:N400)+SUM(M:M)", "=COUNT(L1:N400)"]
		] as const) {
			const pair = new Pair({ sheets: [{ name: "S", grid: data([[0, 4, first]]) }] })

			try {
				pair.step(engine => engine.set(0, [{ row: 1, col: 4, content: content(second) }]), sheetCells(3, 6), second)
				expect(pair.blocks()).toBe(0)
				pair.step(engine => engine.remove(0, "cols", 12, 1), sheetCells(3, 6), "column M removed")
			} finally {
				pair.destroy()
			}
		}

		// A whole column read through INDIRECT is no range of the graph: the block stays sparse, the column ends where
		// the block's empty cells made it end.
		const pair = new Pair({ sheets: [{ name: "S", grid: data([[0, 4, "=SUM(L1:N400)"]]) }] })

		try {
			for (const [row, formula] of [
				'=INDEX(INDIRECT("M:M"),500)',
				'=COUNTBLANK(INDIRECT("M:M"))',
				'=ROWS(INDIRECT("M:M"))',
				'=MATCH(TRUE,ISBLANK(INDIRECT("M:M")),0)'
			].entries())
				pair.step(engine => engine.set(0, [{ row, col: 8, content: content(formula) }]), sheetCells(6, 10), formula)

			expect(pair.blocks()).toBe(1)
		} finally {
			pair.destroy()
		}
	})

	it("are joined in full when a placeholder sheet is merged into theirs, and read again as the full join does", () => {
		for (const blockFirst of [false, true]) {
			const pair = new Pair({
				sheets: [
					{ name: "S", grid: new Map<string, Typed>([[key(23, 6), 791.896865]]) },
					{ name: "F", grid: new Map() }
				]
			})
			const cells = [...sheetCells(30, 8), [1, 13, 4] as const, [1, 11, 0] as const]
			const formula = (row: number, col: number, typed: Typed, step: string): void =>
				pair.step(
					engine => engine.set(1, [{ row, col, content: content(typed) }]),
					cells,
					`${step} block first ${String(blockFirst)}`
				)
			const rename = (name: string): void => pair.step(engine => engine.renameSheet(0, name), cells, `renamed ${name}`)

			try {
				if (blockFirst) formula(11, 0, "=AVERAGE(S!E11:G90)", "the block")

				rename("S2")
				// S is a sheet the workbook lacks now: a placeholder.
				formula(13, 4, blockFirst ? "=SUM(S!B:J)+COUNT(S!E11:G90)" : "=SUM(S!B:J)", "the whole range")
				rename("S")

				if (!blockFirst) formula(11, 0, "=AVERAGE(S!E11:G90)", "the block")

				expect(pair.blocks()).toBe(0)
				pair.step(engine => engine.remove(0, "cols", 6, 1), cells, "column G removed")
			} finally {
				pair.destroy()
			}
		}
	})

	it("reach as far when their sheet is removed and added again after their corner went", () => {
		const pair = new Pair({
			sheets: [
				{ name: "S", grid: new Map<string, Typed>([[key(0, 0), "=SUM(T!L1:AO400)+COUNTBLANK(T!L1:AO400)"]]) },
				{ name: "T", grid: data([]) }
			]
		})
		const cells = sheetCells(2, 2)

		try {
			expect(pair.blocks()).toBe(1)
			pair.step(engine => engine.remove(1, "rows", 380, 30), cells, "the block's last rows removed")
			pair.step(engine => engine.remove(1, "cols", 35, 10), cells, "its last columns removed")
			pair.step(engine => engine.removeLastSheet(), cells, "T removed")
			pair.step(engine => engine.addSheet("T"), cells, "T added again")
			pair.step(engine => engine.insert(1, "rows", 300, 2), cells, "rows inserted in the block")
			pair.step(engine => engine.set(1, [{ row: 370, col: 11, content: 4 }]), cells, "written at its end")
		} finally {
			pair.destroy()
		}
	})

	it("are joined in full when their removed sheet's name is given to another sheet", () => {
		const pair = new Pair({
			sheets: [
				{ name: "S", grid: new Map<string, Typed>([[key(0, 0), "=SUM(T!L1:AO400)+COUNTBLANK(T!L1:AO400)"]]) },
				{
					name: "U",
					grid: data([
						[5, 12, 4],
						[399, 40, 2]
					])
				},
				{ name: "T", grid: data([[50, 20, 3]]) }
			]
		})
		const cells = sheetCells(2, 2)

		try {
			expect(pair.blocks()).toBe(1)
			pair.step(engine => engine.removeLastSheet(), cells, "T removed")
			pair.step(engine => engine.renameSheet(1, "T"), cells, "U renamed T")
			expect(pair.blocks()).toBe(0)
			pair.step(engine => engine.set(1, [{ row: 5, col: 12, content: null }]), cells, "a cell of the block cleared")
			pair.step(engine => engine.remove(1, "rows", 390, 20), cells, "the block's last rows removed")
		} finally {
			pair.destroy()
		}
	})

	it("recalculate what reads a block when an empty cell of it is cleared", () => {
		const grid = new Map<string, Typed>([
			[key(2, 0), 1],
			[key(3, 1), 2],
			[key(70, 25), "zz"],
			[key(11, 9), "#=TRANSPOSE(A3:C6)"],
			[key(13, 11), '#=COUNTIF(D6:H50,{1,"a",2})'],
			[key(30, 12), "=COUNTA(D6:H50)+COUNTBLANK(D6:H50)"]
		])
		const pair = new Pair({
			sheets: [{ name: "S", grid }],
			spills: [
				{ sheet: 0, row: 11, col: 9 },
				{ sheet: 0, row: 13, col: 11 }
			]
		})
		const cells = sheetCells(32, 14)

		try {
			expect(pair.blocks()).toBe(1)
			pair.same(cells, "built")
			pair.step(engine => engine.set(0, [{ row: 19, col: 3, content: null }]), cells, "an empty cell of the block cleared")
			pair.step(engine => engine.set(0, [{ row: 19, col: 3, content: 1 }]), cells, "written")
			pair.step(engine => engine.set(0, [{ row: 19, col: 3, content: null }]), cells, "cleared")
			pair.step(engine => engine.set(0, [{ row: 40, col: 7, content: null }]), cells, "another empty one cleared")
		} finally {
			pair.destroy()
		}
	})
})

describe("large blocks, cost", () => {
	// A workbook of 20 rows of data and formulas over a block of two million addresses: the engine joined every
	// address, more than a second and half a gigabyte for each block.
	function rows(extra: Typed[][]): Grid {
		const grid: Grid = new Map()

		for (let row = 0; row < 20; row++) for (let col = 0; col < 3; col++) grid.set(key(row, col), row * (col + 1))

		extra.forEach((line, index) => line.forEach((cell, col) => grid.set(key(20 + index, col), cell)))

		return grid
	}

	it("builds a block, two blocks in one formula and an unused name over a block in milliseconds", () => {
		const heap = liveHeapNow()
		const started = cpuMs()
		const engine = engineOf({
			sheets: [
				{
					name: "S",
					grid: rows([["=SUM(L1:AO69000)", "=SUM(L1:AO69000)+SUM(AP1:BS69000)", "=COUNTBLANK(L1:AO69000)", "=ROWS(L1:AO69000)"]])
				}
			],
			names: [{ name: "Big", expression: "S!$L$1:$AO$69000" }]
		})

		try {
			const spent = cpuMs() - started

			expect(spent).toBeLessThan(budget(400))
			// Held after collection, the engine alive: the full join held about 1.5 GB for these three.
			expect(liveHeapNow() - heap).toBeLessThan(32 * 1024 * 1024)
			expect([0, 1, 2, 3].map(col => engine.result(0, 20, col).value)).toEqual([0, 0, 2_070_000, 69_000])
			expect(sparseBlockCount(graphOf(engine))).toBe(2)

			const edited = cpuMs()

			engine.set(0, [{ row: 5000, col: 20, content: 7 }])
			engine.set(0, [{ row: 5000, col: 50, content: 3 }])
			expect([0, 1, 2].map(col => engine.result(0, 20, col).value)).toEqual([7, 10, 2_069_999])
			engine.insert(0, "rows", 100, 1)
			engine.set(0, [{ row: 69000, col: 11, content: 5 }])
			expect([0, 1, 2, 3].map(col => engine.result(0, 20, col).value)).toEqual([12, 15, 2_070_028, 69_001])
			engine.remove(0, "rows", 100, 1)
			expect([0, 1, 2, 3].map(col => engine.result(0, 20, col).value)).toEqual([12, 15, 2_069_998, 69_000])
			// COUNTBLANK reads every address at each recalculation (about 60 ms here), the sums their stored cells.
			expect(cpuMs() - edited).toBeLessThan(budget(1200))
			expect(liveHeapNow() - heap).toBeLessThan(32 * 1024 * 1024)
		} finally {
			engine.destroy()
		}
	})

	it("builds and edits an unused name over a block in milliseconds", () => {
		const heap = liveHeapNow()
		const started = cpuMs()
		const engine = engineOf({
			sheets: [{ name: "S", grid: rows([[1]]) }],
			names: [{ name: "Big", expression: "S!$L$1:$AO$69000" }]
		})

		try {
			expect(cpuMs() - started).toBeLessThan(budget(150))

			// Each edit in the block recalculates the name: its value (the block) was exported address by address.
			const edited = cpuMs()

			engine.set(0, [{ row: 5000, col: 20, content: 7 }])
			engine.set(0, [{ row: 5000, col: 20, content: null }])
			engine.insert(0, "rows", 100, 1)
			engine.remove(0, "rows", 100, 1)

			expect(cpuMs() - edited).toBeLessThan(budget(150))
			expect(liveHeapNow() - heap).toBeLessThan(32 * 1024 * 1024)
		} finally {
			engine.destroy()
		}
	})

	// The least CPU time of three rounds of 40 edits of stored cells of the block A`first + 1`:E`first + height` of a
	// table of `table` rows of five columns, each edit recalculating a SUM of the block in column `formulaCol` (a
	// blank column before it keeps the sheet in the engine's map storage, none in its dense one), with the sparse join
	// past `cells`.
	function editCost(
		table: number,
		first: number,
		height: number,
		formulaCol: number,
		cells: number
	): { readonly ms: number; readonly sum: unknown; readonly blocks: number; readonly dense: boolean } {
		const grid: Grid = new Map()

		for (let row = 0; row < table; row++) for (let col = 0; col < 5; col++) grid.set(key(row, col), (row * 5 + col) % 997)

		grid.set(key(0, formulaCol), `=SUM(A${String(first + 1)}:E${String(first + height)})`)

		return under(cells, () => {
			const engine = engineOf({ sheets: [{ name: "S", grid }] })

			try {
				let best = Number.POSITIVE_INFINITY

				for (let round = 0; round < 3; round++) {
					const started = cpuMs()

					for (let edit = 0; edit < 40; edit++) {
						engine.set(0, [{ row: first + ((edit * 331) % height), col: edit % 5, content: round * 40 + edit }])
					}

					best = Math.min(best, cpuMs() - started)
				}

				return {
					ms: best,
					sum: engine.result(0, 0, formulaCol).value,
					blocks: sparseBlockCount(graphOf(engine)),
					dense: Array.isArray(graphOf(engine).addressMapping.getStrategyForSheetOrThrow(0).mapping)
				}
			} finally {
				engine.destroy()
			}
		})
	}

	// 13,200 × 5 = 66,000 stored cells: the sparse read looks up the block's addresses where it stores most of them,
	// never more than the engine's read does.
	const HEIGHT = 13_200

	it.each([
		["the whole table, in map storage", HEIGHT, 0, 6, false],
		["the last rows of a table four times taller, in map storage", HEIGHT * 4, HEIGHT * 3, 6, false],
		["the last rows of a table four times taller, in dense storage", HEIGHT * 4, HEIGHT * 3, 5, true]
	] as const)(
		"recalculates an aggregate over a fully stored block just over the threshold, %s, no slower than with the sparse join off",
		(_case, table, first, formulaCol, dense) => {
			const off = editCost(table, first, HEIGHT, formulaCol, Number.POSITIVE_INFINITY)
			const sparse = editCost(table, first, HEIGHT, formulaCol, 65_536)

			expect(sparse.blocks).toBe(1)
			expect(off.blocks).toBe(0)
			expect([sparse.dense, off.dense]).toEqual([dense, dense])
			expect(sparse.sum).toBe(off.sum)
			// A slice of a taller table is read by the block's rows only, well under the engine's own read; a walk over every
			// row the columns store would sit at or above it.
			expect(sparse.ms).toBeLessThan(first > 0 ? off.ms * 0.8 : off.ms * 1.15 + budget(5))
		}
	)

	it("keeps 200 blocks each one row longer than the one before chained, building and editing them in milliseconds", () => {
		const heap = liveHeapNow()
		const started = cpuMs()
		const engine = engineOf({
			sheets: [{ name: "S", grid: rows(Array.from({ length: 200 }, (_, index) => [`=SUM(L1:AO${String(69_000 + index)})`])) }]
		})

		try {
			expect(cpuMs() - started).toBeLessThan(budget(300))
			// The first is joined to its stored cells, each other one to the one before and its own last row.
			expect(sparseBlockCount(graphOf(engine))).toBe(1)

			const edited = cpuMs()

			engine.set(0, [{ row: 5000, col: 20, content: 7 }])
			engine.set(0, [{ row: 69_100, col: 20, content: 2 }])
			engine.insert(0, "rows", 100, 1)
			engine.remove(0, "rows", 101, 1)

			expect(cpuMs() - edited).toBeLessThan(budget(300))
			expect([0, 100, 102, 199].map(index => engine.result(0, 20 + index, 0).value)).toEqual([7, 7, 9, 9])
			// The full join held about 600 MB.
			expect(liveHeapNow() - heap).toBeLessThan(32 * 1024 * 1024)
		} finally {
			engine.destroy()
		}
	})
})
