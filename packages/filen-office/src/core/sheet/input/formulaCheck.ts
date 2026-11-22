import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetQueryResult } from "../protocol"
import { functionSupport } from "../functions/catalogue"
import { calledFunctions, formulaInputs, holdsBracket, sameSheet, wellFormedFormula } from "../refs/formulaRefs"
import { parseCellInput } from "./cellInput"
import { EN_US_LOCALE } from "./locale"

// A formula someone other than the user wrote (the assistant's formula helper), checked before it is offered: it must
// read as a formula in the file's (en-US) syntax, call only functions this app calculates, and read only cells of
// this workbook's sheets, never the cell it is to go in. What it gives is the engine's to say (the formulaPreview
// query), not this check's.

// Functions refused though calculated here: HYPERLINK makes a link out of what the formula reads, and INDIRECT reads
// cells its text names, which no reference check sees.
const REFUSED_FUNCTIONS: ReadonlySet<string> = new Set(["HYPERLINK", "INDIRECT"])

export type WrittenFormulaProblem =
	// Not a formula, or one that does not read as one.
	| { readonly kind: "malformed" }
	// A function this app does not know or calculate (its result would be the file's to keep), or one refused.
	| { readonly kind: "function"; readonly name: string; readonly refused: boolean }
	// A reference into another workbook or a table, to a sheet the workbook lacks, or past the sheet's last row or column.
	| { readonly kind: "reference"; readonly sheet: string | null }
	// A reference to the cell the formula is to go in.
	| { readonly kind: "circular" }

export interface WrittenFormulaTarget {
	// The workbook's sheet names, and the name of the one the formula goes on.
	readonly sheets: readonly string[]
	readonly sheet: string
	// The cell it goes in (0-based); none when it is only evaluated.
	readonly cell?: { readonly row: number; readonly col: number }
}

// `input` as entered, "=" first, in en-US syntax. Null when nothing is wrong with it.
export function writtenFormulaProblem(input: string, target: WrittenFormulaTarget): WrittenFormulaProblem | null {
	const parsed = parseCellInput(input, EN_US_LOCALE)

	if (parsed.type !== "formula" || !wellFormedFormula(parsed.formula)) return { kind: "malformed" }

	const formula = parsed.formula

	for (const called of calledFunctions(formula)) {
		const name = called.toUpperCase()
		const support = functionSupport(name)

		if (REFUSED_FUNCTIONS.has(name)) return { kind: "function", name, refused: true }
		if (support !== "hyperformula" && support !== "plugin") return { kind: "function", name, refused: false }
	}

	if (holdsBracket(formula)) return { kind: "reference", sheet: null }

	const known = (name: string): boolean => target.sheets.some(sheet => sameSheet(sheet, name))

	for (const { sheet, lastSheet, area } of formulaInputs(formula).refs) {
		if (sheet !== null && !known(sheet)) return { kind: "reference", sheet }
		if (lastSheet !== null && !known(lastSheet)) return { kind: "reference", sheet: lastSheet }
		if (Math.max(area.startRow, area.endRow) >= SHEET_MAX_ROWS || Math.max(area.startCol, area.endCol) >= SHEET_MAX_COLS)
			return { kind: "reference", sheet }

		const cell = target.cell

		if (cell === undefined || lastSheet !== null || (sheet !== null && !sameSheet(sheet, target.sheet))) continue

		const rows = area.kind === "cols" || (cell.row >= area.startRow && cell.row <= area.endRow)
		const cols = area.kind === "rows" || (cell.col >= area.startCol && cell.col <= area.endCol)

		if (rows && cols) return { kind: "circular" }
	}

	return null
}

export type FormulaPreviewValue = Exclude<SheetQueryResult<"formulaPreview">, { readonly refused: unknown }>

export type WrittenFormulaRefusal =
	| WrittenFormulaProblem
	// The engine could not calculate it, or it reads a name the workbook lacks (#NAME?).
	| { readonly kind: "engine" }
	| { readonly kind: "name" }

// The whole check a written formula passes before it is offered: writtenFormulaProblem, then the engine's calculation
// (`preview`: the formulaPreview query, or what answers as it does), only for a formula the first allows.
export async function checkWrittenFormula(
	input: string,
	target: WrittenFormulaTarget,
	preview: (formula: string) => Promise<SheetQueryResult<"formulaPreview">>
): Promise<{ ok: true; value: FormulaPreviewValue } | { ok: false; problem: WrittenFormulaRefusal }> {
	const problem = writtenFormulaProblem(input, target)

	if (problem !== null) return { ok: false, problem }

	const result = await preview(input)

	if ("refused" in result) return { ok: false, problem: { kind: "engine" } }
	if (result.error && result.value === "#NAME?") return { ok: false, problem: { kind: "name" } }

	return { ok: true, value: result }
}
