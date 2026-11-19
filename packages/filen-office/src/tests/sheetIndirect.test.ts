import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { SheetCommand, SheetCommandResult, SheetSessionApi, SheetTile } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { buildXlsx } from "./oracles/sheet/synthetic"
import { FormulaEngine, type EngineName, type EngineSheet, type RecalculatedCell } from "../core/sheet/formula/index"
import { EngineStaleError } from "../core/sheet/formula/formulaEngine"
import { engineCellFormula, storedFormula } from "../core/sheet/refs/formulaRefs"
import { budget, cpuMs } from "./timing"

// INDIRECT (support.microsoft.com "INDIRECT function"): the reference a text names, A1 or R1C1, a defined name's
// included; calculated again whenever a cell it read changes, though the engine never linked it to that cell.

type Typed = string | number | boolean | null

function engineRows(rows: Typed[][]): EngineSheet["rows"] {
	return rows.map(row =>
		row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(storedFormula(cell.slice(1))) ?? "") : cell))
	)
}

function build(rows: Typed[][], other: Typed[][] = [], names: EngineName[] = []): FormulaEngine {
	return new FormulaEngine(
		[
			{ name: "S", rows: engineRows(rows), formulas: [] },
			{ name: "My Sheet", rows: engineRows(other), formulas: [] }
		],
		names
	)
}

function value(engine: FormulaEngine, a1: string, sheet = 0): unknown {
	const col = a1.charCodeAt(0) - 65
	const row = Number(a1.slice(1)) - 1
	const result = engine.result(sheet, row, col)

	return result.error === true ? `!${String(result.value)}` : result.value
}

function set(engine: FormulaEngine, a1: string, content: Typed): RecalculatedCell[] {
	const [cell] = engineRows([[content]])

	return engine.set(0, [{ row: Number(a1.slice(1)) - 1, col: a1.charCodeAt(0) - 65, content: cell?.[0] ?? null }])
}

