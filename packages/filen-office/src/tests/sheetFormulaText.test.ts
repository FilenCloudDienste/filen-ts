import { describe, expect, it } from "vitest"
import type { SheetCommandResult, SheetSessionApi, SheetTile } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { buildXlsx } from "./oracles/sheet/synthetic"
import { FormulaEngine } from "../core/sheet/formula/index"
import { engineCellFormula, storedFormula } from "../core/sheet/refs/formulaRefs"

// FORMULATEXT (support.microsoft.com "FORMULATEXT function"): the formula as a string, as the formula bar shows it;
// #N/A for a cell without one. Its own cell is no circular reference.

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

async function open(body: string): Promise<{ session: SheetSessionApi; sheet: number }> {
	const bytes = buildXlsx({
		sheets: [{ name: "S", body }],
		application: { name: "Microsoft Excel", version: "16.0300" },
		calcPr: 'calcId="191029"'
	})
	const result = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	const sheet = result.info.sheets[0]?.id ?? 0

	await result.session.tiles(sheet, Uint32Array.of(0, 0))
	await result.session.intent()

	return { session: result.session, sheet }
}

const formula = (cell: string, text: string, value = ""): string => `<c r="${cell}"><f>${text}</f>${value}</c>`

describe("FORMULATEXT", () => {
	it("gives the formula as the formula bar shows it, not the engine's rewrite", async () => {
		const { session, sheet } = await open(
			"<sheetData>" +
				'<row r="1"><c r="A1"><v>1</v></c>' +
				formula("B1", "_xlfn.XLOOKUP(1,A1:A2,A1:A2)", "<v>1</v>") +
				formula("C1", "_xlfn.FORMULATEXT(B1)") +
				formula("D1", "_xlfn.FORMULATEXT(D1)") +
				formula("E1", "_xlfn.FORMULATEXT(A1)") +
				formula("F1", '_xlfn.FORMULATEXT(INDIRECT("B1"))') +
				"</row>" +
				'<row r="2"><c r="A2"><v>2</v></c>' +
				formula("B2", 'SUMIF(A1:A2,"&gt;0")', "<v>3</v>") +
				formula("C2", "_xlfn.FORMULATEXT(B2:B3)") +
				"</row>" +
				'<row r="3">' +
				formula("B3", "_xlfn.LET(_xlpm.x,A1,_xlpm.x*2)", "<v>2</v>") +
				formula("C3", "_xlfn.FORMULATEXT(B3)") +
				"</row>" +
				"</sheetData>"
		)

		expect(await texts(session, sheet, ["C1", "D1", "E1", "F1", "C2", "C3"])).toEqual([
			"=XLOOKUP(1,A1:A2,A1:A2)",
			"=FORMULATEXT(D1)",
			"#N/A",
			"=XLOOKUP(1,A1:A2,A1:A2)",
			'=SUMIF(A1:A2,">0")',
			"=LET(x,A1,x*2)"
		])
		session.close()
	})

	it("calculates again when the formula it reads changes, its value the same", async () => {
		const { session, sheet } = await open(
			"<sheetData>" +
				'<row r="1"><c r="A1"><v>1</v></c>' +
				formula("B1", "A1+1", "<v>2</v>") +
				formula("C1", "_xlfn.FORMULATEXT(B1)") +
				"</row></sheetData>"
		)

		expect(await texts(session, sheet, ["C1"])).toEqual(["=A1+1"])

		ok(
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(1), inputs: ["=A1*2"] }
			})
		)
		expect(await texts(session, sheet, ["B1", "C1"])).toEqual(["2", "=A1*2"])

		ok(await session.command({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(1), inputs: ["2"] } }))
		expect(await texts(session, sheet, ["C1"])).toEqual(["#N/A"])

		ok(await session.undo())
		expect(await texts(session, sheet, ["C1"])).toEqual(["=A1*2"])
		session.close()
	})

	it("is #N/A in an engine without the formula bar's text, and the host's text by grid sheet index with it", () => {
		const rows = [[1, engineCellFormula(storedFormula("XLOOKUP(1,A1:A1,A1:A1)")) ?? "", "=FORMULATEXT(B1)"]]
		const headless = new FormulaEngine([{ name: "S", rows: rows.map(row => [...row]), formulas: [] }], [])
		const asked: number[][] = []
		const hosted = new FormulaEngine(
			[{ name: "S", rows: rows.map(row => [...row]), formulas: [] }],
			[],
			false,
			undefined,
			undefined,
			undefined,
			undefined,
			(sheet, row, col) => {
				asked.push([sheet, row, col])

				return "=XLOOKUP(1,A1:A1,A1:A1)"
			}
		)

		try {
			expect(headless.result(0, 0, 2)).toEqual({ value: "#N/A", error: true })
			expect(hosted.result(0, 0, 2)).toEqual({ value: "=XLOOKUP(1,A1:A1,A1:A1)" })
			expect(asked).toContainEqual([0, 0, 1])
		} finally {
			headless.destroy()
			hosted.destroy()
		}
	})
})
