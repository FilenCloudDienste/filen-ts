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
import { openXlsx, parseRange, saveXlsx, writeXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { RawCellContent } from "hyperformula"
import { parseCellInput, type ParsedInput } from "@/features/spreadsheet/lib/cellInput.logic"
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
	CYCLE,
	FormulaEngine,
	UNPARSEABLE,
	type EngineCell,
	type EngineName,
	type EngineSheet,
	type RecalculatedCell
} from "@/features/spreadsheet/lib/formulaEngine"
import {
	engineCellFormula,
	engineFormula,
	formulaTranslator,
	namesSheet,
	renameSheetInFormula,
	shiftFormula,
	storedFormula,
	type AxisEdit
} from "@/features/spreadsheet/lib/formulaRefs"
import { cellKey, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import {
	hasArrayFormulas,
	isWorksheet,
	sheetExtent,
	structureLocked,
	workbookDoc,
	workbookStructureLocked,
	WorkbookViews
} from "@/features/spreadsheet/lib/xlsxView"
import {
	clampSize,
	colWidthToPx,
	MAX_RESIZE_TARGETS,
	pxToColWidth,
	pxToRowHeight,
	rowHeightToPx,
	type SizeAxis,
	type SizeEntry
} from "@/features/spreadsheet/lib/sizes.logic"
import { pause, saveLosses } from "@/features/spreadsheet/lib/xlsxVerify"
import { rawEntries, xlsxSavePlan, type SavePlan } from "@/features/spreadsheet/lib/xlsxWritable"
import { readZip } from "@/features/spreadsheet/lib/zipLimits"

// Excel's own limits.
const HISTORY_LIMIT = 100
const SHEET_NAME = /^[^\\/?*[\]:]{1,31}$/
// Undo keeps what each step replaced; past this many cells in all, the oldest steps go.
const HISTORY_CELLS = MAX_SHEET_CELLS
const THEME_PART = "xl/theme/theme1.xml"
// The most file bytes (inflated) proven by an unedited save; a larger workbook opens view-only.
const VERIFY_LIMIT = 192 * 1024 * 1024
// Parts saveXlsx writes anew from the model and never reads: dropped once the workbook is proven. Sheet
// relationships stay (it reads them for the parts it re-attaches), and so does every drawing it keeps.
const REGENERATED =
	/^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/_rels\/workbook\.xml\.rels|xl\/workbook\.xml|xl\/styles\.xml|xl\/sharedStrings\.xml|xl\/calcChain\.xml|docProps\/(app|core)\.xml|xl\/worksheets\/sheet\d+\.xml|xl\/comments[^/]*\.xml|xl\/comments\/.*|xl\/tables\/.*|xl\/drawings\/vmlDrawing\d+\.vml)$/i
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

// The format a cell starts from where the file has none, as Excel gives it: its row's (a row formatted as a
// whole), else its column's. A cell the file holds keeps its own, even the default.
function startingStyle(sheet: Sheet, row: number, col: number, existing: Cell | undefined): CellStyle | undefined {
	if (existing !== undefined) return existing.style
	if ((sheet.rows[row]?.[col] ?? null) !== null) return undefined

	return sheet.rowDefs?.get(row)?.style ?? sheet.columns?.[col]?.style
}

// What is typed into a cell, read as Excel reads it there: into a Text ("@") cell, as text, a formula too.
function parseTyped(input: string, style: CellStyle | undefined): ParsedInput {
	return style?.numFmt === "@" && input !== "" && !input.startsWith("'") ? { type: "value", value: input } : parseCellInput(input)
}

// A format with the quote prefix (typed with a leading apostrophe) set or cleared.
function quoted(style: CellStyle | undefined, prefixed: boolean): CellStyle | undefined {
	if (prefixed === (style?.quotePrefix === true)) return style

	const next: CellStyle = { ...style }

	if (prefixed) next.quotePrefix = true
	else delete next.quotePrefix

	return next
}

// A value as the engine reads it: text stays text whatever it looks like ('007, '=1+1, 'TRUE), and a date
// is its serial number in the workbook's date system, never a Date the engine would read in the viewer's
// timezone.
function engineValue(value: CellValue, date1904: boolean): RawCellContent {
	if (typeof value === "string") return `'${value}`
	if (value instanceof Date) return dateToSerial(value, date1904)

	return value
}

// What a formula cell stored for its result, as the engine takes it in place of a formula it cannot read.
function storedResult(cell: Cell, date1904: boolean): RawCellContent | undefined {
	const result = cell.formulaResult

	if (result === undefined || result === null) return undefined
	if (typeof result === "string" && ERROR_VALUE.test(result)) return result

	return engineValue(result, date1904)
}

