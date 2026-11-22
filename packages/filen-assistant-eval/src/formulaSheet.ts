import {
	checkWrittenFormula,
	columnName,
	parseCellInput,
	rangeName,
	type FormulaPreviewValue,
	type SheetQueryResult,
	type WrittenFormulaTarget
} from "@filen/office/core/sheet"
import { FormulaEngine, previewFormula } from "@filen/office/core/sheet/formula"
import type { FormulaCellType, FormulaCheck, FormulaContext } from "@filen/shared/assistant"
import type { FormulaCase } from "./cases/formula"
import type { FormulaCell, FormulaSheet } from "./cases/formulaSheets"

// A formula case's sheet as the app has it: the description the model gets (formulaRequestContext in the web app
// describes the cells the same way: the range, the header row, three data rows' kinds, never a value) and the check
// its formula passes (@filen/office checkWrittenFormula over the formula engine, as the formulaPreview query runs it).

function cellType(cell: FormulaCell | undefined): FormulaCellType {
	return cell === null || cell === undefined || cell === ""
		? "empty"
		: typeof cell === "number"
			? "number"
			: typeof cell === "boolean"
				? "logical"
				: "text"
}

// Where the formula goes, 0-based, from its A1 name.
export function targetCell(cell: string): { row: number; col: number } {
	const parsed = /^([A-Z]+)(\d+)$/u.exec(cell)

	if (parsed === null) throw new Error(`Not a cell: ${cell}`)

	const col = [...(parsed[1] ?? "")].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1

	return { row: Number(parsed[2]) - 1, col }
}

export function formulaCaseContext(item: Pick<FormulaCase, "sheet" | "cell" | "ask">): FormulaContext {
	const { rows } = item.sheet
	const width = Math.max(...rows.map(row => row.length))
	const header = rows[0] ?? []

	return {
		sheet: item.sheet.name,
		range: rangeName({ startRow: 0, startCol: 0, endRow: rows.length - 1, endCol: width - 1 }),
		headerRow: 1,
		cell: item.cell,
		columns: Array.from({ length: width }, (_, col) => ({
			column: columnName(col),
			header: String(header[col] ?? ""),
			types: rows.slice(1, 4).map(row => cellType(row[col]))
		})),
		ask: item.ask
	}
}

// The sheet's engine, for one case's checks (destroy it after).
export function sheetEngine(sheet: FormulaSheet): FormulaEngine {
	return new FormulaEngine([{ name: sheet.name, rows: sheet.rows.map(row => [...row]), formulas: [] }], [])
}

// The formulaPreview query's answer on the case's one sheet.
export function preview(engine: FormulaEngine, formula: string): SheetQueryResult<"formulaPreview"> {
	const parsed = parseCellInput(formula)

	return parsed.type === "formula" ? previewFormula(engine, 0, parsed.formula) : { refused: "formula" }
}

export function formulaTarget(item: Pick<FormulaCase, "sheet" | "cell">): WrittenFormulaTarget {
	return { sheets: [item.sheet.name], sheet: item.sheet.name, cell: targetCell(item.cell) }
}

export function formulaCheck(
	engine: FormulaEngine,
	item: Pick<FormulaCase, "sheet" | "cell">
): (formula: string) => Promise<FormulaCheck<FormulaPreviewValue>> {
	const target = formulaTarget(item)

	return formula => checkWrittenFormula(formula, target, written => Promise.resolve(preview(engine, written)))
}
