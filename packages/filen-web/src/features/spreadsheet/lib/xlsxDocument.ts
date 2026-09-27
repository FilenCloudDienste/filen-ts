import { saveXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { Cell, CellStyle, CellValue, ColumnDef, MergeRange, RowDef, Sheet } from "hucre"
import { parseCellInput } from "@/features/spreadsheet/lib/cellInput.logic"
import {
	MAX_COLS,
	MAX_EDIT_CELLS,
	MAX_ROWS,
	MAX_SHEET_CELLS,
	type DocState,
	type EditOp,
	type EditResult,
	type FormatPatch
} from "@/features/spreadsheet/lib/edits"
import { FormulaEngine, type RecalculatedCell } from "@/features/spreadsheet/lib/formulaEngine"
import { cellKey, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { isWorksheet, structureLocked, workbookDoc, WorkbookViews } from "@/features/spreadsheet/lib/xlsxView"

// Excel's own limits.
const HISTORY_LIMIT = 100
const SHEET_NAME = /^[^\\/?*[\]:]{1,31}$/

function key(row: number, col: number): string {
	return `${String(row)},${String(col)}`
}

function typeOf(value: CellValue): Cell["type"] {
	if (value === null) return "empty"
	if (typeof value === "number") return "number"
	if (typeof value === "boolean") return "boolean"
	if (value instanceof Date) return "date"

	return "string"
}

interface SheetSnapshot {
	index: number
	rows: CellValue[][]
	cells: Map<string, Cell> | undefined
	merges: MergeRange[] | undefined
	rowDefs: Map<number, RowDef> | undefined
	columns: ColumnDef[] | undefined
	name: string
}

function snapshot(sheet: Sheet, index: number): SheetSnapshot {
	return {
		index,
		rows: sheet.rows.map(row => row.slice()),
		cells: sheet.cells === undefined ? undefined : new Map([...sheet.cells].map(([cellKey, cell]) => [cellKey, { ...cell }])),
		merges: sheet.merges?.map(merge => ({ ...merge })),
		rowDefs: sheet.rowDefs === undefined ? undefined : new Map(sheet.rowDefs),
		columns: sheet.columns?.map(column => ({ ...column })),
		name: sheet.name
	}
}

function restore(sheet: Sheet, saved: SheetSnapshot): void {
	sheet.rows = saved.rows
	sheet.name = saved.name

	if (saved.cells === undefined) delete sheet.cells
	else sheet.cells = saved.cells

	if (saved.merges === undefined) delete sheet.merges
	else sheet.merges = saved.merges

	if (saved.rowDefs === undefined) delete sheet.rowDefs
	else sheet.rowDefs = saved.rowDefs

	if (saved.columns === undefined) delete sheet.columns
	else sheet.columns = saved.columns
}

// What undoing one step puts back: the cells a cell edit changed, or whole sheets for everything else.
type Step =
	| { type: "cells"; sheet: number; before: Map<string, { value: CellValue; cell: Cell | undefined }> }
	| { type: "sheets"; before: SheetSnapshot[]; sheetCount: number }

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

// An open .xlsx: the workbook as read (every part the grid does not model rides along untouched and is
// written back as it was), its view for the grid, the formula engine once something needs it, and an undo
// history. Worker-side only.
export class XlsxDocument {
	private readonly workbook: RoundtripWorkbook
	private readonly views: WorkbookViews
	private engine: FormulaEngine | null = null
	private readonly hasFormulas: boolean
	private undoSteps: { step: Step; op: EditOp }[] = []
	private redoOps: EditOp[] = []
	// Counts applied steps; `saved` is its value when the file was opened.
	private version = 0
	private saved = 0

	constructor(workbook: RoundtripWorkbook) {
		this.workbook = workbook
		this.views = new WorkbookViews(workbook.themeColors)
		this.hasFormulas = workbook.sheets.some(sheet => [...(sheet.cells?.values() ?? [])].some(cell => cell.formula !== undefined))

		if (this.hasFormulas) {
			this.calculateMissing()
		}
	}

	// Files written by other programs often store formulas without their results, leaving the calculation
	// to whatever opens them: those are calculated now. Filling them in is not an edit.
	private calculateMissing(): void {
		const missing = this.worksheets().flatMap((sheet, index) =>
			[...(sheet.cells ?? [])]
				.filter(([, cell]) => cell.formula !== undefined && (cell.formulaResult === undefined || cell.formulaResult === null))
				.map(([cellId, cell]) => ({ sheet, index, cellId, cell }))
		)

		if (missing.length === 0) {
			return
		}

		const engine = this.ensureEngine()

		for (const { sheet, index, cellId, cell } of missing) {
			const [row = 0, col = 0] = cellId.split(",").map(Number)
			const value = engine.value(index, row, col)
			const values = sheet.rows[row]

			cell.formulaResult = value
			cell.value = value

			if (values !== undefined) {
				values[col] = value
			}
		}
	}

	doc(): SpreadsheetDoc {
		return workbookDoc(this.workbook, this.views, true)
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
		return { dirty: this.version !== this.saved, canUndo: this.undoSteps.length > 0, canRedo: this.redoOps.length > 0 }
	}

	private ensureEngine(): FormulaEngine {
		this.engine ??= new FormulaEngine(this.workbook)

		return this.engine
	}

	apply(op: EditOp): EditResult {
		const result = this.run(op)

		if (result.step !== null) {
			this.undoSteps.push({ step: result.step, op })

			if (this.undoSteps.length > HISTORY_LIMIT) {
				this.undoSteps.shift()
				// The save point may have fallen off the history: nothing can return to it any more.
				this.saved = this.saved === this.version - HISTORY_LIMIT ? -1 : this.saved
			}

			this.redoOps = []
			this.version++
		}

		return result.result()
	}

	undo(): EditResult {
		const last = this.undoSteps.pop()

		if (last === undefined) {
			return { type: "none", state: this.state() }
		}

		this.redoOps.push(last.op)
		this.version--

		return this.revert(last.step)
	}

	redo(): EditResult {
		const op = this.redoOps.pop()

		if (op === undefined) {
			return { type: "none", state: this.state() }
		}

		const redoOps = this.redoOps
		const result = this.run(op)

		if (result.step !== null) {
			this.undoSteps.push({ step: result.step, op })
			this.version++
		}

		this.redoOps = redoOps

		return result.result()
	}

	// The file's bytes as edited. Nothing is marked saved here: the upload may still fail, and one that
	// lands reloads the grid on the new version anyway.
	async serialize(): Promise<Uint8Array> {
		return await saveXlsx(this.workbook)
	}

	private revert(step: Step): EditResult {
		if (step.type === "cells") {
			const sheet = this.workbook.sheets[step.sheet]

			if (sheet === undefined) {
				return { type: "none", state: this.state() }
			}

			const touched: { row: number; col: number }[] = []

			for (const [cellId, before] of step.before) {
				const [row = 0, col = 0] = cellId.split(",").map(Number)

				this.write(sheet, row, col, before.value, before.cell)
				touched.push({ row, col })
			}

			const recalculated =
				this.engine?.set(
					this.worksheets().indexOf(sheet),
					touched.map(({ row, col }) => ({ row, col, content: this.engineContent(sheet, row, col) }))
				) ?? []

			return this.cellsResult(sheet, touched, this.applyRecalculated(recalculated))
		}

		// Sheets were inserted, added or renamed: put every snapshotted sheet back and drop the ones added
		// since, then rebuild the formula engine from the restored workbook when it is next needed.
		for (const saved of step.before) {
			const sheet = this.workbook.sheets[saved.index]

			if (sheet !== undefined) {
				restore(sheet, saved)
			}
		}

		this.workbook.sheets.length = step.sheetCount
		this.engine?.destroy()
		this.engine = null

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
			case "renameSheet":
				return this.sheetOp(op)
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

	private engineContent(sheet: Sheet, row: number, col: number): CellValue | string {
		const formula = sheet.cells?.get(key(row, col))?.formula

		return formula === undefined ? (sheet.rows[row]?.[col] ?? null) : `=${formula}`
	}

	// Stores what the engine recalculated into the formula cells it names (a value cell the engine echoes
	// back is what was set already). A result the engine could not compute itself keeps the stored one.
	private applyRecalculated(cells: readonly RecalculatedCell[]): RecalculatedCell[] {
		const applied: RecalculatedCell[] = []

		for (const recalculated of cells) {
			const sheet = this.worksheets()[recalculated.sheet]
			const cell = sheet?.cells?.get(key(recalculated.row, recalculated.col))

			if (sheet === undefined || cell?.formula === undefined) {
				continue
			}

			if (FormulaEngine.unsupported(recalculated.value) && cell.formulaResult !== undefined && cell.formulaResult !== null) {
				continue
			}

			cell.formulaResult = recalculated.value
			cell.value = recalculated.value

			const values = sheet.rows[recalculated.row]

			if (values !== undefined) {
				values[recalculated.col] = recalculated.value
			}

			applied.push(recalculated)
		}

		return applied
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
			return { step: null, result: () => ({ type: "refused", reason: "tooLarge", state: this.state() }) }
		}

		const before = new Map<string, { value: CellValue; cell: Cell | undefined }>()
		const contents: { row: number; col: number; content: CellValue | string }[] = []
		const parsedCells = cells.map(cell => ({ ...cell, parsed: parseCellInput(cell.input) }))
		// Built from the workbook as it stands before this edit, so the edit itself is what it recalculates.
		const engine =
			this.hasFormulas || this.engine !== null || parsedCells.some(cell => cell.parsed.type === "formula")
				? this.ensureEngine()
				: null

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
				contents.push({ row, col, content: null })
			} else if (parsed.type === "formula") {
				this.write(sheet, row, col, null, { ...base, value: null, type: "formula", formula: parsed.formula, formulaResult: null })
				contents.push({ row, col, content: `=${parsed.formula}` })
			} else {
				const cell: Cell = { ...base, value: parsed.value, type: typeOf(parsed.value) }

				if (parsed.impliedFormat !== undefined && (base.style?.numFmt === undefined || base.style.numFmt === "General")) {
					cell.style = { ...base.style, numFmt: parsed.impliedFormat }
				}

				const detailed = cell.style !== undefined || cell.comment !== undefined || cell.hyperlink !== undefined

				this.write(sheet, row, col, parsed.value, detailed ? cell : undefined)
				contents.push({ row, col, content: parsed.value })
			}
		}

		const recalculated = engine === null ? [] : this.applyRecalculated(engine.set(sheetIndex, contents))

		return {
			step: { type: "cells", sheet: this.workbook.sheets.indexOf(sheet), before },
			result: () => this.cellsResult(sheet, cells, recalculated)
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
			return { step: null, result: () => ({ type: "refused", reason: "tooLarge", state: this.state() }) }
		}

		const before = new Map<string, { value: CellValue; cell: Cell | undefined }>()
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
			result: () => this.cellsResult(sheet, touched, [])
		}
	}

	private structure(op: Extract<EditOp, { type: "insert" | "delete" }>): { step: Step | null; result: () => EditResult } {
		const sheet = this.worksheets()[op.sheet]

		if (sheet === undefined || structureLocked(sheet) || (this.workbook.namedRanges?.length ?? 0) > 0) {
			return { step: null, result: () => ({ type: "refused", reason: "structureLocked", state: this.state() }) }
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
			return { step: null, result: () => ({ type: "refused", reason: "tooLarge", state: this.state() }) }
		}

		// Formulas anywhere may point into this sheet, so every worksheet is kept while the engine has any. The
		// engine is built before the sheet moves, as it moves its own copy.
		const engine = this.hasFormulas || this.engine !== null ? this.ensureEngine() : null
		const engineInUse = engine !== null
		const before = this.workbook.sheets
			.map((candidate, index) => ({ candidate, index }))
			.filter(({ candidate }) => candidate === sheet || (engineInUse && isWorksheet(candidate)))
			.map(({ candidate, index }) => snapshot(candidate, index))

		shiftSheet(sheet, op)

		if (engine !== null) {
			const recalculated =
				op.type === "insert" ? engine.insert(op.sheet, op.axis, op.at, op.count) : engine.remove(op.sheet, op.axis, op.at, op.count)

			// References moved: read every formula back from the engine, then take the recalculated values.
			this.worksheets().forEach((candidate, index) => {
				for (const [cellId, cell] of candidate.cells ?? []) {
					if (cell.formula === undefined) {
						continue
					}

					const [row = 0, col = 0] = cellId.split(",").map(Number)
					const formula = engine.formula(index, row, col)

					if (formula !== undefined) {
						cell.formula = formula
					}
				}
			})

			this.applyRecalculated(recalculated)
		}

		return { step: { type: "sheets", before, sheetCount: this.workbook.sheets.length }, result: () => this.sheetsResult() }
	}

	private sheetOp(op: Extract<EditOp, { type: "addSheet" | "renameSheet" }>): { step: Step | null; result: () => EditResult } {
		const name = op.name.trim()
		const taken = this.workbook.sheets.some(
			(sheet, index) =>
				sheet.name.toLowerCase() === name.toLowerCase() && (op.type === "addSheet" || index !== this.workbookIndex(op.sheet))
		)

		if (!SHEET_NAME.test(name) || name.startsWith("'") || name.endsWith("'") || taken) {
			return { step: null, result: () => ({ type: "refused", reason: "sheetName", state: this.state() }) }
		}

		const sheetCount = this.workbook.sheets.length

		if (op.type === "addSheet") {
			this.workbook.sheets.push({ name, rows: [] })
			this.engine?.destroy()
			this.engine = null

			return { step: { type: "sheets", before: [], sheetCount }, result: () => this.sheetsResult() }
		}

		const index = this.workbookIndex(op.sheet)
		const sheet = this.workbook.sheets[index]

		if (sheet === undefined) {
			return { step: null, result: () => ({ type: "refused", reason: "sheetName", state: this.state() }) }
		}

		// Formulas elsewhere name the sheet: snapshot them all, rename, and rewrite the references.
		const before = this.workbook.sheets.map((candidate, candidateIndex) => snapshot(candidate, candidateIndex))
		const oldName = sheet.name

		sheet.name = name
		renameReferences(this.workbook.sheets, oldName, name)
		this.engine?.destroy()
		this.engine = null

		return { step: { type: "sheets", before, sheetCount }, result: () => this.sheetsResult() }
	}

	private cellsResult(
		sheet: Sheet,
		touched: readonly { row: number; col: number }[],
		recalculated: readonly RecalculatedCell[]
	): EditResult {
		const sheetIndex = this.worksheets().indexOf(sheet)
		const patch = new Map<number, CellView | null>()

		for (const { row, col } of touched) {
			patch.set(cellKey(row, col), this.views.cell(sheet, row, col))
		}

		for (const cell of recalculated) {
			const target = this.worksheets()[cell.sheet]

			if (target === sheet) {
				patch.set(cellKey(cell.row, cell.col), this.views.cell(sheet, cell.row, cell.col))
			}
		}

		// Recalculated cells on other sheets: their views are rebuilt when the grid shows them next.
		const otherSheets = recalculated.some(cell => this.worksheets()[cell.sheet] !== sheet)

		if (otherSheets) {
			return this.sheetsResult()
		}

		return {
			type: "cells",
			sheet: sheetIndex,
			cells: [...patch],
			rowCount: sheet.rows.length,
			colCount: sheet.rows[0]?.length ?? 0,
			styles: this.views.styles.styles,
			state: this.state()
		}
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

// Moves a sheet's cells, merges and row/column formats for an inserted or deleted run of rows or
// columns. A merge the deletion cuts through shrinks; one it swallows goes.
export function shiftSheet(sheet: Sheet, op: { type: "insert" | "delete"; axis: "rows" | "cols"; at: number; count: number }): void {
	const rowsAxis = op.axis === "rows"
	const shift = op.type === "insert" ? op.count : -op.count
	const moved = (index: number): number | null => {
		if (index < op.at) return index
		if (op.type === "delete" && index < op.at + op.count) return null

		return index + shift
	}

	if (rowsAxis) {
		const width = sheet.rows[0]?.length ?? 0

		if (op.type === "insert") {
			sheet.rows.splice(
				Math.min(op.at, sheet.rows.length),
				0,
				...Array.from({ length: op.count }, () => new Array<CellValue>(width).fill(null))
			)
		} else {
			sheet.rows.splice(op.at, op.count)
		}
	} else {
		for (const values of sheet.rows) {
			if (op.type === "insert") {
				if (op.at <= values.length) values.splice(op.at, 0, ...new Array<CellValue>(op.count).fill(null))
			} else {
				values.splice(op.at, op.count)
			}
		}
	}

	if (sheet.cells !== undefined) {
		const cells = new Map<string, Cell>()

		for (const [cellId, cell] of sheet.cells) {
			const [row = 0, col = 0] = cellId.split(",").map(Number)
			const index = moved(rowsAxis ? row : col)

			if (index !== null) {
				cells.set(rowsAxis ? key(index, col) : key(row, index), cell)
			}
		}

		sheet.cells = cells
	}

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

	if (rowsAxis && sheet.rowDefs !== undefined) {
		const rowDefs = new Map<number, RowDef>()

		for (const [index, def] of sheet.rowDefs) {
			const next = moved(index)

			if (next !== null) rowDefs.set(next, def)
		}

		sheet.rowDefs = rowDefs
	}

	if (!rowsAxis && sheet.columns !== undefined) {
		if (op.type === "insert") {
			if (op.at <= sheet.columns.length) sheet.columns.splice(op.at, 0, ...Array.from({ length: op.count }, () => ({})))
		} else {
			sheet.columns.splice(op.at, op.count)
		}
	}
}

// Rewrites references to a renamed sheet in every formula: Old!A1, 'Old Name'!A1 (names compare
// case-insensitively, as Excel's do).
export function renameReferences(sheets: readonly Sheet[], oldName: string, newName: string): void {
	const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const quotedOld = oldName.replaceAll("'", "''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const pattern = new RegExp(`(^|[^A-Za-z0-9_.'])(?:'${quotedOld}'|${escaped})!`, "gi")
	const replacement = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(newName) ? newName : `'${newName.replaceAll("'", "''")}'`

	for (const sheet of sheets) {
		for (const cell of sheet.cells?.values() ?? []) {
			if (cell.formula !== undefined) {
				cell.formula = cell.formula.replace(pattern, (_match, before: string) => `${before}${replacement}!`)
			}
		}
	}
}