describe("INDIRECT", () => {
	it("reads the reference a text names, in A1 or R1C1 style", () => {
		// "INDIRECT function": =INDIRECT(A2) gives the value of the cell A2 names; a1 FALSE reads R1C1.
		const engine = build(
			[
				[1, "B2", '=INDIRECT("A1")', "=INDIRECT(B1)", '=INDIRECT("R1C1",FALSE)', '=INDIRECT("R[1]C[-5]",FALSE)'],
				[
					2,
					7,
					'=SUM(INDIRECT("A1:A3"))',
					"=INDIRECT(\"'My Sheet'!B1\")",
					'=SUM(INDIRECT("A:A"))',
					'=COUNTIF(INDIRECT("A1:A3"),">1")'
				],
				[3, null, '=INDIRECT("nonsense")', '=INDIRECT("[1]S!A1")', '=INDIRECT("Nowhere!A1")', '=INDIRECT("F3")']
			],
			[[null, "x"]]
		)

		try {
			expect([value(engine, "C1"), value(engine, "D1"), value(engine, "E1"), value(engine, "F1")]).toEqual([1, 7, 1, 2])
			expect([value(engine, "C2"), value(engine, "D2"), value(engine, "E2"), value(engine, "F2")]).toEqual([6, "x", 6, 2])
			expect([value(engine, "C3"), value(engine, "D3"), value(engine, "E3")]).toEqual(["!#REF!", "!#REF!", "!#REF!"])
			// Its own cell: a circle.
			expect(value(engine, "F3")).toBe("!#CYCLE!")
		} finally {
			engine.destroy()
		}
	})

	it("reads a defined name, the sheet's own scope first", () => {
		const engine = build(
			[[1, 2, 3, '=SUM(INDIRECT("Data"))', '=INDIRECT("Total")']],
			[],
			[
				{ name: "Data", expression: "S!$A$1:$C$1" },
				{ name: "Total", expression: "S!$D$1" },
				{ name: "Data", expression: "S!$A$1", scope: 0 }
			]
		)

		try {
			expect([value(engine, "D1"), value(engine, "E1")]).toEqual([1, 1])
		} finally {
			engine.destroy()
		}
	})

	it("calculates again when a cell it read changes, a value or a formula, and reports it", () => {
		const engine = build([[1, '=INDIRECT("A1")', "=B1*10", "=E1*2", 5, '=INDIRECT("D1")+1']])

		try {
			expect([value(engine, "B1"), value(engine, "C1"), value(engine, "F1")]).toEqual([1, 10, 11])

			const changes = set(engine, "A1", 4)

			expect(changes.map(cell => `${String(cell.col)}=${String(cell.value)}`).sort()).toEqual(["0=4", "1=4", "2=40"])

			// E1 changes D1, a formula, which F1 reads through INDIRECT.
			set(engine, "E1", 50)
			expect(value(engine, "F1")).toBe(101)
		} finally {
			engine.destroy()
		}
	})

	it("is right at the first calculation whatever order it comes in", () => {
		const engine = build([['=INDIRECT("B1")*2', "=C1+1", "=D1*3", 2, '=INDIRECT("A1")+INDIRECT("B1")']])

		try {
			expect([value(engine, "A1"), value(engine, "E1")]).toEqual([14, 21])
		} finally {
			engine.destroy()
		}
	})

	it("follows the text, not the cells, when rows are inserted", () => {
		const engine = build([['=INDIRECT("A3")'], [null], [9]])

		try {
			engine.insert(0, "rows", 0, 1)
			// A3 now holds nothing: the 9 moved to A4.
			expect(value(engine, "A2")).toBe(0)
		} finally {
			engine.destroy()
		}
	})

	it("reads a new reference when its text changes", () => {
		const engine = build([[1, 2, "A1", "=INDIRECT(C1)"]])

		try {
			expect(value(engine, "D1")).toBe(1)
			set(engine, "C1", "B1")
			expect(value(engine, "D1")).toBe(2)
			set(engine, "B1", 3)
			expect(value(engine, "D1")).toBe(3)
			// A1 is no longer read.
			expect(set(engine, "A1", 8).map(cell => cell.col)).toEqual([0])
		} finally {
			engine.destroy()
		}
	})
	// The engine moves its own names with the cells; INDIRECT reads a name's text, moved with them too.
	describe("reads a defined name where row and column edits and sheet renames move it", () => {
		const rates = (): FormulaEngine =>
			build(
				[[null, null, '=SUM(INDIRECT("Rates"))', "=SUM(Rates)"], [1], [2], [3]],
				[],
				[{ name: "Rates", expression: "S!$A$2:$A$4" }]
			)
		const both = (engine: FormulaEngine, at = 1): unknown[] => [value(engine, `C${String(at)}`), value(engine, `D${String(at)}`)]

		it("after rows inserted before and inside it, and undone", () => {
			const engine = rates()

			try {
				engine.insert(0, "rows", 1, 2)

				expect(both(engine)).toEqual([6, 6])

				engine.remove(0, "rows", 1, 2)

				expect(both(engine)).toEqual([6, 6])

				engine.insert(0, "rows", 2, 1)
				set(engine, "A3", 10)

				expect(both(engine)).toEqual([16, 16])

				engine.remove(0, "rows", 2, 1)

				expect(both(engine)).toEqual([6, 6])
			} finally {
				engine.destroy()
			}
		})

		it("after rows deleted before and inside it, and undone", () => {
			const engine = build(
				[[null, null, '=SUM(INDIRECT("Rates"))', "=SUM(Rates)"], [], [1], [2], [3]],
				[],
				[{ name: "Rates", expression: "S!$A$3:$A$5" }]
			)

			try {
				engine.remove(0, "rows", 1, 1)

				expect(both(engine)).toEqual([6, 6])

				engine.insert(0, "rows", 1, 1)

				expect(both(engine)).toEqual([6, 6])

				engine.remove(0, "rows", 3, 1)

				expect(both(engine)).toEqual([4, 4])

				engine.insert(0, "rows", 3, 1)
				set(engine, "A4", 2)

				expect(both(engine)).toEqual([6, 6])
			} finally {
				engine.destroy()
			}
		})

		it("after columns inserted and deleted before and inside it, and undone", () => {
			const engine = build(
				[['=SUM(INDIRECT("Rates"))', null, 1, 2, 3], ["=SUM(Rates)"]],
				[],
				[{ name: "Rates", expression: "S!$C$1:$E$1" }]
			)
			const cols = (): unknown[] => [value(engine, "A1"), value(engine, "A2")]

			try {
				engine.insert(0, "cols", 1, 2)

				expect(cols()).toEqual([6, 6])

				engine.remove(0, "cols", 1, 2)

				expect(cols()).toEqual([6, 6])

				engine.remove(0, "cols", 3, 1)

				expect(cols()).toEqual([4, 4])

				engine.insert(0, "cols", 3, 1)
				set(engine, "D1", 2)

				expect(cols()).toEqual([6, 6])

				engine.insert(0, "cols", 3, 1)
				set(engine, "D1", 10)

				expect(cols()).toEqual([16, 16])
			} finally {
				engine.destroy()
			}
		})

		it("after the rows it reads are all deleted, and undone", () => {
			const engine = rates()

			try {
				engine.remove(0, "rows", 1, 3)

				expect(both(engine)).toEqual(["!#REF!", "!#REF!"])

				// The edit's undo: told so by its caller.
				engine.insert(0, "rows", 1, 3, true)
				engine.set(0, [
					{ row: 1, col: 0, content: 1 },
					{ row: 2, col: 0, content: 2 },
					{ row: 3, col: 0, content: 3 }
				])

				expect(both(engine)).toEqual([6, 6])
			} finally {
				engine.destroy()
			}
		})

		it("refuses, before moving anything, the undo of a deletion it holds no record of", () => {
			// Made on another engine, or recorded past the bound: what it cut is not known here.
			const engine = rates()

			try {
				expect(() => engine.insert(0, "rows", 1, 3, true)).toThrow(EngineStaleError)
				expect(both(engine)).toEqual([6, 6])
			} finally {
				engine.destroy()
			}
		})

		// Undo runs last first: an edit made after the deletion is undone before it, and the deletion's undo still restores.
		describe.each([
			{ cut: "all of it", at: 1, count: 3, left: "!#REF!" },
			{ cut: "its end", at: 2, count: 2, left: 1 }
		])("after a deletion of $cut, another edit made and undone, and the deletion undone", ({ at, count, left }) => {
			const undone = (between: (engine: FormulaEngine) => void): void => {
				const engine = rates()

				try {
					engine.remove(0, "rows", at, count)
					between(engine)

					expect(both(engine)).toEqual([left, left])

					engine.insert(0, "rows", at, count, true)
					engine.set(
						0,
						Array.from({ length: count }, (_, offset) => ({ row: at + offset, col: 0, content: at + offset }))
					)

					expect(both(engine)).toEqual([6, 6])
				} finally {
					engine.destroy()
				}
			}

			it("a column inserted and removed", () => {
				undone(engine => {
					engine.insert(0, "cols", 6, 1)
					engine.remove(0, "cols", 6, 1)
				})
			})

			it("another sheet renamed and renamed back", () => {
				undone(engine => {
					engine.renameSheet(1, "Other")
					engine.renameSheet(1, "My Sheet")
				})
			})

			it("another deletion of the rows it reads made and undone", () => {
				undone(engine => {
					engine.remove(0, "rows", 1, 1)
					engine.insert(0, "rows", 1, 1, true)

					if (left === 1) set(engine, "A2", 1)
				})
			})
		})

		// Each deletion's undo takes back its own: a later one of the same rows that cut nothing does not restore the
		// earlier one's, which is not undone (the workbook's name stays as that one left it).
		describe.each([
			{ cut: "all of it", at: 1, count: 3, left: "!#REF!" },
			{ cut: "its end", at: 2, count: 2, left: 1 }
		])("after the same rows deleted twice, cutting $cut, and the second deletion undone", ({ at, count, left }) => {
			it("stays as the first deletion left it", () => {
				const engine = rates()

				try {
					engine.remove(0, "rows", at, count)
					engine.remove(0, "rows", at, count)
					engine.insert(0, "rows", at, count, true)
					engine.set(
						0,
						Array.from({ length: count }, (_, offset) => ({ row: at + offset, col: 0, content: at + offset }))
					)

					expect(both(engine)).toEqual([left, left])
				} finally {
					engine.destroy()
				}
			})
		})

		// An insert's undo is no deletion: the deletion before the insert still takes back its own.
		it("after the rows it reads are all deleted, inserted again, that insert undone, and the deletion undone", () => {
			const engine = rates()

			try {
				engine.remove(0, "rows", 1, 3)
				engine.insert(0, "rows", 1, 3)
				engine.remove(0, "rows", 1, 3, true)
				engine.insert(0, "rows", 1, 3, true)
				engine.set(0, [
					{ row: 1, col: 0, content: 1 },
					{ row: 2, col: 0, content: 2 },
					{ row: 3, col: 0, content: 3 }
				])

				expect(both(engine)).toEqual([6, 6])
			} finally {
				engine.destroy()
			}
		})

		// The same rows inserted again as a new edit are not the deletion undone: the name stays #REF!, as the workbook's.
		it("after the rows it reads are all deleted and new ones inserted in their place", () => {
			const engine = rates()

			try {
				engine.remove(0, "rows", 1, 3)
				set(engine, "F1", 1)
				engine.insert(0, "rows", 1, 3)
				set(engine, "A2", 7)
				set(engine, "A3", 8)

				expect(both(engine)).toEqual(["!#REF!", "!#REF!"])
			} finally {
				engine.destroy()
			}
		})

		it("after the sheet it names is renamed, and renamed back", () => {
			const engine = build(
				[['=SUM(INDIRECT("Rates"))', "=SUM(Rates)"]],
				[[1], [2], [3]],
				[{ name: "Rates", expression: "'My Sheet'!$A$1:$A$3" }]
			)

			try {
				engine.renameSheet(1, "Data2")

				expect([value(engine, "A1"), value(engine, "B1")]).toEqual([6, 6])

				engine.renameSheet(1, "My Sheet")

				expect([value(engine, "A1"), value(engine, "B1")]).toEqual([6, 6])
			} finally {
				engine.destroy()
			}
		})

		it("of its own sheet after another is removed, and not of a removed sheet's that a new one takes the place of", () => {
			const engine = build(
				[['=SUM(INDIRECT("Local"))']],
				[[1], [2]],
				[
					{ name: "Local", expression: "S!$B$1:$B$2", scope: 0 },
					{ name: "Gone", expression: "'My Sheet'!$A$1:$A$2", scope: 1 }
				]
			)

			try {
				engine.set(0, [
					{ row: 0, col: 1, content: 4 },
					{ row: 1, col: 1, content: 5 }
				])
				engine.removeLastSheet()

				expect(value(engine, "A1")).toBe(9)

				engine.addSheet("My Sheet")
				engine.set(1, [
					{ row: 0, col: 0, content: 7 },
					{ row: 1, col: 0, content: 8 },
					{ row: 0, col: 1, content: engineRows([['=SUM(INDIRECT("Gone"))']])[0]?.[0] ?? null }
				])

				expect(value(engine, "B1", 1)).toBe("!#REF!")
			} finally {
				engine.destroy()
			}
		})
	})
})

