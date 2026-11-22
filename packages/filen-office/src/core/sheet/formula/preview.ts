import type { SheetQueryResult } from "../protocol"
import { engineArrayFormula, holdsBracket, storedFormula, wellFormedFormula } from "../refs/formulaRefs"
import type { FormulaEngine } from "./formulaEngine"

// Whether a typed formula (the file's syntax, without its "=") is one the engine can be given to calculate.
export function previewable(formula: string): boolean {
	return wellFormedFormula(formula) && !holdsBracket(formula)
}

// A typed formula (the file's syntax, without its "=") calculated on a sheet (by engine index) as the engine would
// calculate it in a cell now, written to no cell: the formulaPreview query's answer. `aliases` and `lambdas`: the
// workbook's, as a typed formula is given to the engine with them.
export function previewFormula(
	engine: FormulaEngine,
	sheet: number,
	formula: string,
	aliases?: ReadonlyMap<string, string>,
	lambdas?: ReadonlySet<string>
): SheetQueryResult<"formulaPreview"> {
	const text = previewable(formula) ? engineArrayFormula(storedFormula(formula), aliases, lambdas) : null

	if (text === null) return { refused: "formula" }

	const result = engine.preview(sheet, text)

	return result === null ? { refused: "formula" } : result === "busy" ? { refused: "busy" } : result
}
