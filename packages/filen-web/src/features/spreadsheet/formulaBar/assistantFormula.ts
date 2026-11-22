import {
	cellName,
	CellFlag,
	columnName,
	localizeFormula,
	parseCellInput,
	parseTsv,
	rangeName,
	writtenFormulaProblem,
	type SheetId,
	type SheetLocale,
	type SheetRange
} from "@filen/office/core/sheet"
import { entryText, type SheetGridModel } from "@filen/office/react/sheet"
import {
	FORMULA_MAX_COLUMNS,
	type FormulaCellType,
	type FormulaCheck,
	type FormulaColumn,
	type FormulaContext
} from "@filen/shared/assistant"
import type { AssistantFormulaValue } from "@/features/assistant/types"
import { guessHeader, type HeaderCell } from "@/features/spreadsheet/data/sortFilter.logic"

// The sheet's side of the assistant's formula helper: what the model is told about the cells (where they are, the
// header row's labels, the kinds of value the first rows hold, never a value), and the check its formula passes
// before it is offered (writtenFormulaProblem, then the engine's formulaPreview).

// The rows the description reads: a header and three data rows.
const SAMPLE_ROWS = 4

// What the sample reads at most, in characters (26 columns of four rows).
const SAMPLE_CHARS = 8192

const ERROR_TEXT = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)$/u

// A cell's kind from its shown text, as the entry would read it: a number (a date or time too), a logical value, an
// error or text. `flags`: its tile's, when the tile is held, which says it for a number shown as text ("$4.00").
export function formulaCellType(text: string, locale: SheetLocale, flags?: number): FormulaCellType {
	if (flags !== undefined) {
		if ((flags & CellFlag.ERROR) !== 0) return "error"
		if ((flags & CellFlag.BOOLEAN) !== 0) return "logical"
		if ((flags & CellFlag.NUMBER) !== 0) return "number"
	}

	if (text === "") return "empty"
	if (ERROR_TEXT.test(text)) return "error"

	const parsed = parseCellInput(text, locale)

	if (parsed.type !== "value") return "text"

	return typeof parsed.value === "boolean" ? "logical" : typeof parsed.value === "string" ? "text" : "number"
}

function headerCell(type: FormulaCellType): HeaderCell {
	return type === "empty" ? "empty" : type === "text" ? "text" : "value"
}

// The columns as the prompt describes them, from the range's first rows as shown (`rows`, from its first row) and the
// held tiles' flags (`flags`, undefined where a tile is not held). The header row is Excel's guess (guessHeader).
export function formulaColumns(
	range: SheetRange,
	rows: readonly (readonly string[])[],
	locale: SheetLocale,
	flags: (row: number, col: number) => number | undefined = () => undefined
): { columns: FormulaColumn[]; header: boolean } {
	const lastCol = Math.min(range.endCol, range.startCol + FORMULA_MAX_COLUMNS - 1)
	const text = (row: number, col: number): string => rows[row - range.startRow]?.[col - range.startCol] ?? ""
	const type = (row: number, col: number): FormulaCellType => formulaCellType(text(row, col), locale, flags(row, col))
	const header = guessHeader({ ...range, endCol: lastCol }, (row, col) => ({ kind: headerCell(type(row, col)), style: 0 }))
	const first = header ? range.startRow + 1 : range.startRow
	const last = Math.min(range.endRow, first + SAMPLE_ROWS - 2)
	const columns: FormulaColumn[] = []

	for (let col = range.startCol; col <= lastCol; col++) {
		const types: FormulaCellType[] = []

		for (let row = first; row <= last; row++) types.push(type(row, col))

		columns.push({ column: columnName(col), header: header ? text(range.startRow, col) : null, types })
	}

	return { columns, header }
}

// The entry Insert starts: the formula (en-US, "=" first) in the locale's syntax ("," or ";" between arguments).
export function localizedEntry(formula: string, locale: SheetLocale): string {
	return `=${localizeFormula(formula.slice(1), locale)}`
}

export interface FormulaTarget {
	readonly sheet: SheetId
	readonly sheetName: string
	readonly sheets: readonly string[]
	readonly row: number
	readonly col: number
}

// What the request is about: the selection when it is a range, else the data around the active cell (the cells a
// one-cell sort takes), and the active cell as where the formula goes. One dataRegion query for a single cell, one
// text query for the first rows; the tiles held add their flags.
export async function formulaRequestContext(
	model: SheetGridModel,
	ask: string,
	locale: SheetLocale
): Promise<{ context: FormulaContext; target: FormulaTarget } | null> {
	const { sheet, sheets, selection } = model.getSnapshot()
	const sheetName = sheets.find(entry => entry.id === sheet)?.name
	const selected = selection.ranges.at(-1)

	if (sheetName === undefined || selected === undefined) return null

	const { row, col } = selection.active
	const single = selected.startRow === selected.endRow && selected.startCol === selected.endCol
	const range = single ? await model.session.query("dataRegion", { sheet, row, col }) : selected
	const sample = await model.session.query("text", {
		sheet,
		range: {
			startRow: range.startRow,
			startCol: range.startCol,
			endRow: Math.min(range.endRow, range.startRow + SAMPLE_ROWS - 1),
			endCol: Math.min(range.endCol, range.startCol + FORMULA_MAX_COLUMNS - 1)
		},
		maxChars: SAMPLE_CHARS
	})
	const { columns, header } = formulaColumns(range, parseTsv(sample.text), locale, (at, column) => {
		const found = model.entry(sheet, at, column)

		return found === null || entryText(found.tile, found.entry) === "" ? undefined : found.tile.flags[found.entry]
	})

	return {
		context: {
			sheet: sheetName,
			range: rangeName(range),
			headerRow: header ? range.startRow + 1 : null,
			cell: cellName(row, col),
			columns,
			ask
		},
		target: { sheet, sheetName, sheets: sheets.map(entry => entry.name), row, col }
	}
}

// The check a written formula passes: the app's (functions it calculates, references into this workbook, never the
// target cell), then the engine's calculation, written to no cell. #NAME? means a name the workbook lacks.
export function formulaChecker(
	model: SheetGridModel,
	target: FormulaTarget
): (formula: string) => Promise<FormulaCheck<AssistantFormulaValue>> {
	return async formula => {
		const problem = writtenFormulaProblem(formula, {
			sheets: target.sheets,
			sheet: target.sheetName,
			cell: { row: target.row, col: target.col }
		})

		if (problem !== null) return { ok: false, problem }

		const result = await model.session
			.query("formulaPreview", { sheet: target.sheet, formula })
			.catch(() => ({ refused: "unavailable" as const }))

		if ("refused" in result) return { ok: false, problem: { kind: "engine" } }
		if (result.error && result.value === "#NAME?") return { ok: false, problem: { kind: "name" } }

		return { ok: true, value: result }
	}
}
