import { DetailedCellError, ErrorType, HyperFormula, type RawCellContent, type SimpleCellAddress } from "hyperformula"

// HyperFormula over a workbook, for recalculating what an edit changes. Built only once the workbook has a
// formula to care about, and kept in step with the workbook from then on (cells, inserted and deleted rows
// and columns, added and renamed sheets). Formula text is never read back from it: references are moved in
// the workbook's own text (formulaRefs.ts), which stays Excel's.
// GPL-3.0 licensed, as the app (AGPL-3.0) may combine it.
const LICENSE_KEY = "gpl-v3"

export interface RecalculatedCell {
	sheet: number
	row: number
	col: number
	// A number, string, boolean, error text ("#DIV/0!") or null. Dates come as serial numbers.
	value: number | string | boolean | null
}

// A cell to give the engine. A formula also carries the result the file stored, when it has one: should
// the engine not read the formula (syntax it lacks) or not know a function in it, the cell holds that
// result instead, so what depends on it still calculates.
export interface EngineCell {
	row: number
	col: number
	content: RawCellContent
	fallback?: RawCellContent
}

export interface EngineSheet {
	name: string
	rows: RawCellContent[][]
	// Its formula cells that carry a fallback.
	formulas: EngineCell[]
}

export interface EngineName {
	name: string
	expression: string
	// Grid sheet index of a sheet-scoped name.
	scope?: number
}

// A circular reference. Excel, not iterating, shows 0 for it; iterating, the result it stored.
export const CYCLE = "#CYCLE!"

// Excel's own error texts, which the files store and the grid shows.
const ERROR_TEXT: Readonly<Partial<Record<ErrorType, string>>> = {
	[ErrorType.DIV_BY_ZERO]: "#DIV/0!",
	[ErrorType.NAME]: "#NAME?",
	[ErrorType.VALUE]: "#VALUE!",
	[ErrorType.NUM]: "#NUM!",
	[ErrorType.NA]: "#N/A",
	[ErrorType.REF]: "#REF!",
	[ErrorType.CYCLE]: CYCLE,
	[ErrorType.SPILL]: "#SPILL!"
}

const INSERT_RUN = 10_000

// What the engine gives back for a formula it could not read at all.
const PARSE_ERROR = "#ERROR!"

// Content standing in for a formula the engine cannot be given: text reading as its parse error.
export const UNPARSEABLE = `'${PARSE_ERROR}`

function exported(value: unknown): RecalculatedCell["value"] {
	if (value instanceof DetailedCellError) {
		return ERROR_TEXT[value.type] ?? value.value
	}

	return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null
}

interface Pending {
	address: SimpleCellAddress
	content: RawCellContent
	fallback: RawCellContent
}

export class FormulaEngine {
	private readonly engine: HyperFormula
	// Grid sheet index (worksheets only, as the grid lists them) → engine sheet id.
	private readonly sheetIds: number[] = []