// A formula as the engine gets it, with its stored result to fall back on; one the engine cannot be given
// (nested too deep, building too large an array) holds its stored result.
function formulaCell(row: number, col: number, formula: string, cell: Cell, date1904: boolean): EngineCell {
	const fallback = storedResult(cell, date1904)

	// An array formula (legacy or spilling) keeps the result the file stored: the engine calculates ordinary
	// formulas only, as Excel reads them.
	if (cell.formulaType === "array" && fallback !== undefined) {
		return { row, col, content: fallback }
	}

	const content = engineCellFormula(formula)

	if (content === null) {
		return { row, col, content: fallback ?? UNPARSEABLE }
	}

	return fallback === undefined ? { row, col, content } : { row, col, content, fallback }
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

interface CellAt {
	sheet: number
	key: string
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
	// `extent`: the sheet's value rectangle before the edit, which writing past its edge grows.
	| { type: "cells"; sheet: number; before: Map<string, CellBefore>; extent: { rows: number; cols: number } }
	| {
			type: "structure"
			sheet: number
			edit: AxisEdit
			merges: MergeRange[] | undefined
			// The manual page breaks across the edited axis.
			breaks: number[] | undefined
			// What a deletion took out, or the row and column formats an insertion pushed off the sheet.
			removed: Removed
			formulas: TextEdit[]
			links: TextEdit[]
	  }
	| { type: "addSheet"; results: ResultBefore[] }
	// Each resized index's size before the edit, in the file's units (undefined: none of its own).
	| { type: "sizes"; sheet: number; axis: SizeAxis; before: [number, number | undefined][] }
	| {
			type: "rename"
			sheet: number
			name: string
			formulas: TextEdit[]
			links: TextEdit[]
			names: NamedRange[] | undefined
			// Formulas that named the new name before the sheet took it, and the results that changed.
			placeholders: CellAt[]
			results: ResultBefore[]
	  }

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
				step.removed.cells.length +
				step.removed.values.reduce((count, values) => count + values.length, 0)
			)
		case "addSheet":
			return 1 + step.results.length
		case "sizes":
			return step.before.length
		case "rename":
			return 1 + step.formulas.length + step.links.length + (step.names?.length ?? 0) + step.placeholders.length + step.results.length
	}
}

// An open .xlsx: the workbook as read (every part the grid does not model rides along untouched and is
// written back as it was), its view for the grid, the formula engine once something needs it, and an undo
// history. Worker-side only.
export class XlsxDocument {
	private readonly workbook: RoundtripWorkbook
	// Serial dates count from 1904 (older Mac files), which the engine and its cached results follow.
	private readonly date1904: boolean
	private readonly views: WorkbookViews
	private readonly savePlan: SavePlan
	// Settled by verifyWritable: until then, and after it finds a loss, the workbook is view-only.
	private proven = false
	private verification: Promise<boolean> | null = null
	// What the check found saving would lose (for diagnosis).
	losses: string[] = []
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
	private prepared = false
	private closed = false

