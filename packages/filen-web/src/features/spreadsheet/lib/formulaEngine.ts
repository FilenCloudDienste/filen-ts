import { DetailedCellError, ErrorType, HyperFormula, type RawCellContent } from "hyperformula"
import type { CellValue, Workbook } from "hucre"
import { isWorksheet } from "@/features/spreadsheet/lib/xlsxView"

// HyperFormula over a workbook, for recalculating what an edit changes and for moving formula references
// when rows or columns are inserted or deleted. Built only once the workbook has a formula to care about.
// GPL-3.0 licensed, as the app (AGPL-3.0) may combine it.
const LICENSE_KEY = "gpl-v3"

export interface RecalculatedCell {
	sheet: number
	row: number
	col: number
	value: CellValue
}

// Excel's own error texts, which the files store and the grid shows.
const ERROR_TEXT: Readonly<Partial<Record<ErrorType, string>>> = {
	[ErrorType.DIV_BY_ZERO]: "#DIV/0!",
	[ErrorType.NAME]: "#NAME?",
	[ErrorType.VALUE]: "#VALUE!",
	[ErrorType.NUM]: "#NUM!",
	[ErrorType.NA]: "#N/A",
	[ErrorType.REF]: "#REF!",
	[ErrorType.CYCLE]: "#REF!",
	[ErrorType.SPILL]: "#SPILL!"
}

export class FormulaEngine {
	private readonly engine: HyperFormula
	// Grid sheet index (worksheets only, as the grid lists them) → engine sheet id.
	private readonly sheetIds = new Map<number, number>()

	constructor(workbook: Workbook) {
		const sheets: Record<string, RawCellContent[][]> = {}
		const worksheets = workbook.sheets.filter(isWorksheet)

		worksheets.forEach(sheet => {
			sheets[sheet.name] = sheet.rows.map((values, row) =>
				values.map((value, col) => {
					const formula = sheet.cells?.get(`${String(row)},${String(col)}`)?.formula

					return formula === undefined ? value : `=${formula}`
				})
			)
		})

		this.engine = HyperFormula.buildFromSheets(
			sheets,
			{ licenseKey: LICENSE_KEY, useArrayArithmetic: true, maxRows: 1_048_576, maxColumns: 16_384 },
			(workbook.namedRanges ?? []).map(named => ({ name: named.name, expression: `=${named.range}` }))
		)

		worksheets.forEach((sheet, index) => {
			const id = this.engine.getSheetId(sheet.name)

			if (id !== undefined) {
				this.sheetIds.set(index, id)
			}
		})
	}

	private sheetIndex(id: number): number | undefined {
		for (const [index, sheetId] of this.sheetIds) {
			if (sheetId === id) {
				return index
			}
		}

		return undefined
	}

	// Sets cells and returns every cell whose value changed as a result, the set ones included.
	set(sheet: number, cells: readonly { row: number; col: number; content: RawCellContent }[]): RecalculatedCell[] {
		const id = this.sheetIds.get(sheet)

		if (id === undefined) {
			return []
		}

		const changes = this.engine.batch(() => {
			for (const cell of cells) {
				this.engine.setCellContents({ sheet: id, row: cell.row, col: cell.col }, cell.content)
			}
		})

		return this.recalculated(changes)
	}

	private recalculated(changes: ReturnType<HyperFormula["batch"]>): RecalculatedCell[] {
		const cells: RecalculatedCell[] = []

		for (const change of changes) {
			if (!("address" in change)) {
				continue
			}

			const sheet = this.sheetIndex(change.address.sheet)

			if (sheet === undefined) {
				continue
			}

			const value = change.newValue

			cells.push({
				sheet,
				row: change.address.row,
				col: change.address.col,
				value: value instanceof DetailedCellError ? (ERROR_TEXT[value.type] ?? value.value) : value
			})
		}

		return cells
	}

	// Whether the engine could not evaluate `value` for a reason of its own (a function it does not know),
	// rather than the formula being wrong: such a result keeps the value the file stored.
	static unsupported(value: CellValue): boolean {
		return value === "#NAME?"
	}

	insert(sheet: number, axis: "rows" | "cols", at: number, count: number): RecalculatedCell[] {
		const id = this.sheetIds.get(sheet)

		if (id === undefined) {
			return []
		}

		return this.recalculated(axis === "rows" ? this.engine.addRows(id, [at, count]) : this.engine.addColumns(id, [at, count]))
	}

	remove(sheet: number, axis: "rows" | "cols", at: number, count: number): RecalculatedCell[] {
		const id = this.sheetIds.get(sheet)

		if (id === undefined) {
			return []
		}

		return this.recalculated(axis === "rows" ? this.engine.removeRows(id, [at, count]) : this.engine.removeColumns(id, [at, count]))
	}

	// A cell's formula as the engine now has it (references moved by inserts and deletes), without its "=".
	formula(sheet: number, row: number, col: number): string | undefined {
		const id = this.sheetIds.get(sheet)
		const formula = id === undefined ? undefined : this.engine.getCellFormula({ sheet: id, row, col })

		return formula?.startsWith("=") === true ? formula.slice(1) : formula
	}

	value(sheet: number, row: number, col: number): CellValue {
		const id = this.sheetIds.get(sheet)

		if (id === undefined) {
			return null
		}

		const value = this.engine.getCellValue({ sheet: id, row, col })

		return value instanceof DetailedCellError ? (ERROR_TEXT[value.type] ?? value.value) : (value ?? null)
	}

	destroy(): void {
		this.engine.destroy()
	}
}