	constructor(sheets: readonly EngineSheet[], names: readonly EngineName[]) {
		// A null-prototype record: a sheet named "__proto__" is a key like any other.
		const contents = Object.create(null) as Record<string, RawCellContent[][]>

		for (const sheet of sheets) {
			contents[sheet.name] = sheet.rows
		}

		this.engine = HyperFormula.buildFromSheets(contents, {
			licenseKey: LICENSE_KEY,
			// Ordinary formulas as Excel calculates them: a range where one value is expected meets the
			// formula's row or column. Array-evaluating calls are marked with ARRAYFORMULA (formulaRefs.ts).
			useArrayArithmetic: false,
			maxRows: 1_048_576,
			maxColumns: 16_384,
			// Excel's serial dates (1900-02-29 included), whitespace and empty-cell arithmetic.
			leapYear1900: true,
			nullDate: { year: 1899, month: 12, day: 31 },
			ignoreWhiteSpace: "any",
			evaluateNullToZero: true,
			// Undo is the document's own; the engine's would hold copies of what each operation replaced.
			undoLimit: 0
		})

		for (const sheet of sheets) {
			const id = this.engine.getSheetId(sheet.name)

			if (id === undefined) {
				throw new Error(`spreadsheet: engine has no sheet ${sheet.name}`)
			}

			this.sheetIds.push(id)
		}

		// Added after the sheets so a scope can name one by id. A name the engine cannot take (a print area
		// it has no syntax for) is left out: what uses it keeps the file's results.
		this.engine.batch(() => {
			for (const named of names) {
				const scope = named.scope === undefined ? undefined : this.sheetIds[named.scope]
				const expression = `=${named.expression}`

				if (this.engine.isItPossibleToAddNamedExpression(named.name, expression, scope)) {
					this.engine.addNamedExpression(named.name, expression, scope)
				}
			}
		})

		this.settle(
			sheets.flatMap((sheet, index) => sheet.formulas.flatMap(cell => this.pending(index, cell))),
			new Map()
		)
	}

	private pending(sheet: number, cell: EngineCell): Pending[] {
		const id = this.sheetIds[sheet]

		return id === undefined || cell.fallback === undefined
			? []
			: [{ address: { sheet: id, row: cell.row, col: cell.col }, content: cell.content, fallback: cell.fallback }]
	}

	// Whether the engine failed on this formula for a reason of its own, not an error the formula means.
	private fails(cell: Pending): boolean {
		const value = this.engine.getCellValue(cell.address)

		if (!(value instanceof DetailedCellError)) {
			return false
		}

		if (value.type === ErrorType.ERROR) {
			return typeof cell.content !== "string" || !this.engine.validateFormula(cell.content)
		}

		// A legacy array formula has no room to spill over the values the file keeps in its range (the
		// formula's own spill has no origin address; one it inherits has its own).
		if (value.type === ErrorType.SPILL) {
			return value.address === undefined
		}

		// An unknown function or name in this very formula, not one it inherits.
		return value.type === ErrorType.NAME && value.address === this.engine.simpleCellAddressToString(cell.address, -1)
	}

	// Replaces formulas the engine fails on with their fallbacks, recording what that recalculates. A second
	// round catches formulas whose own failure an inherited one hid.
	private settle(cells: Pending[], changes: Map<string, RecalculatedCell>): void {
		let pending = cells

		for (let round = 0; round < 3 && pending.length > 0; round++) {
			const failing = pending.filter(cell => this.fails(cell))

			if (failing.length === 0) {
				return
			}

			this.collect(
				this.engine.batch(() => {
					for (const cell of failing) {
						this.engine.setCellContents(cell.address, cell.fallback)
					}
				}),
				changes
			)

			for (const cell of failing) {
				changes.delete(`${String(cell.address.sheet)},${String(cell.address.row)},${String(cell.address.col)}`)
			}

			const failed = new Set(failing)

			pending = pending.filter(cell => !failed.has(cell))
		}
	}

	private sheetIndex(id: number): number {
		return this.sheetIds.indexOf(id)
	}

	private collect(exportedChanges: ReturnType<HyperFormula["batch"]>, into: Map<string, RecalculatedCell>): void {
		for (const change of exportedChanges) {
			if (!("address" in change)) {
				continue
			}

			const sheet = this.sheetIndex(change.address.sheet)

			if (sheet < 0) {
				continue
			}

			into.set(`${String(change.address.sheet)},${String(change.address.row)},${String(change.address.col)}`, {
				sheet,
				row: change.address.row,
				col: change.address.col,
				value: exported(change.newValue)
			})
		}
	}