	constructor(workbook: RoundtripWorkbook, historyBudget = HISTORY_CELLS) {
		this.workbook = workbook
		this.date1904 = workbook.dateSystem === "1904"
		this.historyBudget = historyBudget
		this.views = new WorkbookViews(workbook.themeColors)
		this.savePlan = xlsxSavePlan(workbook)

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
			const rows = sheet.rows.map(values => values.map(value => engineValue(value, this.date1904)))
			const formulas: EngineCell[] = []

			for (const [cellId, cell] of sheet.cells ?? []) {
				const [row, col] = parseKey(cellId)
				const values = rows[row]

				if (values === undefined) {
					continue
				}

				if (cell.formula !== undefined) {
					const engineCell = formulaCell(row, col, cell.formula, cell, this.date1904)

					values[col] = engineCell.content
					formulas.push(engineCell)
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

		return new FormulaEngine(sheets, names, this.date1904)
	}

	private engineCell(sheet: Sheet, row: number, col: number): EngineCell {
		const cell = sheet.cells?.get(key(row, col))
		const value = sheet.rows[row]?.[col] ?? null

		if (cell?.formula !== undefined) {
			return formulaCell(row, col, cell.formula, cell, this.date1904)
		}

		return { row, col, content: cell?.type === "error" ? value : engineValue(value, this.date1904) }
	}

	// A formula's result stored in its cell: a number shown as a date is kept as the date it is.
	private storeResult(sheet: Sheet, row: number, col: number, cell: Cell, value: RecalculatedCell["value"]): void {
		const numFmt = cell.style?.numFmt
		// A circular reference with no result to keep shows 0, as in Excel.
		const result =
			value === CYCLE
				? 0
				: typeof value === "number" && numFmt !== undefined && isDateFormat(numFmt)
					? serialToDate(value, this.date1904)
					: value
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

	// Runs engine work and stores what it recalculated. Should the engine fail part-way (it throws, for one,
	// when a spill would land on occupied cells), the workbook is still right: the engine is built again
	// from it and every result read back.
	private recalculate(work: (engine: FormulaEngine) => RecalculatedCell[]): RecalculatedCell[] {
		const engine = this.engine

		if (engine === null) {
			return []
		}

		try {
			return this.applyRecalculated(work(engine))
		} catch {
			this.dropEngine()

			try {
				const worksheets = this.worksheets()

				return this.syncResults(this.ensureEngine()).map(before => {
					const sheet = this.workbook.sheets[before.sheet]
					const [row, col] = parseKey(before.key)
					const value = sheet?.rows[row]?.[col] ?? null

					return {
						sheet: sheet === undefined ? -1 : worksheets.indexOf(sheet),
						row,
						col,
						value: value instanceof Date ? dateToSerial(value, this.date1904) : value
					}
				})
			} catch {
				// Built again when next needed.
				this.dropEngine()

				return []
			}
		}
	}

	private dropEngine(): void {
		this.engine?.destroy()
		this.engine = null
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

		const last = this.undoSteps.at(-1)

		if (last === undefined) {
			return { type: "none", state: this.state() }
		}

		// The history moves only once the step is reverted.
		const result = this.revert(last.step)

		this.undoSteps.pop()
		this.historyCells -= last.cells
		this.redoSteps.push({ op: last.op, after: last.after })
		this.current = last.before

		return { ...result, state: this.state() }
	}

	redo(): EditResult {
		this.styleMark = this.views.styles.styles.length

		const redone = this.redoSteps.at(-1)

		if (redone === undefined) {
			return { type: "none", state: this.state() }
		}

		const result = this.run(redone.op)

		if (result.step !== null) {
			this.redoSteps.pop()
			this.pushStep({ step: result.step, op: redone.op, before: this.current, after: redone.after, cells: stepCells(result.step) })
			this.current = redone.after
		}

		return result.result()
	}

	// Whether saving can write the file back intact: the structural checks (xlsxWritable.ts) first, then
	// proof, an unedited save compared with the file part by part (xlsxVerify.ts). View-only until proven.
	get writable(): boolean {
		return this.proven
	}

	// For a page that will not edit: settles the workbook as view-only without proving it, and lets go of
	// the parts only a save would need.
	viewOnly(): void {
		if (this.verification !== null) {
			return
		}

		this.verification = Promise.resolve(false)
		this.proven = false
		this.releaseRaw(rawEntries(this.workbook))
	}

	// Proves (once) whether saving loses anything. Must run before any edit: an edit made first would read
	// as a loss, so a workbook edited first stays view-only.
	verifyWritable(): Promise<boolean> {
		this.verification ??= this.verify()

		return this.verification
	}

	private async verify(): Promise<boolean> {
		const raw = rawEntries(this.workbook)
		const closed = () => this.closed
		let proven = false

		// Yields first, so a close already on its way is seen before any work.
		await pause()

		if (raw !== null && this.savePlan.writable && this.untouched() && !closed()) {
			let size = 0

			for (const bytes of raw.values()) size += bytes.length

			// Too large to prove without holding the file twice over: view-only.
			if (size <= VERIFY_LIMIT) {
				const original = new Map(raw)

				await this.prepareSave()

				// Closed meanwhile: every buffer below is dropped unused.
				const saved = closed() ? null : await this.unzippedSave(raw, closed)

				const losses =
					saved === null || closed()
						? null
						: await saveLosses(
								{ original, saved, sheetPaths: this.savePlan.sheets, dropped: this.savePlan.drop, release: true },
								closed
							)

				if (losses !== null && !closed()) {
					this.losses = losses
					// An edit that came in while it saved would be read as the file.
					proven = losses.length === 0 && this.untouched()
				}
			}
		}

		this.proven = proven
		this.releaseRaw(raw)

		return proven
	}

	// The workbook saved as it stands, unzipped. Saving has read what it needs of the file's parts by the
	// time it returns: the ones it writes anew go then (the comparison holds its own references, which it
	// lets go sheet by sheet), and the zip goes once unzipped.
	private async unzippedSave(raw: Map<string, Uint8Array>, closed: () => boolean): Promise<Map<string, Uint8Array> | null> {
		const bytes = await saveXlsx(this.workbook)

		for (const path of [...raw.keys()]) {
			if (REGENERATED.test(path)) raw.delete(path)
		}

		return closed() ? null : await readZip(bytes, closed)
	}

	private untouched(): boolean {
		return this.current === 0 && this.undoSteps.length === 0
	}

	// Keeps of the file's parts only what saving copies as it was: saving writes the rest anew, and a
	// view-only workbook saves nothing.
	private releaseRaw(raw: Map<string, Uint8Array> | null): void {
		if (raw === null) {
			return
		}

		if (!this.proven || this.closed) {
			raw.clear()

			return
		}

		for (const path of [...raw.keys()]) {
			if (REGENERATED.test(path)) raw.delete(path)
		}
	}

	// The file's bytes as edited, and the state they hold.
	async serialize(): Promise<{ bytes: Uint8Array; version: number }> {
		if (!(await this.verifyWritable())) {
			throw new Error("spreadsheet: this workbook cannot be saved")
		}

		const version = this.current

		if (!this.prepared) {
			await this.prepareSave()
		}

		return { bytes: await saveXlsx(this.workbook), version }
	}

	// Parts saveXlsx would leave orphaned are dropped, and a workbook without a theme gets the default one
	// it points every workbook at (taken from a workbook hucre writes itself).
	private async prepareSave(): Promise<void> {
		const raw = rawEntries(this.workbook)

		if (raw === null) {
			throw new Error("spreadsheet: this workbook cannot be saved")
		}

		for (const path of this.savePlan.drop) {
			raw.delete(path)
		}

		if (this.savePlan.addTheme && !raw.has(THEME_PART)) {
			const theme = rawEntries(await openXlsx(await writeXlsx({ sheets: [{ name: "Sheet1", rows: [] }] })))?.get(THEME_PART)

			if (theme === undefined) {
				throw new Error("spreadsheet: no theme to add")
			}

			raw.set(THEME_PART, theme)
		}

		this.prepared = true
	}

	// The state `version` names is now the file's: the document is clean exactly while it is back there.
	markSaved(version: number): DocState {
		this.saved = version

		return this.state()
	}

	// Stops a proof still running (it resolves false) and lets go of the engine and the file's parts.
	close(): void {
		this.closed = true
		this.proven = false
		this.engine?.destroy()
		this.engine = null
		rawEntries(this.workbook)?.clear()
	}

	private revert(step: Step): EditResult {
		switch (step.type) {
			case "sizes":
				return this.revertSizes(step)
			case "cells":
				return this.revertCells(step)
			case "structure":
				return this.revertStructure(step)
			case "addSheet": {
				this.workbook.sheets.pop()
				this.recalculate(engine => {
					engine.removeLastSheet()

					return []
				})
				// The engine's copies are what they were before the sheet came too (references to a missing
				// sheet).
				this.restoreResults(step.results)

				return this.sheetsResult(this.gridSheets(step.results))
			}
			case "rename": {
				const sheet = this.workbook.sheets[step.sheet]

				if (sheet !== undefined) {
					sheet.name = step.name
					this.recalculate(engine => {
						engine.renameSheet(this.worksheets().indexOf(sheet), step.name)

						return []
					})
				}

				this.restoreText(step.formulas, (cell, text) => {
					cell.formula = text
				})
				this.restoreText(step.links, (cell, text) => {
					if (cell.hyperlink !== undefined) cell.hyperlink = { ...cell.hyperlink, location: text }
				})

				if (step.names === undefined) delete this.workbook.namedRanges
				else this.workbook.namedRanges = step.names

				// Formulas that named the new name name a missing sheet again: the engine reads them anew.
				this.recalculate(engine => {
					this.resetFormulas(engine, step.placeholders)

					return []
				})

				this.restoreResults(step.results)

				const changed = this.gridSheets([...step.formulas, ...step.links, ...step.results])

				if (sheet !== undefined) changed.add(this.worksheets().indexOf(sheet))

				return this.sheetsResult(changed)
			}
		}
	}

	private restoreResults(results: readonly ResultBefore[]): void {
		for (const before of results) {
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
	}

	// Grid indices of the sheets these workbook-indexed cells are on.
	private gridSheets(cells: readonly { sheet: number }[]): Set<number> {
		const worksheets = this.worksheets()
		const found = new Set<number>()

		for (const cell of cells) {
			const sheet = this.workbook.sheets[cell.sheet]
			const index = sheet === undefined ? -1 : worksheets.indexOf(sheet)

			if (index >= 0) found.add(index)
		}

		return found
	}

	// Gives the engine these formula cells again, read from their current text.
	private resetFormulas(engine: FormulaEngine, cells: readonly CellAt[]): void {
		const worksheets = this.worksheets()
		const bySheet = new Map<number, EngineCell[]>()

		for (const at of cells) {
			const sheet = this.workbook.sheets[at.sheet]
			const index = sheet === undefined ? -1 : worksheets.indexOf(sheet)

			if (sheet === undefined || index < 0) {
				continue
			}

			const [row, col] = parseKey(at.key)
			const list = bySheet.get(index) ?? []

			list.push(this.engineCell(sheet, row, col))
			bySheet.set(index, list)
		}

		for (const [index, list] of bySheet) {
			engine.set(index, list)
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
		if (this.hasFormulas) {
			this.ensureEngine()
		}

		for (const [cellId, before] of step.before) {
			const [row, col] = parseKey(cellId)

			this.write(sheet, row, col, before.value, before.cell)
			touched.push({ row, col })
		}

		// Writing past the sheet's edge grew it; it shrinks back.
		if (sheet.rows.length > step.extent.rows) {
			sheet.rows.length = step.extent.rows
		}

		if ((sheet.rows[0]?.length ?? 0) > step.extent.cols) {
			for (const values of sheet.rows) values.length = step.extent.cols
		}

		const recalculated = this.recalculate(engine =>
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
			return this.sheetsResult(new Set())
		}

		const { edit } = step

		if (this.hasFormulas) {
			this.ensureEngine()
		}

		const changed = this.gridSheets([...step.formulas, ...step.links]).add(step.sheet)

		if (edit.type === "insert") {
			shiftSheet(sheet, { ...edit, type: "delete" })
			restorePushedOff(sheet, step.removed)
		} else {
			restoreDeleted(sheet, edit, step.removed)
		}

		if (step.merges === undefined) delete sheet.merges
		else sheet.merges = step.merges

		// Breaks the sheet had none of, shifting made none of either.
		if (step.breaks !== undefined) sheet[BREAKS[edit.axis]] = step.breaks

		this.restoreText(step.formulas, (cell, text) => {
			cell.formula = text
		})
		this.restoreText(step.links, (cell, text) => {
			if (cell.hyperlink !== undefined) cell.hyperlink = { ...cell.hyperlink, location: text }
		})

		const recalculated = this.recalculate(engine => {
			if (edit.type === "insert") {
				return engine.remove(step.sheet, edit.axis, edit.at, edit.count)
			}

			let recalculatedCells = engine.insert(step.sheet, edit.axis, edit.at, edit.count)

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

			step.removed.values.forEach((values, index) => {
				values.forEach((value, offset) => {
					if (value !== null) {
						add(step.sheet, edit.axis === "rows" ? edit.at + index : index, edit.axis === "rows" ? offset : edit.at + offset)
					}
				})
			})

			for (const [cellId] of step.removed.cells) {
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
				recalculatedCells = recalculatedCells.concat(engine.set(gridIndex, [...targetCells.values()]))
			}

			return recalculatedCells
		})

		for (const cell of recalculated) changed.add(cell.sheet)

		return this.sheetsResult(changed)
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
			case "resize":
				return this.resize(op)
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

	private refused(reason: Extract<EditResult, { type: "refused" }>["reason"]): { step: null; result: () => EditResult } {
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

		const parsedCells = cells.map(cell => ({
			...cell,
			parsed: parseTyped(cell.input, startingStyle(sheet, cell.row, cell.col, sheet.cells?.get(key(cell.row, cell.col))))
		}))

		if (splitsArray(sheet, cells)) {
			return this.refused("arrayFormula")
		}

		if (renamesTableColumn(sheet, parsedCells)) {
			return this.refused("tableHeader")
		}

		const before = new Map<string, CellBefore>()

		if (parsedCells.some(cell => cell.parsed.type === "formula")) {
			this.hasFormulas = true
		}

		// Built from the workbook as it stands before this edit, so the edit itself is what it recalculates.
		if (this.hasFormulas) {
			this.ensureEngine()
		}

		const extent = { rows: sheet.rows.length, cols: sheet.rows[0]?.length ?? 0 }

		for (const { row, col, input, parsed } of parsedCells) {
			const cellId = key(row, col)
			const existing = sheet.cells?.get(cellId)

			if (!before.has(cellId)) {
				before.set(cellId, { value: sheet.rows[row]?.[col] ?? null, cell: existing === undefined ? undefined : { ...existing } })
			}

			const base: Partial<Cell> = { ...existing }
			// A plain entry clears the quote prefix; one typed with a leading apostrophe sets it.
			const style =
				parsed.type === "empty" ? existing?.style : quoted(startingStyle(sheet, row, col, existing), input.startsWith("'"))

			if (style !== undefined) base.style = style

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
				this.write(sheet, row, col, null, {
					...base,
					value: null,
					type: "formula",
					formula: storedFormula(parsed.formula),
					formulaResult: null
				})
			} else {
				const cell: Cell = { ...base, value: parsed.value, type: typeOf(parsed.value) }

				if (parsed.impliedFormat !== undefined && (base.style?.numFmt === undefined || base.style.numFmt === "General")) {
					cell.style = { ...base.style, numFmt: parsed.impliedFormat }
				}

				const detailed = cell.style !== undefined || cell.comment !== undefined || cell.hyperlink !== undefined

				this.write(sheet, row, col, parsed.value, detailed ? cell : undefined)
			}
		}

		const recalculated = this.recalculate(engine =>
			engine.set(
				sheetIndex,
				[...before.keys()].map(cellId => {
					const [row, col] = parseKey(cellId)

					return this.engineCell(sheet, row, col)
				})
			)
		)

		return {
			step: { type: "cells", sheet: this.workbook.sheets.indexOf(sheet), before, extent },
			result: () => this.cellsResult(sheetIndex, cells, recalculated)
		}
	}

	private resize(op: Extract<EditOp, { type: "resize" }>): { step: Step | null; result: () => EditResult } {
		const sheet = this.workbook.sheets[this.workbookIndex(op.sheet)]

		if (sheet === undefined || op.sizes.length === 0) {
			return { step: null, result: () => ({ type: "none", state: this.state() }) }
		}

		if (op.sizes.length > MAX_RESIZE_TARGETS) {
			return { step: null, result: () => ({ type: "refused", reason: "tooLarge", state: this.state() }) }
		}

		const before = op.sizes.map(([at]): [number, number | undefined] => [at, fileSize(sheet, op.axis, at)])

		for (const [at, px] of op.sizes) {
			setFileSize(
				sheet,
				op.axis,
				at,
				px === null ? undefined : op.axis === "cols" ? pxToColWidth(clampSize("cols", px)) : pxToRowHeight(clampSize("rows", px))
			)
		}

		return {
			step: { type: "sizes", sheet: this.workbook.sheets.indexOf(sheet), axis: op.axis, before },
			result: () =>
				this.sizesResult(
					op.sheet,
					sheet,
					op.axis,
					op.sizes.map(([at]) => at)
				)
		}
	}

	private revertSizes(step: Extract<Step, { type: "sizes" }>): EditResult {
		const sheet = this.workbook.sheets[step.sheet]

		if (sheet === undefined) {
			return { type: "none", state: this.state() }
		}

		for (const [at, size] of step.before) {
			setFileSize(sheet, step.axis, at, size)
		}

		return this.sizesResult(
			this.worksheets().indexOf(sheet),
			sheet,
			step.axis,
			step.before.map(([at]) => at)
		)
	}

	private sizesResult(gridSheet: number, sheet: Sheet, axis: SizeAxis, indices: readonly number[]): EditResult {
		return {
			type: "sizes",
			sheet: gridSheet,
			axis,
			sizes: indices.map((at): SizeEntry => {
				const size = fileSize(sheet, axis, at)

				return [at, size === undefined ? null : axis === "cols" ? colWidthToPx(size) : rowHeightToPx(size)]
			}),
			state: this.state()
		}
	}

	private format(
		sheetIndex: number,
		op: { range: { startRow: number; startCol: number; endRow: number; endCol: number }; patch: FormatPatch }
	): { step: Step | null; result: () => EditResult } {
		const sheet = this.worksheets()[sheetIndex]

		if (sheet === undefined) {
			return this.refused("tooLarge")
		}

		const { startRow, startCol } = op.range
		const within = (lastRow: number, lastCol: number) =>
			(lastRow - startRow + 1) * (lastCol - startCol + 1) <= MAX_EDIT_CELLS &&
			grownBox(sheet, [{ row: lastRow, col: lastCol }]) <= MAX_SHEET_CELLS
		let lastRow = op.range.endRow
		let lastCol = op.range.endCol

		// The whole range where the limits allow; a larger one (whole rows or columns) as far as the sheet
		// is used.
		if (!within(lastRow, lastCol)) {
			lastRow = Math.min(lastRow, Math.max(sheet.rows.length - 1, startRow))
			lastCol = Math.min(lastCol, Math.max((sheet.rows[0]?.length ?? 0) - 1, startCol))

			if (!within(lastRow, lastCol)) {
				return this.refused("tooLarge")
			}
		}

		const extent = { rows: sheet.rows.length, cols: sheet.rows[0]?.length ?? 0 }
		const before = new Map<string, CellBefore>()
		const touched: { row: number; col: number }[] = []

		for (let row = startRow; row <= lastRow; row++) {
			for (let col = startCol; col <= lastCol; col++) {
				const cellId = key(row, col)
				const existing = sheet.cells?.get(cellId)
				const value = sheet.rows[row]?.[col] ?? null

				before.set(cellId, { value, cell: existing === undefined ? undefined : { ...existing } })
				this.write(sheet, row, col, value, {
					...(existing ?? { value, type: typeOf(value) }),
					style: patchStyle(startingStyle(sheet, row, col, existing), op.patch)
				})
				touched.push({ row, col })
			}
		}

		return {
			step: { type: "cells", sheet: this.workbook.sheets.indexOf(sheet), before, extent },
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
		const extent = sheetExtent(sheet)
		const used = rowsAxis ? extent.rowCount : extent.colCount
		const across = rowsAxis ? (sheet.rows[0]?.length ?? 0) : sheet.rows.length

		if (
			op.count <= 0 ||
			op.at < 0 ||
			(op.type === "insert" && (used + op.count > limit || (used + op.count) * across > MAX_SHEET_CELLS))
		) {
			return this.refused("tooLarge")
		}

		const edit: AxisEdit = { type: op.type, axis: op.axis, at: op.at, count: op.count }
		// Built before anything moves, as it moves its own copy; asked first whether it can move it (a spilled
		// array on the way cannot be moved), so nothing changes when it cannot.
		const engine = this.hasFormulas ? this.ensureEngine() : null

		if (engine !== null && !engine.canMove(op.sheet, edit)) {
			return this.refused("structureLocked")
		}
		const merges = sheet.merges?.map(merge => ({ ...merge }))
		// shiftSheet replaces the list, never changes it.
		const breaks = sheet[BREAKS[edit.axis]]
		const { formulas, links } = this.shiftReferences(sheet, edit)
		const removed = shiftSheet(sheet, edit)

		const changed = this.gridSheets([...formulas, ...links]).add(op.sheet)

		const recalculated = this.recalculate(current =>
			op.type === "insert" ? current.insert(op.sheet, op.axis, op.at, op.count) : current.remove(op.sheet, op.axis, op.at, op.count)
		)

		for (const cell of recalculated) changed.add(cell.sheet)

		return {
			step: { type: "structure", sheet: op.sheet, edit, merges, breaks, removed, formulas, links },
			result: () => this.sheetsResult(changed)
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

		this.workbook.sheets.push({ name, rows: [] })
		this.recalculate(engine => {
			engine.addSheet(name)

			return []
		})

		// Formulas that already named it now reach it: the engine relinks them without reporting what that
		// changed, so their results are read back.
		const results = this.hasFormulas && this.formulasName(name) ? this.syncResults(this.ensureEngine()) : []

		const changed = this.gridSheets(results).add(this.worksheets().length - 1)

		return { step: { type: "addSheet", results }, result: () => this.sheetsResult(changed) }
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
					(stored instanceof Date ? typeof value === "number" && dateToSerial(stored, this.date1904) === value : stored === value)
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
		const placeholders: CellAt[] = []

		this.workbook.sheets.forEach((candidate, candidateIndex) => {
			for (const [cellId, cell] of candidate.cells ?? []) {
				if (cell.formula !== undefined) {
					// Named a sheet that did not exist, which this one now is.
					if (namesSheet(cell.formula, name)) {
						placeholders.push({ sheet: candidateIndex, key: cellId })
					}

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
		this.recalculate(engine => {
			engine.renameSheet(sheetIndex, name)

			return []
		})

		// The engine reads formulas that named the new name afresh; what that changes is read back, as for
		// an added sheet.
		let results: ResultBefore[] = []

		if (this.hasFormulas && placeholders.length > 0) {
			this.ensureEngine()
			this.recalculate(engine => {
				this.resetFormulas(engine, placeholders)

				return []
			})
			results = this.engine === null ? [] : this.syncResults(this.engine)
		}

		const changed = this.gridSheets([...formulas, ...links, ...results]).add(sheetIndex)

		return {
			step: { type: "rename", sheet: index, name: oldName, formulas, links, names, placeholders, results },
			result: () => this.sheetsResult(changed)
		}
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

	// A view of each sheet in `changed` (grid indices), null for the rest.
	private sheetsResult(changed: ReadonlySet<number>): EditResult {
		const lockStructure = workbookStructureLocked(this.workbook)
		const sheets = this.worksheets().map((sheet, index) => (changed.has(index) ? this.views.sheet(sheet, lockStructure) : null))

		return { type: "sheets", sheets, styles: this.views.styles.styles, state: this.state() }
	}
}

// A column's width in characters or a row's height in points, as the file holds it.
function fileSize(sheet: Sheet, axis: SizeAxis, at: number): number | undefined {
	return axis === "cols" ? sheet.columns?.[at]?.width : sheet.rowDefs?.get(at)?.height
}

// Sets or clears one size, keeping everything else the column or row carries (style, hidden, outline).
function setFileSize(sheet: Sheet, axis: SizeAxis, at: number, size: number | undefined): void {
	if (axis === "cols") {
		const columns = (sheet.columns ??= [])

		while (columns.length <= at) {
			columns.push({})
		}

		const column = { ...columns[at] }

		if (size === undefined) delete column.width
		else column.width = size

		columns[at] = column

		return
	}

	const rowDefs = (sheet.rowDefs ??= new Map())
	const def = { ...rowDefs.get(at) }

	if (size === undefined) delete def.height
	else def.height = size

	if (Object.keys(def).length === 0) rowDefs.delete(at)
	else rowDefs.set(at, def)
}

function hexColor(css: string): { rgb: string } {
	return { rgb: css.replace("#", "").toUpperCase() }
}

export function patchStyle(style: CellStyle | undefined, patch: FormatPatch): CellStyle {
	const next: CellStyle = { ...style }
	const font = { ...style?.font }
	const alignment = { ...style?.alignment }

	// A cell's font is whole: off is absent (a written false would read as an override).
	if (patch.bold === true) font.bold = true
	else if (patch.bold === false) delete font.bold
	if (patch.italic === true) font.italic = true
	else if (patch.italic === false) delete font.italic
	if (patch.underline === true) font.underline = true
	else if (patch.underline === false) delete font.underline
	if (patch.strike === true) font.strikethrough = true
	else if (patch.strike === false) delete font.strikethrough

	if (patch.color === null) delete font.color
	else if (patch.color !== undefined) font.color = hexColor(patch.color)

	if (patch.fill === null) delete next.fill
	else if (patch.fill !== undefined) next.fill = { type: "pattern", pattern: "solid", fgColor: hexColor(patch.fill) }

	if (patch.align === null) delete alignment.horizontal
	else if (patch.align !== undefined) alignment.horizontal = patch.align

	// The number the file gave the old format goes with it.
	if (patch.numFmt !== undefined) delete next.numFmtId
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

// Moves cell details and row formats past `at` by `shift`. A deletion (a negative shift) takes out and
// returns those in the deleted run, an insertion the row formats it pushes off the sheet.
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
			else if (index < deletedEnd || index + shift >= MAX_ROWS) removedRowDefs.push([index, def])
			else rowDefs.set(index + shift, def)
		}

		sheet.rowDefs = rowDefs
	}

	return { cells: removedCells, rowDefs: removedRowDefs }
}

// Where a sheet keeps its manual page breaks along each axis, as the last row (column) before each.
const BREAKS = { rows: "rowBreaks", cols: "colBreaks" } as const

// Moves a sheet's cells, merges, page breaks and row/column formats for an inserted or deleted run of rows
// or columns. A merge the deletion cuts through shrinks; one it swallows goes. Returns what a deletion took
// out, or the row and column formats an insertion pushed past the sheet's edge, for undoing it.
export function shiftSheet(sheet: Sheet, op: AxisEdit): Removed {
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
			const limit = rowsAxis ? MAX_ROWS : MAX_COLS

			nextStart = start >= op.at ? start + op.count : start
			nextEnd = Math.min(end >= op.at ? end + op.count : end, limit - 1)

			if (nextStart >= limit) {
				return []
			}
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

	// A manual page break is the edge above the row (left of the column) that starts a page, and moves with
	// that row; it goes with it when deleted.
	const breaks = sheet[BREAKS[op.axis]]

	if (breaks !== undefined) {
		const limit = rowsAxis ? MAX_ROWS : MAX_COLS

		sheet[BREAKS[op.axis]] = breaks.flatMap(last => {
			const start = last + 1

			if (op.type === "insert") return start < op.at ? [last] : start + op.count < limit ? [last + op.count] : []
			if (start < op.at) return [last]

			return start >= op.at + op.count && start - op.count > 0 ? [last - op.count] : []
		})
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

			// Formats running to the last column (as hiding every column to the right writes them) stop at
			// the sheet's edge.
			if (sheet.columns.length > MAX_COLS) {
				removed.columns = sheet.columns.splice(MAX_COLS)
			}
		}
	}

	return removed
}

// Puts back the row and column formats an insertion pushed off the sheet, once it is undone.
function restorePushedOff(sheet: Sheet, pushed: Removed): void {
	if (pushed.rowDefs.length > 0) {
		sheet.rowDefs ??= new Map()

		for (const [index, def] of pushed.rowDefs) sheet.rowDefs.set(index, def)
	}

	if (pushed.columns.length > 0 && sheet.columns !== undefined) {
		for (const column of pushed.columns) sheet.columns.push(column)
	}
}

// Whether an edit writes some but not all of an array formula's cells, which Excel refuses too.
function splitsArray(sheet: Sheet, cells: readonly { row: number; col: number }[]): boolean {
	if (!hasArrayFormulas(sheet)) {
		return false
	}

	const edited = new Set(cells.map(cell => key(cell.row, cell.col)))

	for (const cell of sheet.cells?.values() ?? []) {
		if (cell.formulaType !== "array" || cell.formulaRef === undefined) {
			continue
		}

		const range = parseRange(cell.formulaRef)
		let inside = 0

		for (const { row, col } of cells) {
			if (row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol) inside++
		}

		if (inside === 0) {
			continue
		}

		const size = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)

		if (size > edited.size) {
			return true
		}

		for (let row = range.startRow; row <= range.endRow; row++) {
			for (let col = range.startCol; col <= range.endCol; col++) {
				if (!edited.has(key(row, col))) return true
			}
		}
	}

	return false
}

// Whether an edit changes the text of a table's header cell: the table's column would need renaming, and
// every structured reference to it with it.
function renamesTableColumn(sheet: Sheet, cells: readonly { row: number; col: number; parsed: ParsedInput }[]): boolean {
	for (const table of sheet.tables ?? []) {
		if (table.range === undefined) {
			continue
		}

		const range = parseRange(table.range)

		for (const { row, col, parsed } of cells) {
			if (row !== range.startRow || col < range.startCol || col > range.endCol) {
				continue
			}

			const name = table.columns[col - range.startCol]?.name
			const text = parsed.type === "value" && !(parsed.value instanceof Date) ? String(parsed.value) : null

			if (text === null || text !== name) {
				return true
			}
		}
	}

	return false
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
