import {
	dateToSerial,
	isDateFormat,
	serialToDate,
	type Cell,
	type CellStyle,
	type CellValue,
	type ColumnDef,
	type MergeRange,
	type RowDef,
	type Sheet
} from "hucre"
import { saveXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { RawCellContent } from "hyperformula"
import { parseCellInput } from "@/features/spreadsheet/lib/cellInput.logic"
import {
	MAX_COLS,
	MAX_EDIT_CELLS,
	MAX_ROWS,
	MAX_SHEET_CELLS,
	type CellPatch,
	type DocState,
	type EditOp,
	type EditResult,
	type FormatPatch
} from "@/features/spreadsheet/lib/edits"
import {
	FormulaEngine,
	type EngineCell,
	type EngineName,
	type EngineSheet,
	type RecalculatedCell
} from "@/features/spreadsheet/lib/formulaEngine"
import {
	engineFormula,
	formulaTranslator,
	namesSheet,
	renameSheetInFormula,
	shiftFormula,
	type AxisEdit
} from "@/features/spreadsheet/lib/formulaRefs"
import { cellKey, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import {
	isWorksheet,
	sheetExtent,
	structureLocked,
	workbookDoc,
	workbookStructureLocked,
	WorkbookViews
} from "@/features/spreadsheet/lib/xlsxView"
import { xlsxWritable } from "@/features/spreadsheet/lib/xlsxWritable"

// Excel's own limits.
const HISTORY_LIMIT = 100
const SHEET_NAME = /^[^\\/?*[\]:]{1,31}$/
// Undo keeps what each step replaced; past this many cells in all, the oldest steps go.
const HISTORY_CELLS = MAX_SHEET_CELLS
const ERROR_VALUE = /^#[A-Z0-9/!?_]+$/

type NamedRange = NonNullable<RoundtripWorkbook["namedRanges"]>[number]

function key(row: number, col: number): string {
	return `${String(row)},${String(col)}`
}

function parseKey(cellId: string): [number, number] {
	const comma = cellId.indexOf(",")

	return [Number(cellId.slice(0, comma)), Number(cellId.slice(comma + 1))]
}

function typeOf(value: CellValue): Cell["type"] {
	if (value === null) return "empty"
	if (typeof value === "number") return "number"
	if (typeof value === "boolean") return "boolean"
	if (value instanceof Date) return "date"

	return "string"
}

// A value as the engine reads it: text stays text whatever it looks like ('007, '=1+1, 'TRUE), and a date
// is its serial number, never a Date the engine would read in the viewer's timezone.
function engineValue(value: CellValue): RawCellContent {
	if (typeof value === "string") return `'${value}`
	if (value instanceof Date) return dateToSerial(value, false)

	return value
}

// What a formula cell stored for its result, as the engine takes it in place of a formula it cannot read.
function storedResult(cell: Cell): RawCellContent | undefined {
	const result = cell.formulaResult

	if (result === undefined || result === null) return undefined
	if (typeof result === "string" && ERROR_VALUE.test(result)) return result

	return engineValue(result)
}

function hasStoredResult(cell: Cell): boolean {
	return cell.formulaResult !== undefined && cell.formulaResult !== null
}

// The file's cached results for shared formulas (a formula stored once, filled over a range) are kept;
// every cell of the range gets its own formula, its references moved as filling would move them, so the
// file saves ordinary formulas that nothing orphans.
function expandSharedFormulas(sheets: readonly Sheet[]): void {
	for (const sheet of sheets) {
		const masters = new Map<number, { row: number; col: number; translate: (rows: number, cols: number) => string }>()

		for (const [cellId, cell] of sheet.cells ?? []) {
			if (
				cell.formulaType === "shared" &&
				cell.formula !== undefined &&
				cell.formula !== "" &&
				cell.formulaSharedIndex !== undefined
			) {
				const [row, col] = parseKey(cellId)

				masters.set(cell.formulaSharedIndex, { row, col, translate: formulaTranslator(cell.formula) })
			}
		}

		for (const [cellId, cell] of sheet.cells ?? []) {
			if (cell.formulaType !== "shared") {
				continue
			}

			if (cell.formula === "" || cell.formula === undefined) {
				const master = cell.formulaSharedIndex === undefined ? undefined : masters.get(cell.formulaSharedIndex)

				if (master === undefined) {
					// Its formula is lost: the value it showed stays.
					delete cell.formula
					delete cell.formulaResult
					cell.type = typeOf(cell.value)
				} else {
					const [row, col] = parseKey(cellId)

					cell.formula = master.translate(row - master.row, col - master.col)
					cell.type = "formula"

					if (cell.value !== null) {
						cell.formulaResult = cell.value
					}
				}
			}

			delete cell.formulaType
			delete cell.formulaSharedIndex
			delete cell.formulaRef
		}
	}
}

// A rename rewrites cell formulas, defined names and hyperlinks; formulas elsewhere in the file it cannot
// reach (charts, pivot caches, validations, conditional formats, sparklines, tables) would keep the old name.
function renameLocked(sheets: readonly Sheet[]): boolean {
	return sheets.some(
		sheet =>
			!isWorksheet(sheet) ||
			(sheet.charts?.length ?? 0) > 0 ||
			(sheet.pivotTables?.length ?? 0) > 0 ||
			(sheet.slicers?.length ?? 0) > 0 ||
			(sheet.timelines?.length ?? 0) > 0 ||
			(sheet.dataValidations?.length ?? 0) > 0 ||
			(sheet.conditionalRules?.length ?? 0) > 0 ||
			(sheet.sparklines?.length ?? 0) > 0 ||
			(sheet.tables?.length ?? 0) > 0
	)
}

interface CellBefore {
	value: CellValue
	cell: Cell | undefined
}

// Text an edit replaced in a cell (a formula, a hyperlink's location), keyed where the cell was before it.
interface TextEdit {
	sheet: number
	key: string
	text: string
	// A deletion cut into one of the formula's references: re-inserting the rows does not restore the
	// engine's copy.
	cut?: boolean
}

// A formula cell's stored result before the engine recalculated it.
interface ResultBefore {
	sheet: number
	key: string
	result: CellValue | undefined
	value: CellValue
}

// What a deletion took out of a sheet: the values (whole rows, or each row's run of columns), cell details
// and row and column formats.
interface Removed {
	values: CellValue[][]
	cells: [string, Cell][]
	rowDefs: [number, RowDef][]
	columns: ColumnDef[]
}

// What undoing one step needs. Sheet numbers are workbook indices except in "structure", which keeps the
// grid's.
type Step =
	| { type: "cells"; sheet: number; before: Map<string, CellBefore> }
	| {
			type: "structure"
			sheet: number
			edit: AxisEdit
			merges: MergeRange[] | undefined
			removed: Removed | null
			formulas: TextEdit[]
			links: TextEdit[]
	  }
	| { type: "addSheet"; results: ResultBefore[] }
	| { type: "rename"; sheet: number; name: string; formulas: TextEdit[]; links: TextEdit[]; names: NamedRange[] | undefined }

// `before` and `after` identify the document's states either side of the step: equal ids, equal content.
interface Entry {
	step: Step
	op: EditOp
	before: number
	after: number
	cells: number
}

// The cells in the sheet's rectangle once `cells` are written, as writing past its edge grows every row.
function grownBox(sheet: Sheet, cells: readonly { row: number; col: number }[]): number {
	let rows = sheet.rows.length
	let cols = sheet.rows[0]?.length ?? 0

	for (const cell of cells) {
		rows = Math.max(rows, cell.row + 1)
		cols = Math.max(cols, cell.col + 1)
	}

	return rows * cols
}

function stepCells(step: Step): number {
	switch (step.type) {
		case "cells":
			return step.before.size
		case "structure":
			return (
				1 +
				step.formulas.length +
				step.links.length +
				(step.removed === null
					? 0
					: step.removed.cells.length + step.removed.values.reduce((count, values) => count + values.length, 0))
			)
		case "addSheet":
			return 1 + step.results.length
		case "rename":
			return 1 + step.formulas.length + step.links.length + (step.names?.length ?? 0)
	}
}

// An open .xlsx: the workbook as read (every part the grid does not model rides along untouched and is
// written back as it was), its view for the grid, the formula engine once something needs it, and an undo
// history. Worker-side only.
export class XlsxDocument {
	private readonly workbook: RoundtripWorkbook
	private readonly views: WorkbookViews
	// Whether saving can write the file back intact (xlsxWritable.ts): a workbook that cannot is view-only.
	readonly writable: boolean
	// Built from the workbook as it stands the first time a formula needs calculating, then kept in step
	// with every edit. Once the workbook has had a formula, every edit that changes cells goes through it.
	private engine: FormulaEngine | null = null
	private hasFormulas = false
	private undoSteps: Entry[] = []
	private redoSteps: { op: EditOp; after: number }[] = []
	private historyCells = 0
	// Identifies the current state; `saved` is the state last written to the file (0: as opened).
	private current = 0
	private nextState = 1
	private saved = 0
	// The style table's length when the running edit started.
	private styleMark = 0
	private readonly historyBudget: number

	constructor(workbook: RoundtripWorkbook, historyBudget = HISTORY_CELLS) {
		this.workbook = workbook
		this.historyBudget = historyBudget
		this.views = new WorkbookViews(workbook.themeColors)
		this.writable = xlsxWritable(workbook)

		const worksheets = this.worksheets()

		expandSharedFormulas(worksheets)

		this.hasFormulas = worksheets.some(sheet => {
			for (const cell of sheet.cells?.values() ?? []) {
				if (cell.formula !== undefined) return true
			}

			return false
		})

		if (this.hasFormulas) {
			this.calculateMissing()
		}
	}

	// Files written by other programs often store formulas without their results, leaving the calculation
	// to whatever opens them: those are calculated now. Filling them in is not an edit.
	private calculateMissing(): void {
		const missing: { sheet: Sheet; index: number; row: number; col: number; cell: Cell }[] = []

		this.worksheets().forEach((sheet, index) => {
			for (const [cellId, cell] of sheet.cells ?? []) {
				if (cell.formula !== undefined && !hasStoredResult(cell)) {
					const [row, col] = parseKey(cellId)

					missing.push({ sheet, index, row, col, cell })
				}
			}
		})

		if (missing.length === 0) {
			return
		}

		const engine = this.ensureEngine()

		for (const { sheet, index, row, col, cell } of missing) {
			this.storeResult(sheet, row, col, cell, engine.value(index, row, col))
		}
	}

	doc(): SpreadsheetDoc {
		return workbookDoc(this.workbook, this.views, this.writable)
	}

	// Grid sheet index → workbook sheet (worksheets only).
	private worksheets(): Sheet[] {
		return this.workbook.sheets.filter(isWorksheet)
	}

	private workbookIndex(sheet: number): number {
		const target = this.worksheets()[sheet]

		return target === undefined ? -1 : this.workbook.sheets.indexOf(target)
	}

	private state(): DocState {
		return { dirty: this.current !== this.saved, canUndo: this.undoSteps.length > 0, canRedo: this.redoSteps.length > 0 }
	}

	private ensureEngine(): FormulaEngine {
		this.engine ??= this.buildEngine()

		return this.engine
	}

	private buildEngine(): FormulaEngine {
		const worksheets = this.worksheets()
		const sheets: EngineSheet[] = worksheets.map(sheet => {
			const rows = sheet.rows.map(values => values.map(engineValue))
			const formulas: EngineCell[] = []

			for (const [cellId, cell] of sheet.cells ?? []) {
				const [row, col] = parseKey(cellId)
				const values = rows[row]

				if (values === undefined) {
					continue
				}

				if (cell.formula !== undefined) {
					const content = `=${engineFormula(cell.formula)}`
					const fallback = storedResult(cell)

					values[col] = content
					formulas.push(fallback === undefined ? { row, col, content } : { row, col, content, fallback })
				} else if (cell.type === "error") {
					values[col] = sheet.rows[row]?.[col] ?? null
				}
			}

			return { name: sheet.name, rows, formulas }
		})
		const names: EngineName[] = []

		for (const named of this.workbook.namedRanges ?? []) {
			const scope = named.scope === undefined ? undefined : worksheets.findIndex(sheet => sheet.name === named.scope)

			if (scope === undefined) {
				names.push({ name: named.name, expression: engineFormula(named.range) })
			} else if (scope >= 0) {
				names.push({ name: named.name, expression: engineFormula(named.range), scope })
			}
		}

		return new FormulaEngine(sheets, names)
	}

	private engineCell(sheet: Sheet, row: number, col: number): EngineCell {
		const cell = sheet.cells?.get(key(row, col))
		const value = sheet.rows[row]?.[col] ?? null

		if (cell?.formula !== undefined) {
			const content = `=${engineFormula(cell.formula)}`
			const fallback = storedResult(cell)

			return fallback === undefined ? { row, col, content } : { row, col, content, fallback }
		}

		return { row, col, content: cell?.type === "error" ? value : engineValue(value) }
	}

	// A formula's result stored in its cell: a number shown as a date is kept as the date it is.
	private storeResult(sheet: Sheet, row: number, col: number, cell: Cell, value: RecalculatedCell["value"]): void {
		const numFmt = cell.style?.numFmt
		const result = typeof value === "number" && numFmt !== undefined && isDateFormat(numFmt) ? serialToDate(value, false) : value
		const values = sheet.rows[row]

		cell.formulaResult = result
		cell.value = result

		if (values !== undefined) {
			values[col] = result
		}
	}

	// Stores what the engine recalculated into the formula cells it names (a value cell the engine echoes
	// back is what was set already). A result the engine could not compute itself keeps the stored one.
	private applyRecalculated(cells: readonly RecalculatedCell[]): RecalculatedCell[] {
		const worksheets = this.worksheets()
		const applied: RecalculatedCell[] = []

		for (const recalculated of cells) {
			const sheet = worksheets[recalculated.sheet]
			const cell = sheet?.cells?.get(key(recalculated.row, recalculated.col))

			if (sheet === undefined || cell?.formula === undefined) {
				continue
			}

			if (FormulaEngine.unsupported(recalculated.value) && hasStoredResult(cell)) {
				continue
			}

			this.storeResult(sheet, recalculated.row, recalculated.col, cell, recalculated.value)
			applied.push(recalculated)
		}

		return applied
	}

	private pushStep(entry: Entry): void {
		this.undoSteps.push(entry)
		this.historyCells += entry.cells

		while (this.undoSteps.length > 1 && (this.undoSteps.length > HISTORY_LIMIT || this.historyCells > this.historyBudget)) {
			const dropped = this.undoSteps.shift()

			this.historyCells -= dropped?.cells ?? 0
		}
	}

	apply(op: EditOp): EditResult {
		this.styleMark = this.views.styles.styles.length

		const result = this.run(op)

		if (result.step !== null) {
			const after = this.nextState++

			this.pushStep({ step: result.step, op, before: this.current, after, cells: stepCells(result.step) })
			this.redoSteps = []
			this.current = after
		}

		return result.result()
	}

	undo(): EditResult {
		this.styleMark = this.views.styles.styles.length

		const last = this.undoSteps.pop()

		if (last === undefined) {
			return { type: "none", state: this.state() }
		}

		this.historyCells -= last.cells
		this.redoSteps.push({ op: last.op, after: last.after })
		this.current = last.before

		return this.revert(last.step)
	}

	redo(): EditResult {
		this.styleMark = this.views.styles.styles.length

		const redone = this.redoSteps.pop()

		if (redone === undefined) {
			return { type: "none", state: this.state() }
		}

		const redoSteps = this.redoSteps
		const result = this.run(redone.op)

		if (result.step !== null) {
			this.pushStep({ step: result.step, op: redone.op, before: this.current, after: redone.after, cells: stepCells(result.step) })
			this.current = redone.after
		}

		this.redoSteps = redoSteps

		return result.result()
	}

	// The file's bytes as edited, and the state they hold. saveXlsx reads the workbook before its first
	// await, so an edit arriving while it compresses is not in the bytes.
	async serialize(): Promise<{ bytes: Uint8Array; version: number }> {
		if (!this.writable) {
			throw new Error("spreadsheet: this workbook cannot be saved")
		}

		const version = this.current

		return { bytes: await saveXlsx(this.workbook), version }
	}

	// The state `version` names is now the file's: the document is clean exactly while it is back there.
	markSaved(version: number): DocState {
		this.saved = version

		return this.state()
	}

	close(): void {
		this.engine?.destroy()
		this.engine = null
	}

	private revert(step: Step): EditResult {
		switch (step.type) {
			case "cells":
				return this.revertCells(step)
			case "structure":
				return this.revertStructure(step)
			case "addSheet": {
				this.workbook.sheets.pop()
				this.engine?.removeLastSheet()

				// The results the sheet's arrival changed go back to what they were; the engine's own copies
				// are what they were before it too (references to a missing sheet).
				for (const before of step.results) {
					const sheet = this.workbook.sheets[before.sheet]
					const cell = sheet?.cells?.get(before.key)
					const [row, col] = parseKey(before.key)
					const values = sheet?.rows[row]

					if (cell === undefined) {
						continue
					}

					if (before.result === undefined) delete cell.formulaResult
					else cell.formulaResult = before.result

					cell.value = before.value

					if (values !== undefined) {
						values[col] = before.value
					}
				}

				return this.sheetsResult()
			}
			case "rename": {
				const sheet = this.workbook.sheets[step.sheet]

				if (sheet !== undefined) {
					sheet.name = step.name
					this.engine?.renameSheet(this.worksheets().indexOf(sheet), step.name)
				}

				this.restoreText(step.formulas, (cell, text) => {
					cell.formula = text
				})
				this.restoreText(step.links, (cell, text) => {
					if (cell.hyperlink !== undefined) cell.hyperlink = { ...cell.hyperlink, location: text }
				})

				if (step.names === undefined) delete this.workbook.namedRanges
				else this.workbook.namedRanges = step.names

				return this.sheetsResult()
			}
		}
	}

	private restoreText(edits: readonly TextEdit[], restore: (cell: Cell, text: string) => void): void {
		for (const edit of edits) {
			const cell = this.workbook.sheets[edit.sheet]?.cells?.get(edit.key)

			if (cell !== undefined) {
				restore(cell, edit.text)
			}
		}
	}

	private revertCells(step: Extract<Step, { type: "cells" }>): EditResult {
		const sheet = this.workbook.sheets[step.sheet]

		if (sheet === undefined) {
			return { type: "none", state: this.state() }
		}

		const gridIndex = this.worksheets().indexOf(sheet)
		const touched: { row: number; col: number }[] = []

		for (const before of step.before.values()) {
			if (before.cell?.formula !== undefined) {
				this.hasFormulas = true
			}
		}

		// Built before the cells go back, so putting them back is what it recalculates.
		const engine = this.hasFormulas ? this.ensureEngine() : null

		for (const [cellId, before] of step.before) {
			const [row, col] = parseKey(cellId)

			this.write(sheet, row, col, before.value, before.cell)
			touched.push({ row, col })
		}

		const recalculated =
			engine === null
				? []
				: this.applyRecalculated(
						engine.set(
							gridIndex,
							touched.map(({ row, col }) => this.engineCell(sheet, row, col))
						)
					)

		return this.cellsResult(gridIndex, touched, recalculated)
	}

	private revertStructure(step: Extract<Step, { type: "structure" }>): EditResult {
		const sheet = this.worksheets()[step.sheet]

		if (sheet === undefined) {
			return this.sheetsResult()
		}

		const { edit } = step
		const engine = this.hasFormulas ? this.ensureEngine() : null

		if (edit.type === "insert") {
			shiftSheet(sheet, { ...edit, type: "delete" })
		} else if (step.removed !== null) {
			restoreDeleted(sheet, edit, step.removed)
		}

		if (step.merges === undefined) delete sheet.merges
		else sheet.merges = step.merges

		this.restoreText(step.formulas, (cell, text) => {
			cell.formula = text
		})
		this.restoreText(step.links, (cell, text) => {
			if (cell.hyperlink !== undefined) cell.hyperlink = { ...cell.hyperlink, location: text }
		})

		if (engine !== null) {
			let recalculated: RecalculatedCell[]

			if (edit.type === "insert") {
				recalculated = engine.remove(step.sheet, edit.axis, edit.at, edit.count)
			} else {
				recalculated = engine.insert(step.sheet, edit.axis, edit.at, edit.count)

				// What came back, and the formulas the deletion had cut, as they were: the engine moves every
				// other reference back itself, but its copies of cut ones stay cut.
				const worksheets = this.worksheets()
				const cells = new Map<number, Map<string, EngineCell>>()
				const add = (gridIndex: number, row: number, col: number) => {
					const target = worksheets[gridIndex]

					if (target === undefined) {
						return
					}

					let targetCells = cells.get(gridIndex)

					if (targetCells === undefined) {
						targetCells = new Map()
						cells.set(gridIndex, targetCells)
					}

					targetCells.set(key(row, col), this.engineCell(target, row, col))
				}

				step.removed?.values.forEach((values, index) => {
					values.forEach((value, offset) => {
						if (value !== null) {
							add(
								step.sheet,
								edit.axis === "rows" ? edit.at + index : index,
								edit.axis === "rows" ? offset : edit.at + offset
							)
						}
					})
				})

				for (const [cellId] of step.removed?.cells ?? []) {
					const [row, col] = parseKey(cellId)

					add(step.sheet, row, col)
				}

				for (const formula of step.formulas) {
					if (formula.cut !== true) {
						continue
					}

					const target = this.workbook.sheets[formula.sheet]
					const [row, col] = parseKey(formula.key)

					if (target !== undefined) add(worksheets.indexOf(target), row, col)
				}

				for (const [gridIndex, targetCells] of cells) {
					recalculated = recalculated.concat(engine.set(gridIndex, [...targetCells.values()]))
				}
			}

			this.applyRecalculated(recalculated)
		}

		return this.sheetsResult()
	}

	private run(op: EditOp): { step: Step | null; result: () => EditResult } {
		switch (op.type) {
			case "setCells":
				return this.setCells(op.sheet, op.cells)
			case "format":
				return this.format(op.sheet, op)
			case "insert":
			case "delete":
				return this.structure(op)
			case "addSheet":
				return this.addSheet(op.name)
			case "renameSheet":
				return this.renameSheet(op.sheet, op.name)
		}
	}

	// The cell's value and detail written together, keeping the dense rectangle the workbook model promises
	// (every row as long as the longest).
	private write(sheet: Sheet, row: number, col: number, value: CellValue, cell: Cell | undefined): void {
		const width = Math.max(sheet.rows[0]?.length ?? 0, col + 1)

		if ((sheet.rows[0]?.length ?? 0) < width) {
			for (const values of sheet.rows) {
				while (values.length < width) values.push(null)
			}
		}

		while (sheet.rows.length <= row) {
			sheet.rows.push(new Array<CellValue>(width).fill(null))
		}

		const values = sheet.rows[row]

		if (values !== undefined) {
			values[col] = value
		}

		if (cell === undefined) {
			sheet.cells?.delete(key(row, col))
		} else {
			sheet.cells ??= new Map()
			sheet.cells.set(key(row, col), cell)
		}
	}

	private refused(reason: "structureLocked" | "sheetName" | "tooLarge"): { step: null; result: () => EditResult } {
		return { step: null, result: () => ({ type: "refused", reason, state: this.state() }) }
	}

	private setCells(
		sheetIndex: number,
		cells: readonly { row: number; col: number; input: string }[]
	): { step: Step | null; result: () => EditResult } {
		const sheet = this.worksheets()[sheetIndex]

		if (
			sheet === undefined ||
			cells.length > MAX_EDIT_CELLS ||
			cells.some(cell => cell.row >= MAX_ROWS || cell.col >= MAX_COLS) ||
			grownBox(sheet, cells) > MAX_SHEET_CELLS
		) {
			return this.refused("tooLarge")
		}

		const before = new Map<string, CellBefore>()
		const parsedCells = cells.map(cell => ({ ...cell, parsed: parseCellInput(cell.input) }))

		if (parsedCells.some(cell => cell.parsed.type === "formula")) {
			this.hasFormulas = true
		}

		// Built from the workbook as it stands before this edit, so the edit itself is what it recalculates.
		const engine = this.hasFormulas ? this.ensureEngine() : null

		for (const { row, col, parsed } of parsedCells) {
			const cellId = key(row, col)
			const existing = sheet.cells?.get(cellId)

			if (!before.has(cellId)) {
				before.set(cellId, { value: sheet.rows[row]?.[col] ?? null, cell: existing === undefined ? undefined : { ...existing } })
			}

			const base: Partial<Cell> = { ...existing }

			delete base.formula
			delete base.formulaResult
			delete base.formulaType
			delete base.formulaSharedIndex
			delete base.formulaRef
			delete base.formulaDynamic
			delete base.richText

			if (parsed.type === "empty") {
				this.write(
					sheet,
					row,
					col,
					null,
					base.style === undefined && base.comment === undefined && base.hyperlink === undefined
						? undefined
						: { ...base, value: null, type: "empty" }
				)
			} else if (parsed.type === "formula") {
				this.write(sheet, row, col, null, { ...base, value: null, type: "formula", formula: parsed.formula, formulaResult: null })
			} else {
				const cell: Cell = { ...base, value: parsed.value, type: typeOf(parsed.value) }

				if (parsed.impliedFormat !== undefined && (base.style?.numFmt === undefined || base.style.numFmt === "General")) {
					cell.style = { ...base.style, numFmt: parsed.impliedFormat }
				}

				const detailed = cell.style !== undefined || cell.comment !== undefined || cell.hyperlink !== undefined

				this.write(sheet, row, col, parsed.value, detailed ? cell : undefined)
			}
		}

		const recalculated =
			engine === null
				? []
				: this.applyRecalculated(
						engine.set(
							sheetIndex,
							[...before.keys()].map(cellId => {
								const [row, col] = parseKey(cellId)

								return this.engineCell(sheet, row, col)
							})
						)
					)

		return {
			step: { type: "cells", sheet: this.workbook.sheets.indexOf(sheet), before },
			result: () => this.cellsResult(sheetIndex, cells, recalculated)
		}
	}

	private format(
		sheetIndex: number,
		op: { range: { startRow: number; startCol: number; endRow: number; endCol: number }; patch: FormatPatch }
	): { step: Step | null; result: () => EditResult } {
		const sheet = this.worksheets()[sheetIndex]
		const lastRow = Math.min(op.range.endRow, Math.max((sheet?.rows.length ?? 0) - 1, op.range.startRow))
		const lastCol = Math.min(op.range.endCol, Math.max((sheet?.rows[0]?.length ?? 0) - 1, op.range.startCol))
		const count = (lastRow - op.range.startRow + 1) * (lastCol - op.range.startCol + 1)

		if (sheet === undefined || count > MAX_EDIT_CELLS) {
			return this.refused("tooLarge")
		}

		const before = new Map<string, CellBefore>()
		const touched: { row: number; col: number }[] = []

		for (let row = op.range.startRow; row <= lastRow; row++) {
			for (let col = op.range.startCol; col <= lastCol; col++) {
				const cellId = key(row, col)
				const existing = sheet.cells?.get(cellId)
				const value = sheet.rows[row]?.[col] ?? null

				before.set(cellId, { value, cell: existing === undefined ? undefined : { ...existing } })
				this.write(sheet, row, col, value, {
					...(existing ?? { value, type: typeOf(value) }),
					style: patchStyle(existing?.style, op.patch)
				})
				touched.push({ row, col })
			}
		}

		return {
			step: { type: "cells", sheet: this.workbook.sheets.indexOf(sheet), before },
			result: () => this.cellsResult(sheetIndex, touched, [])
		}
	}

	// Moves every formula's references into `target` for an insert or delete there, and every hyperlink
	// pointing into it, remembering the text each had. Runs before the cells move, so the remembered keys
	// are where the cells were.
	private shiftReferences(target: Sheet, edit: AxisEdit): { formulas: TextEdit[]; links: TextEdit[] } {
		const formulas: TextEdit[] = []
		const links: TextEdit[] = []
		const rowsAxis = edit.axis === "rows"

		this.workbook.sheets.forEach((candidate, index) => {
			if (!isWorksheet(candidate)) {
				return
			}

			for (const [cellId, cell] of candidate.cells ?? []) {
				const location = cell.hyperlink?.location

				if (cell.formula === undefined && location === undefined) {
					continue
				}

				if (candidate === target && edit.type === "delete") {
					const [row, col] = parseKey(cellId)
					const position = rowsAxis ? row : col

					// Deleted with its cell.
					if (position >= edit.at && position < edit.at + edit.count) {
						continue
					}
				}

				if (cell.formula !== undefined) {
					const next = shiftFormula(cell.formula, candidate.name, target.name, edit)

					if (next.formula !== cell.formula) {
						formulas.push({ sheet: index, key: cellId, text: cell.formula, cut: next.cut })
						cell.formula = next.formula
					}
				}

				if (cell.hyperlink !== undefined && location !== undefined) {
					const next = shiftFormula(location, candidate.name, target.name, edit).formula

					if (next !== location) {
						links.push({ sheet: index, key: cellId, text: location })
						cell.hyperlink = { ...cell.hyperlink, location: next }
					}
				}
			}
		})

		return { formulas, links }
	}

	private structure(op: Extract<EditOp, { type: "insert" | "delete" }>): { step: Step | null; result: () => EditResult } {
		const sheet = this.worksheets()[op.sheet]

		if (sheet === undefined || structureLocked(sheet) || workbookStructureLocked(this.workbook)) {
			return this.refused("structureLocked")
		}

		const rowsAxis = op.axis === "rows"
		const limit = rowsAxis ? MAX_ROWS : MAX_COLS
		const used = rowsAxis ? sheet.rows.length : (sheet.rows[0]?.length ?? 0)
		const across = rowsAxis ? (sheet.rows[0]?.length ?? 0) : sheet.rows.length

		if (
			op.count <= 0 ||
			op.at < 0 ||
			(op.type === "insert" && (used + op.count > limit || (used + op.count) * across > MAX_SHEET_CELLS))
		) {
			return this.refused("tooLarge")
		}

		const edit: AxisEdit = { type: op.type, axis: op.axis, at: op.at, count: op.count }
		// Built before anything moves, as it moves its own copy.
		const engine = this.hasFormulas ? this.ensureEngine() : null
		const merges = sheet.merges?.map(merge => ({ ...merge }))
		const { formulas, links } = this.shiftReferences(sheet, edit)
		const removed = shiftSheet(sheet, edit)

		if (engine !== null) {
			this.applyRecalculated(
				op.type === "insert" ? engine.insert(op.sheet, op.axis, op.at, op.count) : engine.remove(op.sheet, op.axis, op.at, op.count)
			)
		}

		return {
			step: { type: "structure", sheet: op.sheet, edit, merges, removed, formulas, links },
			result: () => this.sheetsResult()
		}
	}

	private nameRefused(name: string, except: Sheet | undefined): boolean {
		const taken = this.workbook.sheets.some(sheet => sheet !== except && sheet.name.toLowerCase() === name.toLowerCase())

		return !SHEET_NAME.test(name) || name.startsWith("'") || name.endsWith("'") || taken
	}

	private addSheet(requested: string): { step: Step | null; result: () => EditResult } {
		const name = requested.trim()

		if (this.nameRefused(name, undefined)) {
			return this.refused("sheetName")
		}

		const built = this.engine

		this.workbook.sheets.push({ name, rows: [] })
		built?.addSheet(name)

		// Formulas that already named it now reach it: the engine relinks them without reporting what that
		// changed, so their results are read back.
		const results = this.hasFormulas && this.formulasName(name) ? this.syncResults(this.ensureEngine()) : []

		return { step: { type: "addSheet", results }, result: () => this.sheetsResult() }
	}

	private formulasName(sheetName: string): boolean {
		return this.worksheets().some(sheet => {
			for (const cell of sheet.cells?.values() ?? []) {
				if (cell.formula !== undefined && namesSheet(cell.formula, sheetName)) return true
			}

			return false
		})
	}

	// Stores every formula result the engine now gives that differs from the stored one, returning what
	// each held before.
	private syncResults(engine: FormulaEngine): ResultBefore[] {
		const changed: ResultBefore[] = []

		this.worksheets().forEach((sheet, index) => {
			const sheetIndex = this.workbook.sheets.indexOf(sheet)

			for (const [cellId, cell] of sheet.cells ?? []) {
				if (cell.formula === undefined) {
					continue
				}

				const [row, col] = parseKey(cellId)
				const value = engine.value(index, row, col)
				const stored = cell.formulaResult

				if (
					(FormulaEngine.unsupported(value) && hasStoredResult(cell)) ||
					(stored instanceof Date ? typeof value === "number" && dateToSerial(stored, false) === value : stored === value)
				) {
					continue
				}

				changed.push({ sheet: sheetIndex, key: cellId, result: stored, value: sheet.rows[row]?.[col] ?? null })
				this.storeResult(sheet, row, col, cell, value)
			}
		})

		return changed
	}

	private renameSheet(sheetIndex: number, requested: string): { step: Step | null; result: () => EditResult } {
		const name = requested.trim()
		const index = this.workbookIndex(sheetIndex)
		const sheet = this.workbook.sheets[index]

		if (sheet === undefined || this.nameRefused(name, sheet)) {
			return this.refused("sheetName")
		}

		if (renameLocked(this.workbook.sheets)) {
			return this.refused("structureLocked")
		}

		const oldName = sheet.name
		const formulas: TextEdit[] = []
		const links: TextEdit[] = []

		this.workbook.sheets.forEach((candidate, candidateIndex) => {
			for (const [cellId, cell] of candidate.cells ?? []) {
				if (cell.formula !== undefined) {
					const next = renameSheetInFormula(cell.formula, oldName, name)

					if (next !== cell.formula) {
						formulas.push({ sheet: candidateIndex, key: cellId, text: cell.formula })
						cell.formula = next
					}
				}

				const location = cell.hyperlink?.location

				if (cell.hyperlink !== undefined && location !== undefined) {
					const next = renameSheetInFormula(location, oldName, name)

					if (next !== location) {
						links.push({ sheet: candidateIndex, key: cellId, text: location })
						cell.hyperlink = { ...cell.hyperlink, location: next }
					}
				}
			}
		})

		const names = this.workbook.namedRanges

		if (names !== undefined) {
			this.workbook.namedRanges = names.map(named => {
				const next: NamedRange = { ...named, range: renameSheetInFormula(named.range, oldName, name) }

				if (named.scope?.toLowerCase() === oldName.toLowerCase()) {
					next.scope = name
				}

				return next
			})
		}

		sheet.name = name
		this.engine?.renameSheet(sheetIndex, name)

		return { step: { type: "rename", sheet: index, name: oldName, formulas, links, names }, result: () => this.sheetsResult() }
	}

	// The cells an edit touched and those recalculated with it, as one patch per sheet.
	private cellsResult(
		sheetIndex: number,
		touched: readonly { row: number; col: number }[],
		recalculated: readonly RecalculatedCell[]
	): EditResult {
		const worksheets = this.worksheets()
		const bySheet = new Map<number, Map<number, CellView | null>>()
		const add = (index: number, row: number, col: number) => {
			const sheet = worksheets[index]

			if (sheet === undefined) {
				return
			}

			let cells = bySheet.get(index)

			if (cells === undefined) {
				cells = new Map()
				bySheet.set(index, cells)
			}

			cells.set(cellKey(row, col), this.views.cell(sheet, row, col))
		}

		for (const { row, col } of touched) add(sheetIndex, row, col)
		for (const cell of recalculated) add(cell.sheet, cell.row, cell.col)

		const patches: CellPatch[] = []

		for (const [index, cells] of bySheet) {
			const sheet = worksheets[index]

			if (sheet !== undefined) {
				patches.push({ sheet: index, cells: [...cells], ...sheetExtent(sheet) })
			}
		}

		const styles = this.views.styles.styles

		return { type: "cells", patches, styles: styles.length > this.styleMark ? styles : [], state: this.state() }
	}

	private sheetsResult(): EditResult {
		const doc = this.doc()

		return { type: "sheets", sheets: doc.sheets, styles: doc.styles, state: this.state() }
	}
}

function hexColor(css: string): { rgb: string } {
	return { rgb: css.replace("#", "").toUpperCase() }
}

export function patchStyle(style: CellStyle | undefined, patch: FormatPatch): CellStyle {
	const next: CellStyle = { ...style }
	const font = { ...style?.font }
	const alignment = { ...style?.alignment }

	if (patch.bold !== undefined) font.bold = patch.bold
	if (patch.italic !== undefined) font.italic = patch.italic
	if (patch.underline !== undefined) font.underline = patch.underline
	if (patch.strike !== undefined) font.strikethrough = patch.strike

	if (patch.color === null) delete font.color
	else if (patch.color !== undefined) font.color = hexColor(patch.color)

	if (patch.fill === null) delete next.fill
	else if (patch.fill !== undefined) next.fill = { type: "pattern", pattern: "solid", fgColor: hexColor(patch.fill) }

	if (patch.align === null) delete alignment.horizontal
	else if (patch.align !== undefined) alignment.horizontal = patch.align

	if (patch.numFmt === "General") delete next.numFmt
	else if (patch.numFmt !== undefined) next.numFmt = patch.numFmt

	next.font = font
	next.alignment = alignment

	return next
}

// Puts `items` into `array` at `at`, without spreading them into one call (a large run would overflow
// the argument limit).
function insertAll<T>(array: T[], at: number, items: readonly T[]): void {
	const tail = array.splice(at)

	for (const item of items) array.push(item)
	for (const item of tail) array.push(item)
}

// Moves cell details and row formats past `at` by `shift`; for a deletion (a negative shift) those in the
// deleted run are taken out and returned.
function moveDetails(sheet: Sheet, rowsAxis: boolean, at: number, shift: number): { cells: [string, Cell][]; rowDefs: [number, RowDef][] } {
	const removedCells: [string, Cell][] = []
	const removedRowDefs: [number, RowDef][] = []
	const deletedEnd = shift < 0 ? at - shift : at

	if (sheet.cells !== undefined) {
		const cells = new Map<string, Cell>()

		for (const [cellId, cell] of sheet.cells) {
			const [row, col] = parseKey(cellId)
			const index = rowsAxis ? row : col

			if (index < at) {
				cells.set(cellId, cell)
			} else if (index < deletedEnd) {
				removedCells.push([cellId, cell])
			} else {
				cells.set(rowsAxis ? key(index + shift, col) : key(row, index + shift), cell)
			}
		}

		sheet.cells = cells
	}

	if (rowsAxis && sheet.rowDefs !== undefined) {
		const rowDefs = new Map<number, RowDef>()

		for (const [index, def] of sheet.rowDefs) {
			if (index < at) rowDefs.set(index, def)
			else if (index < deletedEnd) removedRowDefs.push([index, def])
			else rowDefs.set(index + shift, def)
		}

		sheet.rowDefs = rowDefs
	}

	return { cells: removedCells, rowDefs: removedRowDefs }
}

// Moves a sheet's cells, merges and row/column formats for an inserted or deleted run of rows or
// columns. A merge the deletion cuts through shrinks; one it swallows goes. A deletion returns what it
// took out, for undoing it.
export function shiftSheet(sheet: Sheet, op: AxisEdit): Removed | null {
	const rowsAxis = op.axis === "rows"
	const removed: Removed = { values: [], cells: [], rowDefs: [], columns: [] }

	if (rowsAxis) {
		const width = sheet.rows[0]?.length ?? 0

		if (op.type === "delete") {
			removed.values = sheet.rows.splice(op.at, op.count)
		} else if (op.at < sheet.rows.length) {
			insertAll(
				sheet.rows,
				op.at,
				Array.from({ length: op.count }, () => new Array<CellValue>(width).fill(null))
			)
		}
	} else {
		for (const values of sheet.rows) {
			if (op.type === "delete") {
				removed.values.push(values.splice(op.at, op.count))
			} else if (op.at < values.length) {
				insertAll(values, op.at, new Array<CellValue>(op.count).fill(null))
			}
		}
	}

	const details = moveDetails(sheet, rowsAxis, op.at, op.type === "insert" ? op.count : -op.count)

	removed.cells = details.cells
	removed.rowDefs = details.rowDefs

	const merges = sheet.merges?.flatMap(merge => {
		const start = rowsAxis ? merge.startRow : merge.startCol
		const end = rowsAxis ? merge.endRow : merge.endCol
		let nextStart: number
		let nextEnd: number

		if (op.type === "insert") {
			nextStart = start >= op.at ? start + op.count : start
			nextEnd = end >= op.at ? end + op.count : end
		} else {
			const removedBefore = (index: number) => Math.max(0, Math.min(index, op.at + op.count) - op.at)

			nextStart = start - removedBefore(start)
			nextEnd = end - removedBefore(end + 1)

			if (nextEnd < nextStart) {
				return []
			}
		}

		const next = rowsAxis ? { ...merge, startRow: nextStart, endRow: nextEnd } : { ...merge, startCol: nextStart, endCol: nextEnd }

		return next.startRow === next.endRow && next.startCol === next.endCol ? [] : [next]
	})

	if (merges !== undefined) {
		sheet.merges = merges
	}

	if (!rowsAxis && sheet.columns !== undefined) {
		if (op.type === "delete") {
			removed.columns = sheet.columns.splice(op.at, op.count)
		} else if (op.at < sheet.columns.length) {
			insertAll(
				sheet.columns,
				op.at,
				Array.from({ length: op.count }, () => ({}))
			)
		}
	}

	return op.type === "delete" ? removed : null
}

// Undoes a deletion: moves what followed back out and puts back what it took. Merges are restored by
// the caller.
function restoreDeleted(sheet: Sheet, op: AxisEdit, removed: Removed): void {
	const rowsAxis = op.axis === "rows"

	if (rowsAxis) {
		insertAll(sheet.rows, op.at, removed.values)
	} else {
		sheet.rows.forEach((values, row) => {
			insertAll(values, op.at, removed.values[row] ?? [])
		})
	}

	moveDetails(sheet, rowsAxis, op.at, op.count)

	if (removed.cells.length > 0) {
		sheet.cells ??= new Map()

		for (const [cellId, cell] of removed.cells) sheet.cells.set(cellId, cell)
	}

	if (removed.rowDefs.length > 0) {
		sheet.rowDefs ??= new Map()

		for (const [index, def] of removed.rowDefs) sheet.rowDefs.set(index, def)
	}

	if (!rowsAxis && removed.columns.length > 0 && sheet.columns !== undefined) {
		insertAll(sheet.columns, op.at, removed.columns)
	}
}