	// Sets cells and returns every cell whose value changed as a result, the set ones included (except
	// formulas that fell back to their stored result, which did not change).
	set(sheet: number, cells: readonly EngineCell[]): RecalculatedCell[] {
		const id = this.sheetIds[sheet]

		if (id === undefined || cells.length === 0) {
			return []
		}

		const changes = new Map<string, RecalculatedCell>()

		this.collect(
			this.engine.batch(() => {
				for (const cell of cells) {
					const address = { sheet: id, row: cell.row, col: cell.col }

					try {
						this.engine.setCellContents(address, cell.content)
					} catch {
						// A formula the parser overflows on: it holds what it stored, or reads as unparseable.
						this.engine.setCellContents(address, cell.fallback ?? UNPARSEABLE)
					}
				}
			}),
			changes
		)
		this.settle(
			cells.flatMap(cell => this.pending(sheet, cell)),
			changes
		)

		return [...changes.values()]
	}

	// Whether a result is the engine failing rather than the formula (a function it lacks, syntax it cannot
	// read, an array it spills where Excel does not): the file's own result is kept.
	static unsupported(value: unknown): boolean {
		return value === "#NAME?" || value === PARSE_ERROR || value === "#SPILL!" || value === CYCLE
	}

	// Whether the engine can insert or delete these rows or columns (it cannot move a spilled array onto
	// cells it would cover, nor grow a sheet past its size).
	canMove(sheet: number, edit: { type: "insert" | "delete"; axis: "rows" | "cols"; at: number; count: number }): boolean {
		const id = this.sheetIds[sheet]

		if (id === undefined) {
			return true
		}

		const span: [number, number] = [edit.at, edit.count]

		if (edit.type === "insert") {
			return edit.axis === "rows" ? this.engine.isItPossibleToAddRows(id, span) : this.engine.isItPossibleToAddColumns(id, span)
		}

		return edit.axis === "rows" ? this.engine.isItPossibleToRemoveRows(id, span) : this.engine.isItPossibleToRemoveColumns(id, span)
	}

	insert(sheet: number, axis: "rows" | "cols", at: number, count: number): RecalculatedCell[] {
		const id = this.sheetIds[sheet]
		const changes = new Map<string, RecalculatedCell>()

		if (id !== undefined) {
			// In runs: the engine spreads the new rows into one call, which a large insert overflows.
			this.collect(
				this.engine.batch(() => {
					for (let done = 0; done < count; done += INSERT_RUN) {
						const run = Math.min(INSERT_RUN, count - done)

						if (axis === "rows") this.engine.addRows(id, [at, run])
						else this.engine.addColumns(id, [at, run])
					}
				}),
				changes
			)
		}

		return [...changes.values()]
	}

	remove(sheet: number, axis: "rows" | "cols", at: number, count: number): RecalculatedCell[] {
		const id = this.sheetIds[sheet]
		const changes = new Map<string, RecalculatedCell>()

		if (id !== undefined) {
			this.collect(axis === "rows" ? this.engine.removeRows(id, [at, count]) : this.engine.removeColumns(id, [at, count]), changes)
		}

		return [...changes.values()]
	}

	addSheet(name: string): void {
		const added = this.engine.addSheet(name)
		const id = this.engine.getSheetId(added)

		if (id === undefined) {
			throw new Error(`spreadsheet: engine has no sheet ${name}`)
		}

		this.sheetIds.push(id)
	}

	// Removes the last sheet (an added one being undone).
	removeLastSheet(): RecalculatedCell[] {
		const id = this.sheetIds.pop()
		const changes = new Map<string, RecalculatedCell>()

		if (id !== undefined) {
			this.collect(this.engine.removeSheet(id), changes)
		}

		return [...changes.values()]
	}

	renameSheet(sheet: number, name: string): void {
		const id = this.sheetIds[sheet]

		if (id !== undefined) {
			this.engine.renameSheet(id, name)
		}
	}

	value(sheet: number, row: number, col: number): RecalculatedCell["value"] {
		const id = this.sheetIds[sheet]

		return id === undefined ? null : exported(this.engine.getCellValue({ sheet: id, row, col }))
	}

	destroy(): void {
		this.engine.destroy()
	}
}