describe("INDIRECT in a workbook", () => {
	const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }

	async function texts(session: SheetSessionApi, sheet: number, cells: readonly string[]): Promise<string[]> {
		const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0))
		const tile = tiles[0] as SheetTile

		return cells.map(cell => {
			const position = ((Number(cell.slice(1)) - 1) << 5) | (cell.charCodeAt(0) - 65)

			for (let i = 0; i < tile.count; i++) {
				if (tile.positions[i] !== position) continue

				const text = tile.texts[i] ?? -1

				return text < 0 ? "" : (tile.strings[text] ?? "")
			}

			return ""
		})
	}

	function ok(result: SheetCommandResult): void {
		if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)
	}

	it("calculates again at once when a sheet is renamed, added or deleted, one that named no sheet too", async () => {
		// "INDIRECT function": a reference to a sheet the workbook lacks is #REF!; INDIRECT is volatile.
		const bytes = buildXlsx({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1"><f>INDIRECT("T!A1")</f><v>5</v></c><c r="B1" t="e"><f>INDIRECT("\'U\'!A1")</f><v>#REF!</v></c></row></sheetData>'
				},
				{ name: "T", body: '<sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData>' }
			],
			application: { name: "Microsoft Excel", version: "16.0300" },
			calcPr: 'calcId="191029"'
		})
		const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0
		const other = info.sheets[1]?.id ?? 0

		await session.tiles(sheet, Uint32Array.of(0, 0))
		await session.intent()
		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(1), cols: Uint16Array.of(0), inputs: ["1"] } }))
		expect(await texts(session, sheet, ["A1", "B1"])).toEqual(["5", "#REF!"])

		ok(await session.command({ type: "sheet.rename", sheet: other, name: "U" }))
		expect(await texts(session, sheet, ["A1", "B1"])).toEqual(["#REF!", "5"])

		const saved = await session.save()

		if (!saved.ok) throw new Error(saved.reason)
		expect(strFromU8(unzipSync(saved.bytes)["xl/worksheets/sheet1.xml"] as Uint8Array)).toContain(
			'<c r="A1" t="e"><f>INDIRECT("T!A1")</f><v>#REF!</v></c>'
		)

		ok(await session.command({ type: "sheet.add", name: "T" }))
		expect(await texts(session, sheet, ["A1", "B1"])).toEqual(["0", "5"])

		ok(await session.undo())
		expect(await texts(session, sheet, ["A1", "B1"])).toEqual(["#REF!", "5"])
		ok(await session.undo())
		expect(await texts(session, sheet, ["A1", "B1"])).toEqual(["5", "#REF!"])

		ok(await session.command({ type: "sheet.delete", sheet: other }))
		expect(await texts(session, sheet, ["A1", "B1"])).toEqual(["#REF!", "#REF!"])
		session.close()
	})

	it("recalculates what reads a 3-D span a sheet deletion narrowed", async () => {
		// H1 =SUM(S:T!A1) reads S!A1 alone once T goes; I1 =H1*2 and J1 =I1+1 read it.
		const bytes = buildXlsx({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="H1"><f>SUM(S:T!A1)</f><v>6</v></c>' +
						'<c r="I1"><f>H1*2</f><v>12</v></c><c r="J1"><f>I1+1</f><v>13</v></c></row></sheetData>'
				},
				{ name: "T", body: '<sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData>' }
			],
			application: { name: "Microsoft Excel", version: "16.0300" },
			calcPr: 'calcId="191029"'
		})
		const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0
		const other = info.sheets[1]?.id ?? 0
		const cells = ["H1", "I1", "J1"]

		await session.intent()
		ok(await session.command({ type: "sheet.delete", sheet: other }))
		expect(await texts(session, sheet, cells)).toEqual(["1", "2", "3"])
		ok(await session.undo())
		expect(await texts(session, sheet, cells)).toEqual(["6", "12", "13"])
		ok(await session.redo())
		expect(await texts(session, sheet, cells)).toEqual(["1", "2", "3"])
		session.close()
	})

	it("recalculates what reads a name defined through a name a sheet deletion cut", async () => {
		// N = T!$A$2:$A$4 over 1, 2, 3 and Total = SUM(N): once T goes, Total is #REF!, and what turns that error into a
		// value gives that value.
		const formula = (cell: string, text: string, cached: number): string => `<c r="${cell}"><f>${text}</f><v>${cached}</v></c>`
		const files = unzipSync(
			buildXlsx({
				sheets: [
					{
						name: "S",
						body:
							'<sheetData><row r="1">' +
							formula("H1", "Total*2", 12) +
							formula("K1", "IFERROR(Total,0)+1", 7) +
							formula("P1", "IFERROR(Total,0)", 6) +
							formula("Q1", "IF(ISERROR(Total),1,2)", 2) +
							formula("R1", "IFERROR(H1,0)", 12) +
							"</row></sheetData>"
					},
					{
						name: "T",
						body: '<sheetData><row r="2"><c r="A2"><v>1</v></c></row><row r="3"><c r="A3"><v>2</v></c></row><row r="4"><c r="A4"><v>3</v></c></row></sheetData>'
					}
				],
				application: { name: "Microsoft Excel", version: "16.0300" },
				calcPr: 'calcId="191029"'
			})
		)

		files["xl/workbook.xml"] = strToU8(
			strFromU8(files["xl/workbook.xml"] as Uint8Array).replace(
				"</sheets>",
				'</sheets><definedNames><definedName name="N">T!$A$2:$A$4</definedName><definedName name="Total">SUM(N)</definedName></definedNames>'
			)
		)

		const result = await inThreadSheetHost().open(zipSync(files), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0
		const other = info.sheets[1]?.id ?? 0
		const cells = ["H1", "K1", "P1", "Q1", "R1"]

		await session.intent()
		ok(await session.command({ type: "sheet.delete", sheet: other }))
		expect(await texts(session, sheet, cells)).toEqual(["#REF!", "1", "0", "1", "0"])
		ok(await session.undo())
		expect(await texts(session, sheet, cells)).toEqual(["12", "7", "6", "2", "12"])
		ok(await session.redo())
		expect(await texts(session, sheet, cells)).toEqual(["#REF!", "1", "0", "1", "0"])
		session.close()
	})

	describe("reads a defined name of the workbook after rows deleted and undone", () => {
		// Rates = S!$A$2:$A$4 over 1, 2, 3; C1 reads it through INDIRECT, D1 directly. E1 =SUM(A1:B4), F1 =E1*2 and
		// G1 =SUM(A1:B3) read the cells through ranges a shift of column A's cells does not rewrite; H1 =Total*2 reads
		// Total = SUM(Rates), a name whose text no edit changes.
		const open = async (): Promise<{ session: SheetSessionApi; sheet: number }> => {
			const formula = (cell: string, text: string): string => `<c r="${cell}"><f>${text}</f><v>6</v></c>`
			const files = unzipSync(
				buildXlsx({
					sheets: [
						{
							name: "S",
							body:
								'<sheetData><row r="1">' +
								formula("C1", 'SUM(INDIRECT("Rates"))') +
								formula("D1", "SUM(Rates)") +
								'<c r="E1"><f>SUM(A1:B4)</f><v>6</v></c><c r="F1"><f>E1*2</f><v>12</v></c>' +
								'<c r="G1"><f>SUM(A1:B3)</f><v>3</v></c><c r="H1"><f>Total*2</f><v>12</v></c></row><row r="2"><c r="A2"><v>1</v></c></row><row r="3"><c r="A3"><v>2</v></c></row>' +
								'<row r="4"><c r="A4"><v>3</v></c></row></sheetData>'
						}
					],
					application: { name: "Microsoft Excel", version: "16.0300" },
					calcPr: 'calcId="191029"'
				})
			)
			const book = files["xl/workbook.xml"]

			if (book === undefined) throw new Error("no workbook part")

			files["xl/workbook.xml"] = strToU8(
				strFromU8(book).replace(
					"</sheets>",
					'</sheets><definedNames><definedName name="Rates">S!$A$2:$A$4</definedName>' +
						'<definedName name="Total">SUM(Rates)</definedName></definedNames>'
				)
			)

			const result = await inThreadSheetHost().open(zipSync(files), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

			if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

			await result.session.intent()

			return { session: result.session, sheet: result.info.sheets[0]?.id ?? 0 }
		}
		const setA = async (session: SheetSessionApi, sheet: number, row: number, input: string): Promise<void> => {
			ok(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(0), inputs: [input] }
				})
			)
		}

		it.each([
			{ cut: "all of it", at: 1, count: 3, left: "#REF!" },
			{ cut: "its end", at: 2, count: 2, left: "1" }
		])("follows the range again once a deletion of $cut is undone", async ({ at, count, left }) => {
			const { session, sheet } = await open()

			ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at, count }))
			expect(await texts(session, sheet, ["C1", "D1"])).toEqual([left, left])
			ok(await session.undo())
			expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["6", "6"])

			await setA(session, sheet, 3, "10")
			expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["13", "13"])
			session.close()
		})

		it("stays #REF! when the same rows are deleted twice and only the second deletion is undone", async () => {
			const { session, sheet } = await open()

			ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 1, count: 3 }))
			ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 1, count: 3 }))
			ok(await session.undo())

			await setA(session, sheet, 1, "5")
			expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["#REF!", "#REF!"])
			session.close()
		})

		describe.each([
			{ edit: "insert" as const, cell: 3 },
			{ edit: "delete" as const, cell: 1 }
		])("follows the range when cells are shifted by an $edit beside it", ({ edit, cell }) => {
			// Insert Cells (shift down) or Delete Cells (shift up) at A1: the name moves with the cells 1, 2, 3, and
			// `cell` holds the 2 then.
			const shift = (sheet: number): SheetCommand => ({
				type: "cells.shift",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
				edit,
				axis: "rows"
			})

			it("when it is made", async () => {
				const { session, sheet } = await open()

				ok(await session.command(shift(sheet)))
				expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(["6", "6", "12"])

				const saved = await session.save()

				if (!saved.ok) throw new Error(saved.reason)

				expect(strFromU8(unzipSync(saved.bytes)["xl/worksheets/sheet1.xml"] as Uint8Array)).toContain(
					'<c r="D1"><f>SUM(Rates)</f><v>6</v></c>'
				)

				await setA(session, sheet, cell, "10")
				expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["14", "14"])
				session.close()
			})

			it("when it is undone", async () => {
				const { session, sheet } = await open()

				ok(await session.command(shift(sheet)))
				ok(await session.undo())
				expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["6", "6"])

				await setA(session, sheet, 3, "10")
				expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["13", "13"])
				session.close()
			})

			it("when it is undone and redone", async () => {
				const { session, sheet } = await open()

				ok(await session.command(shift(sheet)))
				ok(await session.undo())
				ok(await session.redo())
				expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(["6", "6", "12"])

				await setA(session, sheet, cell, "10")
				expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["14", "14"])
				session.close()
			})
		})

		it.each([
			{
				edit: "insert" as const,
				// E1 =SUM(A1:B4), F1 =E1*2, G1 =SUM(A1:B3); J1 =A1:A4*2 (A2:A5*2 then), L1 =FILTER(A1:A9,A1:A9>1), N7
				// =SEQUENCE(3), Q1 =SUM(J1#).
				made: ["3", "6", "1", "0", "2", "4", "6", "2", "3", "1", "2", "3", "12"],
				refs: { J1: "J1:J4", L1: "L1:L2", N7: "N7:N9" }
			},
			{
				edit: "delete" as const,
				made: ["6", "12", "6", "2", "4", "6", "", "2", "3", "1", "2", "3", "12"],
				refs: { J1: "J1:J3", L1: "L1:L2", N7: "N7:N9" }
			}
		])(
			"recalculates what reads the shifted cells through other ranges and keeps every dynamic array when an $edit moves the name",
			async ({ edit, made, refs }) => {
				const { session, sheet } = await open()
				const typed = async (row: number, col: number, input: string): Promise<void> => {
					ok(
						await session.command({
							type: "cells.set",
							sheet,
							cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] }
						})
					)
				}

				await typed(0, 9, "=A1:A4*2")
				await typed(0, 11, "=FILTER(A1:A9,A1:A9>1)")
				await typed(6, 13, "=SEQUENCE(3)")
				await typed(0, 16, "=SUM(J1#)")

				const shift: SheetCommand = {
					type: "cells.shift",
					sheet,
					range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
					edit,
					axis: "rows"
				}
				const cells = ["E1", "F1", "G1", "J1", "J2", "J3", "J4", "L1", "L2", "N7", "N8", "N9", "Q1"]
				const before = ["6", "12", "3", "0", "2", "4", "6", "2", "3", "1", "2", "3", "12"]
				// What a save writes is what the cells show, each dynamic array over the cells it spills to.
				const saves = async (): Promise<void> => {
					const saved = await session.save()

					if (!saved.ok) throw new Error(saved.reason)

					const xml = strFromU8(unzipSync(saved.bytes)["xl/worksheets/sheet1.xml"] as Uint8Array)

					expect(xml).not.toContain("#SPILL!")
					expect(xml).toContain(`<c r="G1"><f>SUM(A1:B3)</f><v>${made[2] ?? ""}</v></c>`)

					for (const [cell, ref] of Object.entries(refs))
						expect(xml).toMatch(new RegExp(`<c r="${cell}"[^>]*><f t="array" ref="${ref}"`))
				}

				expect(await texts(session, sheet, cells)).toEqual(before)
				ok(await session.command(shift))
				expect(await texts(session, sheet, cells)).toEqual(made)
				await saves()
				ok(await session.undo())
				expect(await texts(session, sheet, cells)).toEqual(before)
				ok(await session.redo())
				expect(await texts(session, sheet, cells)).toEqual(made)
				await saves()

				// The engine built again from the workbook: the name read where it now is, INDIRECT's and the direct reader
				// alike, the dynamic arrays still whole.
				const at = edit === "insert" ? 3 : 1

				await setA(session, sheet, at, "10")
				expect(await texts(session, sheet, ["C1", "D1", "H1", "N7", "N8", "N9", "Q1"])).toEqual([
					"14",
					"14",
					"28",
					"1",
					"2",
					"3",
					"28"
				])
				session.close()
			}
		)

		it("recalculates what reads the name when a shift pushes all of it to the next column", async () => {
			const { session, sheet } = await open()

			ok(
				await session.command({
					type: "cells.shift",
					sheet,
					range: { startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
					edit: "insert",
					axis: "cols"
				})
			)
			expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(["6", "6", "12"])
			session.close()
		})

		describe("recalculates the next structure edit after a shift that moved the name", () => {
			// Insert Cells (shift down) at A1: the 1, 2, 3 in A3:A5 and Rates = S!$A$3:$A$5.
			const insertAtA1: SheetCommand = {
				type: "cells.shift",
				sheet: 0,
				range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
				edit: "insert",
				axis: "rows"
			}
			const cells = ["C1", "D1", "H1", "E1", "F1", "G1"]

			it("a deletion of the rows the name moved to", async () => {
				const { session, sheet } = await open()

				ok(await session.command({ ...insertAtA1, sheet }))
				ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 2, count: 3 }))
				expect(await texts(session, sheet, cells)).toEqual(["#REF!", "#REF!", "#REF!", "0", "0", "0"])
				session.close()
			})

			it("a clear of the cells the name moved to", async () => {
				const { session, sheet } = await open()

				ok(await session.command({ ...insertAtA1, sheet }))
				ok(
					await session.command({
						type: "cells.clear",
						sheet,
						ranges: [{ startRow: 2, startCol: 0, endRow: 4, endCol: 0 }],
						what: "contents"
					})
				)
				expect(await texts(session, sheet, cells)).toEqual(["0", "0", "0", "0", "0", "0"])
				session.close()
			})

			it("a second shift", async () => {
				const { session, sheet } = await open()

				ok(await session.command({ ...insertAtA1, sheet }))
				// Delete Cells (shift up) at A3: column A holds 2, 3 in A3:A4.
				ok(
					await session.command({
						type: "cells.shift",
						sheet,
						range: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
						edit: "delete",
						axis: "rows"
					})
				)
				expect(await texts(session, sheet, ["E1", "F1", "G1"])).toEqual(["5", "10", "2"])
				session.close()
			})

			it("a deletion after the shift is undone", async () => {
				const { session, sheet } = await open()

				ok(await session.command({ ...insertAtA1, sheet }))
				ok(await session.undo())
				ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 1, count: 3 }))
				expect(await texts(session, sheet, ["E1", "F1", "G1"])).toEqual(["0", "0", "0"])
				session.close()
			})

			it("both undone and redone", async () => {
				const { session, sheet } = await open()

				ok(await session.command({ ...insertAtA1, sheet }))
				ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 2, count: 3 }))
				ok(await session.undo())
				ok(await session.undo())
				expect(await texts(session, sheet, cells)).toEqual(["6", "6", "12", "6", "12", "3"])
				ok(await session.redo())
				expect(await texts(session, sheet, cells)).toEqual(["6", "6", "12", "3", "6", "1"])
				ok(await session.redo())
				expect(await texts(session, sheet, cells)).toEqual(["#REF!", "#REF!", "#REF!", "0", "0", "0"])
				ok(await session.undo())
				ok(await session.undo())

				await setA(session, sheet, 2, "10")
				expect(await texts(session, sheet, cells)).toEqual(["14", "14", "28", "14", "28", "11"])
				session.close()
			})

			it("a deletion after the shift is undone and redone", async () => {
				const { session, sheet } = await open()

				ok(await session.command({ ...insertAtA1, sheet }))
				ok(await session.undo())
				ok(await session.redo())
				ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 2, count: 3 }))
				expect(await texts(session, sheet, cells)).toEqual(["#REF!", "#REF!", "#REF!", "0", "0", "0"])
				ok(await session.undo())
				// E1 =SUM(A1:B4) and G1 =SUM(A1:B3) as after the shift: 1 + 2 and 1.
				expect(await texts(session, sheet, cells)).toEqual(["6", "6", "12", "3", "6", "1"])
				session.close()
			})
		})

		it.each([
			{
				label: "a deletion of the rows it moved to",
				next: (sheet: number): SheetCommand => ({ type: "axis.delete", sheet, axis: "rows", at: 5, count: 3 }),
				after: ["#REF!", "#REF!", "#REF!"]
			},
			{
				label: "a clear of the cells it moved to",
				next: (sheet: number): SheetCommand => ({
					type: "cells.clear",
					sheet,
					ranges: [{ startRow: 5, startCol: 0, endRow: 7, endCol: 0 }],
					what: "contents"
				}),
				after: ["0", "0", "0"]
			},
			{
				// Delete Cells (shift up) at A6: Rates = S!$A$6:$A$7 over 2, 3.
				label: "a shift of the cells it moved to",
				next: (sheet: number): SheetCommand => ({
					type: "cells.shift",
					sheet,
					range: { startRow: 5, startCol: 0, endRow: 5, endCol: 0 },
					edit: "delete",
					axis: "rows"
				}),
				after: ["5", "5", "10"]
			}
		])("recalculates $label after a cut moved the name", async ({ next, after }) => {
			const { session, sheet } = await open()
			const copied = await session.query("copy", { sheet, range: { startRow: 1, startCol: 0, endRow: 3, endCol: 0 }, cut: true })

			if ("refused" in copied) throw new Error("copy refused")

			// Cut A2:A4, pasted at A6: Rates = S!$A$6:$A$8, and the paste drops the engine.
			ok(await session.command({ type: "clipboard.paste", sheet, at: { row: 5, col: 0 }, text: copied.text, clip: copied.clip }))
			expect(await texts(session, sheet, ["D1", "H1"])).toEqual(["6", "12"])
			ok(await session.command(next(sheet)))
			expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(after)
			ok(await session.undo())
			expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(["6", "6", "12"])
			ok(await session.redo())
			expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(after)
			ok(await session.undo())
			// The cut undone too, with an engine built after it: the name back at A2:A4.
			ok(await session.undo())
			expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(["6", "6", "12"])

			await setA(session, sheet, 2, "10")
			expect(await texts(session, sheet, ["C1", "D1", "H1"])).toEqual(["14", "14", "28"])
			session.close()
		})

		it("recalculates a shift that moves no name after a cut moved one", async () => {
			const { session, sheet } = await open()

			ok(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(4), cols: Uint16Array.of(1), inputs: ["7"] }
				})
			)

			const copied = await session.query("copy", { sheet, range: { startRow: 1, startCol: 0, endRow: 3, endCol: 0 }, cut: true })

			if ("refused" in copied) throw new Error("copy refused")

			ok(await session.command({ type: "clipboard.paste", sheet, at: { row: 5, col: 0 }, text: copied.text, clip: copied.clip }))
			// Delete Cells (shift up) at B1: the 7 moves from B5 into E1's A1:B4.
			ok(
				await session.command({
					type: "cells.shift",
					sheet,
					range: { startRow: 0, startCol: 1, endRow: 0, endCol: 1 },
					edit: "delete",
					axis: "rows"
				})
			)
			expect(await texts(session, sheet, ["E1", "F1", "D1"])).toEqual(["7", "14", "6"])
			session.close()
		})

		it("recalculates what reads a name through another name when a shift narrows it", async () => {
			const { session, sheet } = await open()
			const cells = ["C1", "D1", "H1"]

			// Delete Cells (shift up) at A3: Rates is S!$A$2:$A$3 over 1, 3.
			ok(
				await session.command({
					type: "cells.shift",
					sheet,
					range: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
					edit: "delete",
					axis: "rows"
				})
			)
			expect(await texts(session, sheet, cells)).toEqual(["4", "4", "8"])
			ok(await session.undo())
			expect(await texts(session, sheet, cells)).toEqual(["6", "6", "12"])
			ok(await session.redo())
			expect(await texts(session, sheet, cells)).toEqual(["4", "4", "8"])
			session.close()
		})

		it("follows the range again when the engine was built anew between the deletion and its undo", async () => {
			const { session, sheet } = await open()

			ok(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 1, count: 3 }))
			// Another locale drops the engine; the next edit builds it from the workbook, whose name is #REF! then.
			session.configure({ locale: { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" } })
			ok(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(9), cols: Uint16Array.of(5), inputs: ["1"] }
				})
			)
			ok(await session.undo())
			ok(await session.undo())

			await setA(session, sheet, 3, "10")
			expect(await texts(session, sheet, ["C1", "D1"])).toEqual(["13", "13"])
			session.close()
		})
	})

	describe.each([{ type: "axis.insert" as const }, { type: "axis.delete" as const }])(
		"moves the engine built after an $type made without one",
		({ type }) => {
			// No formula, so no engine while the rows move: the first formula typed builds it from the workbook as moved.
			const open = async (): Promise<{ session: SheetSessionApi; sheet: number }> => {
				const bytes = buildXlsx({
					sheets: [
						{
							name: "S",
							body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData>'
						}
					]
				})
				const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

				if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

				await result.session.intent()

				return { session: result.session, sheet: result.info.sheets[0]?.id ?? 0 }
			}
			const move = (sheet: number): SheetCommand =>
				type === "axis.insert"
					? { type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 }
					: { type: "axis.delete", sheet, axis: "rows", at: 0, count: 1 }
			const typed = async (session: SheetSessionApi, sheet: number, input: string): Promise<void> => {
				ok(
					await session.command({
						type: "cells.set",
						sheet,
						cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(2), inputs: [input] }
					})
				)
			}

			it("when it is undone", async () => {
				const { session, sheet } = await open()

				ok(await session.command(move(sheet)))
				await typed(session, sheet, "=SUM(A1:A2)")
				ok(await session.undo())
				ok(await session.undo())

				await typed(session, sheet, "=SUM(A1:A2)")
				expect(await texts(session, sheet, ["C1"])).toEqual(["3"])
				session.close()
			})

			it("when it is undone and redone", async () => {
				const { session, sheet } = await open()

				ok(await session.command(move(sheet)))
				await typed(session, sheet, "=SUM(A1:A2)")
				ok(await session.undo())
				ok(await session.undo())
				ok(await session.redo())
				ok(await session.redo())
				expect(await texts(session, sheet, ["C1"])).toEqual([type === "axis.insert" ? "1" : "5"])

				ok(
					await session.command({
						type: "cells.set",
						sheet,
						cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["10"] }
					})
				)
				expect(await texts(session, sheet, ["C1"])).toEqual([type === "axis.insert" ? "11" : "13"])
				session.close()
			})
		}
	)

	it("hands an OFFSET whose literal size is past what one range may cover to the bounded function, a small one to the engine", () => {
		const small = "=OFFSET(A1,0,0,2,2)"

		expect(engineCellFormula(storedFormula(small.slice(1)))).toBe(small)
		expect(engineCellFormula(storedFormula("COUNTA(OFFSET(A1,0,0,1048576,30))"))).not.toContain("(OFFSET(")
		expect(engineCellFormula(storedFormula("SUM(OFFSET(J1,0,0,200000,30))"))).not.toContain("(OFFSET(")
	})

	it("hands a range with an OFFSET at an end to the bounded function when the block it spans is past what one range may cover", () => {
		expect(engineCellFormula(storedFormula("SUM(L1:OFFSET(L1,99999,29))"))).toContain("FILEN.RANGE(")
		expect(engineCellFormula(storedFormula("SUM(OFFSET(L1,0,0):AO100000)"))).toContain("FILEN.RANGE(")
		expect(engineCellFormula(storedFormula("COUNTA(A1:OFFSET(A1,1048575,29))"))).toContain("FILEN.RANGE(")
		expect(engineCellFormula(storedFormula("SUM(OFFSET(L1,0,0):OFFSET(L1,99999,29))"))).toContain("FILEN.RANGE(")
		// Past the bound only with a third end, which the engine reads as one range with the first two.
		expect(engineCellFormula(storedFormula("SUM(A1:OFFSET(A1,1,1):Z100000)"))).toContain("FILEN.RANGE(")
		expect(engineCellFormula(storedFormula("A1:OFFSET(A1,1,1)"))).toBe("=A1:OFFSET(A1,1,1)")
		expect(engineCellFormula(storedFormula("SUM(OFFSET(A1,1,1):B5)"))).toBe("=SUM(OFFSET(A1,1,1):B5)")
	})

	it("reads a range written with white space at its colon or its sheet at both ends as the one range the engine reads", () => {
		// The engine reads past the white space and the repeated sheet: the size bounds must see the same block.
		for (const text of ["SUM(L1: OFFSET(L1,99999,29))", "SUM(L1 :OFFSET(L1,99999,29))", "SUM(L1:OFFSET (L1,99999,29))"])
			expect(engineCellFormula(storedFormula(text))).toContain("FILEN.RANGE(")

		expect(engineCellFormula(storedFormula("COUNTA(OFFSET (A1,0,0,1048576,30))"))).not.toContain("(OFFSET(")
		expect(engineCellFormula(storedFormula("SUM(L1 :\n AO100000)"))).toBe("=SUM(L1:AO100000)")
		// The engine reads past any white space JavaScript's \s knows: an ideographic space, a byte order mark, a tab.
		expect(engineCellFormula(storedFormula("SUM(L1\u3000:\uFEFFAO100000)"))).toBe("=SUM(L1:AO100000)")
		expect(engineCellFormula(storedFormula("SUM(L1\u000b:\u00a0AO100000)"))).toBe("=SUM(L1:AO100000)")
		// Anywhere else it is a plain space, which ends a reference for the size bounds as it does for the engine; text
		// and quoted sheet names keep theirs.
		for (const text of ["SUM(L1:AO100000\u3000)", "SUM(\u00a0L1:AO100000)", "SUM(\uFEFFL1:AO100000\u2003,1)", "L1:AO100000\u3000*2"])
			expect(engineCellFormula(storedFormula(text))).toMatch(/^[\x20-\x7e]*$/)

		expect(engineCellFormula(storedFormula("CONCAT(\"a\u00a0b\",'My\u3000Sheet'!A1)"))).toBe("=CONCAT(\"a\u00a0b\",'My\u3000Sheet'!A1)")
		expect(engineCellFormula(storedFormula("SUM(S!L1:S!AO100000)"))).toBe("=SUM('S'!L1:AO100000)")
		expect(engineCellFormula(storedFormula("SUM('My Sheet'!$A$1 : 'my sheet'!B2)"))).toBe("=SUM('My Sheet'!$A$1:B2)")
		// Text, another sheet at the second end, and a word that is no range keep their spelling.
		expect(engineCellFormula(storedFormula('CONCAT("A1 : B2",S!A1:T!B2)'))).toBe("=CONCAT(\"A1 : B2\",'S'!A1:'T'!B2)")
	})

	it("keeps the file's result for a block of cells past what one range may cover, and still reads whole columns", async () => {
		// The engine reads a block address by address, a small sheet's empty ones too: these would take gigabytes.
		const formula = (cell: string, text: string, cached: number): string => `<c r="${cell}"><f>${text}</f><v>${cached}</v></c>`
		const bytes = buildXlsx({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="H1"><v>1048575</v></c><c r="I1"><v>1048576</v></c>' +
						'<c r="J1"><v>4</v></c></row><row r="3">' +
						formula("C3", 'SUM(INDIRECT("L1:Z1048576"))', 7) +
						formula("D3", "SUM(L1:Z1048576)", 8) +
						formula("E3", 'SUM(INDIRECT("A1:B1"))', 0) +
						formula("F3", 'SUM(INDIRECT("A:A"))', 0) +
						formula("G3", "SUM(OFFSET(J1,0,0,H1,30))", 9) +
						formula("H3", "SUM(OFFSET(J1,0,0,I1,2))", 0) +
						formula("I3", "SUM(OFFSET(J1,0,0,200000,30))", 11) +
						formula("M3", "SUM(OFFSET(A1,0,0,2,2))", 0) +
						formula("Z3", "COUNTA(OFFSET(A1,0,0,1048576,20))", 0) +
						'</row><row r="4">' +
						formula("N4", "SUM(L1:OFFSET(L1,99999,29))", 21) +
						formula("O4", "SUM(OFFSET(L1,0,0):AO100000)", 22) +
						formula("P4", "SUM(A1:OFFSET(A1,0,1))", 0) +
						"</row></sheetData>"
				}
			],
			application: { name: "Microsoft Excel", version: "16.0300" },
			calcPr: 'calcId="191029"'
		})
		const heap = process.memoryUsage().heapUsed
		const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0

		await session.intent()
		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["5"] } }))
		expect(await texts(session, sheet, ["C3", "D3", "E3", "F3", "G3", "H3", "I3", "M3", "Z3", "N4", "O4", "P4"])).toEqual([
			"7",
			"8",
			"7",
			"5",
			"9",
			"4",
			"11",
			"7",
			// The block A1:T1048576 holds the three formulas of row 4 too.
			"16",
			"21",
			"22",
			"7"
		])
		expect(process.memoryUsage().heapUsed - heap).toBeLessThan(400 * 1024 * 1024)
		session.close()
	})

	it("keeps the file's result for a defined name over a block of cells past what one range may cover", async () => {
		// The engine reads a name's block whole when it builds, used or not: three million cells would take gigabytes.
		const files = unzipSync(
			buildXlsx({
				sheets: [
					{
						name: "S",
						body:
							'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1+1</f><v>2</v></c><c r="C1"><f>SUM(Big)</f><v>9</v></c>' +
							'<c r="D1"><f>SUM(Small)</f><v>0</v></c><c r="E1"><f>SUM(Wrapped)</f><v>8</v></c></row></sheetData>'
					}
				],
				application: { name: "Microsoft Excel", version: "16.0300" },
				calcPr: 'calcId="191029"'
			})
		)
		const book = files["xl/workbook.xml"]

		if (book === undefined) throw new Error("no workbook part")

		files["xl/workbook.xml"] = strToU8(
			strFromU8(book).replace(
				"</sheets>",
				'</sheets><definedNames><definedName name="Big">S!$L$1:$AO$100000</definedName>' +
					'<definedName name="Small">S!$A$1:$B$1</definedName>' +
					'<definedName name="Wrapped">INDEX(S!$L$1:$AO$100000,1,1)</definedName></definedNames>'
			)
		)

		const heap = process.memoryUsage().heapUsed
		const result = await inThreadSheetHost().open(zipSync(files), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0

		await session.intent()
		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["5"] } }))
		expect(await texts(session, sheet, ["B1", "C1", "D1", "E1"])).toEqual(["6", "9", "11", "8"])
		expect(process.memoryUsage().heapUsed - heap).toBeLessThan(400 * 1024 * 1024)
		session.close()
	})

	it("keeps the file's result for a block past what one range may cover however the range is spelled, typed or named", async () => {
		const formula = (cell: string, text: string, cached: number): string => `<c r="${cell}"><f>${text}</f><v>${cached}</v></c>`
		const files = unzipSync(
			buildXlsx({
				sheets: [
					{
						name: "S",
						body:
							'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="L1"><v>3</v></c></row><row r="3">' +
							formula("C3", "SUM(L1 : AO100000)", 31) +
							formula("D3", "SUM(S!L1:S!AO100000)", 32) +
							formula("E3", "SUM(L1: OFFSET(L1,99999,29))", 33) +
							formula("F3", "SUM(A1 : B1)", 0) +
							formula("G3", 'SUM(INDIRECT("Big"))', 34) +
							formula("H3", 'SUM(INDIRECT("Small"))', 0) +
							formula("I3", "COUNTA(OFFSET (A1,0,0,1048576,30))", 35) +
							formula("J3", "SUM(L1&#x3000;:AO100000)", 36) +
							formula("K3", "SUM(L1:&#xFEFF;AO100000)", 37) +
							formula("L3", "SUM(L1:AO100000&#x3000;)", 38) +
							formula("M3", "SUM(&#xA0;L1:AO100000)", 39) +
							"</row></sheetData>"
					}
				],
				application: { name: "Microsoft Excel", version: "16.0300" },
				calcPr: 'calcId="191029"'
			})
		)
		const book = files["xl/workbook.xml"]

		if (book === undefined) throw new Error("no workbook part")

		// Big is read only through INDIRECT; the others, unused, would be read whole when the engine builds.
		files["xl/workbook.xml"] = strToU8(
			strFromU8(book).replace(
				"</sheets>",
				'</sheets><definedNames><definedName name="Big">S!$L$1:$AO$100000</definedName>' +
					'<definedName name="Spaced">S!$L$1 : $AO$100000</definedName>' +
					'<definedName name="Twice">S!$L$1:S!$AO$100000</definedName>' +
					'<definedName name="Offset">S!$L$1: OFFSET(S!$L$1,99999,29)</definedName>' +
					'<definedName name="Small">S!$A$1 : S!$B$1</definedName></definedNames>'
			)
		)

		const heap = process.memoryUsage().heapUsed
		const opening = cpuMs()
		const result = await inThreadSheetHost().open(zipSync(files), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0

		await session.intent()
		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["5"] } }))

		const opened = cpuMs() - opening

		expect(opened).toBeLessThan(budget(1000))
		expect(await texts(session, sheet, ["C3", "D3", "E3", "F3", "G3", "H3", "I3", "J3", "K3", "L3", "M3"])).toEqual([
			"31",
			"32",
			"33",
			"7",
			"34",
			"7",
			"35",
			"36",
			"37",
			"38",
			"39"
		])

		// Typed: the check of whether the formula gives an array reads no more than the cell would (reading the blocks
		// takes seconds and gigabytes, given back before the heap is measured).
		const started = cpuMs()

		ok(
			await session.command({
				type: "cells.set",
				sheet,
				cells: {
					rows: Uint32Array.of(4, 4, 4, 4, 4),
					cols: Uint16Array.of(0, 1, 2, 3, 4),
					inputs: [
						"=COUNTA(M1:AD1048576)",
						"=SUM(L1 : AO100000)",
						"=SUM(A1 : B1)",
						"=SUM(L1:\u3000AO100000)",
						"=SUM(L1:AO100000\u3000)"
					]
				}
			})
		)

		const spent = cpuMs() - started
		const [counta, sum, small, wide, trailing] = await texts(session, sheet, ["A5", "B5", "C5", "D5", "E5"])

		expect(spent).toBeLessThan(budget(400))

		expect([counta, sum, wide, trailing]).toEqual(["#ERROR!", "#ERROR!", "#ERROR!", "#ERROR!"])
		expect(small).toBe("7")
		expect(process.memoryUsage().heapUsed - heap).toBeLessThan(400 * 1024 * 1024)
		session.close()
	})

	it("refuses an insert inside a block of cells that would widen it past what one range may cover", async () => {
		const bytes = buildXlsx({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="AA1"><f>SUM(A1:Z2)</f><v>1</v></c><c r="AB1"><f>SUM(AC:AC)</f><v>0</v></c></row></sheetData>'
				}
			],
			application: { name: "Microsoft Excel", version: "16.0300" },
			calcPr: 'calcId="191029"'
		})
		const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0

		await session.intent()
		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["2"] } }))

		// Inside A1:Z2, a hundred thousand rows would make it 2.6 million cells, which the engine reads one by one.
		const refused = await session.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count: 100_000 })

		expect(refused.ok ? null : refused.refusal.reason).toBe("tooLarge")
		// Above it the block only moves, and a few rows inside keep it small.
		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 100_000 }))
		ok(await session.undo())
		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count: 10 }))
		expect(await texts(session, sheet, ["A1"])).toEqual(["2"])
		session.close()
	})

	it("reads no sheet a sheet.add put first once undone, an engine built between the two", async () => {
		const bytes = buildXlsx({
			sheets: [
				{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1+1</f><v>2</v></c></row></sheetData>' }
			],
			application: { name: "Microsoft Excel", version: "16.0300" },
			calcPr: 'calcId="191029"'
		})
		const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0
		const typed = async (row: number, input: string): Promise<void> => {
			ok(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(2), inputs: [input] }
				})
			)
		}

		await session.intent()
		ok(await session.command({ type: "sheet.add", name: "New", index: 0 }))
		// Another locale drops the engine; the next edit builds it with New first.
		session.configure({ locale: { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" } })
		await typed(5, "1")
		ok(await session.undo())
		ok(await session.undo())

		await typed(0, '=INDIRECT("New!A1")')
		await typed(1, "=SUM(A1;B1)")
		expect(await texts(session, sheet, ["C1", "C2"])).toEqual(["#REF!", "3"])
		session.close()
	})

	it("is taken back whole by undo after a sheet is added or renamed: undone, the save is the source", async () => {
		// B1 reads A1, whose function the app does not calculate (#NAME?): what INDIRECT gives is not stored as a value.
		const bytes = buildXlsx({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1" t="e"><f>_xll.Custom()</f><v>#NAME?</v></c><c r="B1" t="e"><f>INDIRECT("A1")</f><v>#NAME?</v></c>' +
						'<c r="C1"><f>INDIRECT("T!A1")</f><v>5</v></c></row></sheetData>'
				},
				{ name: "T", body: '<sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData>' }
			],
			application: { name: "Microsoft Excel", version: "16.0300" },
			calcPr: 'calcId="191029"'
		})
		const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const { session, info } = result
		const sheet = info.sheets[0]?.id ?? 0
		const source = await session.save()

		await session.intent()
		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(4), cols: Uint16Array.of(0), inputs: ["1"] } }))
		ok(await session.command({ type: "sheet.add", name: "New" }))
		ok(await session.command({ type: "sheet.rename", sheet: info.sheets[1]?.id ?? 0, name: "U" }))
		expect(await texts(session, sheet, ["C1"])).toEqual(["#REF!"])

		for (let i = 0; i < 3; i++) ok(await session.undo())

		const undone = await session.save()

		if (!source.ok || !undone.ok) throw new Error("save refused")
		expect(undone.bytes).toEqual(source.bytes)
		const t2 = cpuMs()
		await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["5"] } })
		const saved = await session.save()
		if (saved.ok)
			console.log(
				"AFTER",
				cpuMs() - t2,
				/<c r="AA1".*?<\/c>/.exec(strFromU8(unzipSync(saved.bytes)["xl/worksheets/sheet1.xml"] as Uint8Array))?.[0]
			)
		session.close()
	})
})
