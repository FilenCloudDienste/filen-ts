import { FormulaEngine, type EngineSheet, type RecalculatedCell } from "../core/sheet/formula/index"
import { engineCellFormula, storedFormula } from "../core/sheet/refs/formulaRefs"

// Formula engines over cells as typed, for the function tests.

// A cell as typed: "=..." a formula in Excel's syntax, "'..." text, anything else the value.
export type Typed = string | number | boolean | null

export interface TypedFormulas {
	// true: each formula goes through storedFormula first, as a file stores it (_xlfn. and _xlpm. prefixes); false:
	// the typed formula goes to the engine as it is.
	readonly stored: boolean
}

export function engineRows(rows: readonly (readonly Typed[])[], { stored }: TypedFormulas): EngineSheet["rows"] {
	return rows.map(row =>
		row.map(cell => {
			if (typeof cell !== "string" || !cell.startsWith("=")) return cell

			const formula = cell.slice(1)

			return engineCellFormula(stored ? storedFormula(formula) : formula) ?? ""
		})
	)
}

// A result as the tests compare it: an error as "!" and its text.
export function shownResult(result: Pick<RecalculatedCell, "value" | "error">): unknown {
	return result.error === true ? `!${String(result.value)}` : result.value
}

// An engine over sheet "S" (and "T" when `other` is given). Returns the result of each formula cell of "S" by its A1
// name.
export function calculate(rows: Typed[][], options: TypedFormulas & { readonly other?: Typed[][] | undefined }): Record<string, unknown> {
	const sheets: EngineSheet[] = [{ name: "S", rows: engineRows(rows, options), formulas: [] }]

	if (options.other !== undefined) sheets.push({ name: "T", rows: engineRows(options.other, options), formulas: [] })

	const engine = new FormulaEngine(sheets, [])
	const out: Record<string, unknown> = {}

	try {
		rows.forEach((row, r) =>
			row.forEach((cell, c) => {
				if (typeof cell !== "string" || !cell.startsWith("=")) return

				out[`${String.fromCharCode(65 + c)}${String(r + 1)}`] = shownResult(engine.result(0, r, c))
			})
		)
	} finally {
		engine.destroy()
	}

	return out
}

// The results of formulas written in column A below `data`, one per row.
export function results(data: readonly (readonly Typed[])[], formulas: readonly string[], options: TypedFormulas): unknown[] {
	const engine = new FormulaEngine(
		[{ name: "S", rows: engineRows([...data, ...formulas.map(formula => [formula])], options), formulas: [] }],
		[]
	)

	try {
		return formulas.map((_, index) => shownResult(engine.result(0, data.length + index, 0)))
	} finally {
		engine.destroy()
	}
}
