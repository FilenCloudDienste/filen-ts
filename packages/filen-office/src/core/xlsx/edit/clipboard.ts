import { spliceAll } from "../../arrays"
import {
	CellFlag,
	SHEET_MAX_COLS,
	SHEET_MAX_COPY_CELLS,
	SHEET_MAX_EDIT_CELLS,
	SHEET_MAX_ROWS,
	type SheetId,
	type SheetQueryResult,
	type SheetRange,
	type SheetRefusal
} from "../../sheet/protocol"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import {
	clipboardHtml,
	MAX_HTML_COPY_CELLS,
	MAX_HTML_COPY_LENGTH,
	parseClipboardHtml,
	type ClipBorders,
	type ClipCell,
	type ClipOutCell,
	type ClipValue
} from "../../sheet/clipboard/html"
import { r1c1ToA1 } from "../../sheet/clipboard/r1c1"
import { clipRows, parseTsv, pastedCells, pasteRepeats, type GridClip } from "../../sheet/clipboard/tsv"
import { cellKey } from "../../sheet/model/model"
import { rowHidden, visibleRanges, type RowSpan } from "../../sheet/visibleRows"
import { formulaTranslator, rewriteFormula, sameSheet } from "../../sheet/refs/formulaRefs"
import { sliceClock, type Slicing } from "../../slicing"
import type { SheetStore } from "../model/store"
import { CellKind, FormulaKind, XfApply, type XlsxDefinedName, type XlsxSheetModel, type XlsxSourceCell } from "../model/types"
import { planMove, type MovePlan } from "../refs/move"
import { moveReference, type CellMove } from "../refs/moveRefs"
import { nameWithFormula } from "../refs/plan"
import { parseRef } from "../refs/sqref"
import type { XlsxDocument } from "./document"
import { readEntry, setCells, splitsArray, unshare, type CellInputs } from "./cells"
import { filteredOutRows } from "./filter"
import { appendXf, patchXf, StyleLimitError } from "./format"
import { mergeCells, mergeRefusal } from "./merge"
import { changedBorder } from "./formatBorders"
import { ABSENT, type CellLog } from "./history"

// The TSV clipboard: a copy is the cells' text as other spreadsheets paste it, with the session's own record of
// what the cells held (formulas, values a format dresses up, formats); a paste of that same text back writes what
// they held, a cut moving its cells.

export interface XlsxClip {
	readonly id: number
	readonly sheet: SheetId
	readonly grid: GridClip
	// Each copied cell's format, by offset in the range (cellKey).
	readonly styles: ReadonlyMap<number, number>
	// The source cells of copied cells holding markup the model does not (a picture in the cell, rich runs), by
	// offset: a paste of this clip carries it (a cut moves it, a copy shares it), a paste of other text does not.
	readonly sources: ReadonlyMap<number, XlsxSourceCell>
	// What a values paste writes for numbers and formula results, by offset (a string is text): the value, not the
	// text a format shows. Other cells paste their entry or text.
	readonly values: ReadonlyMap<number, number | boolean | string>
}

function field(text: string): string {
	return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function lineEnds(text: string): string {
	return text.replace(/\r\n?/g, "\n")
}

export async function copyCells(
	document: XlsxDocument,
	sheet: SheetId,
	range: SheetRange,
	cut: boolean
): Promise<SheetQueryResult<"copy">> {
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1

	if (rows <= 0 || cols <= 0 || rows * cols > SHEET_MAX_COPY_CELLS) return { refused: "tooLarge" }

	// A sheet an edit took away while the request was on its way has nothing to copy.
	if (document.workbook.sheet(sheet) === undefined) return { clip: document.nextClip++, text: "" }

	// A copy of filtered data takes its visible rows only; a cut moves the whole range, hidden rows too, as Excel's does.
	const clip = await clipOf(document, sheet, range, cut, document.nextClip++, !cut)

	document.clip = clip

	return { clip: clip.id, text: clip.grid.tsv }
}

interface CopiedRows {
	// The runs of rows copied, in order.
	readonly runs: readonly SheetRange[]
	// The source row of each copied row, when the runs leave rows out.
	readonly sourceRows?: Uint32Array
}

// The rows a copy of `range` takes: while the sheet is filtered, its visible rows only (filteredOutRows), as Excel
// copies filtered data; every row otherwise.
function copiedRows(document: XlsxDocument, model: XlsxSheetModel, range: SheetRange, visibleOnly: boolean): CopiedRows {
	const whole = [range]
	const runs = visibleOnly ? visibleRanges(whole, filteredOutRows(document, model)) : whole

	if (runs === whole) return { runs }

	let count = 0

	for (const run of runs) count += run.endRow - run.startRow + 1

	const sourceRows = new Uint32Array(count)
	let i = 0

	for (const run of runs) for (let row = run.startRow; row <= run.endRow; row++) sourceRows[i++] = row

	return { runs, sourceRows }
}

// Each cell of `runs` with its row in the copy (the runs' rows one after the other).
function forEachCopied(
	store: SheetStore,
	runs: readonly SheetRange[],
	visit: (row: number, col: number, slot: number, clipRow: number) => void
): void {
	let base = 0

	for (const run of runs) {
		const start = run.startRow - base

		store.forEachCell(run, (row, col, slot) => visit(row, col, slot, row - start))
		base += run.endRow - run.startRow + 1
	}
}

// The record a copy of `range` makes (its text, entries, formats and markup), held nowhere: a copy keeps it as the
// session's latest, a drag of the cells (cells.move) pastes it at once and leaves the clipboard's alone. `visibleOnly`:
// the rows a filter hides are left out.
export async function clipOf(
	document: XlsxDocument,
	sheet: SheetId,
	range: SheetRange,
	cut: boolean,
	id: number,
	visibleOnly = false
): Promise<XlsxClip> {
	const cols = range.endCol - range.startCol + 1
	const model = await document.ready(sheet)
	const store = model.store as SheetStore
	const { runs, sourceRows } = copiedRows(document, model, range, visibleOnly)
	const rows = sourceRows?.length ?? range.endRow - range.startRow + 1
	const lines: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(""))
	const inputs = new Map<number, string>()
	const styles = new Map<number, number>()
	const sources = new Map<number, XlsxSourceCell>()
	const values = new Map<number, number | boolean | string>()
	const { dateBase } = document
	const locale = document.settings.locale

	forEachCopied(store, runs, (row, col, slot, clipRow) => {
		const view = document.cellView(sheet, row, col)
		const offset = cellKey(clipRow, col - range.startCol)
		const line = lines[clipRow]
		const value = copiedValue(document, model, sheet, row, col, view.text)
		const formula = store.formula(slot) >= 0

		if (line !== undefined) line[col - range.startCol] = field(view.text)

		if (!formula && value.kind === "text") {
			// Text is pasted as text: quoted where it would read as a number, date, boolean or error (as the paste reads
			// it, in the session's locale), so "007" stays "007".
			const read = readEntry(value.text, false, dateBase, locale)
			const entry = read.type === "text" && read.text === value.text ? value.text : `'${value.text}`

			if (entry !== view.text) inputs.set(offset, entry)
		} else if (view.input !== null) inputs.set(offset, view.input)

		if (value.kind === "number" || (formula && (value.kind === "boolean" || value.kind === "text")))
			values.set(offset, value.kind === "text" ? value.text : value.value)

		if (view.xf !== 0) styles.set(offset, view.xf)

		if (store.carriesMarkup(slot)) {
			const source = store.sourceCell(slot, model.part)

			if (source !== null) sources.set(offset, source)
		}
	})

	const text = lines.map(line => line.join("\t")).join("\r\n")
	const entry = document.workbook.sheet(sheet)

	return {
		id,
		sheet,
		grid: { tsv: text, sheet: entry?.name ?? "", range, cut, inputs, ...(sourceRows !== undefined && { sourceRows }) },
		styles,
		sources,
		values
	}
}

// --- A cut's move ---

// A cut moves its cells: every formula and name of the workbook moves its references as moveReference says (they
// follow the cut cells; one wholly to cells the paste writes over becomes #REF!), and so do the formulas of sections
// and parts, with the formats, validations, hyperlinks and merges of the cut cells (refs/move.ts). Its source is
// cleared as cells.clear clears it, and checked the same way first.

interface Repoint {
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
	readonly text: string
	// A shared formula's master whose text changes: its group is unshared first.
	readonly master: boolean
}

interface CutPlan {
	// The cut's cells as they stand.
	readonly cells: readonly { readonly row: number; readonly col: number }[]
	readonly repoints: readonly Repoint[]
	readonly names: { readonly before: readonly XlsxDefinedName[]; readonly after: readonly XlsxDefinedName[] } | null
	readonly parts: MovePlan
}

// The workbook's names as before or after the cut. The engine cannot take a name's new formula: it is dropped, and
// built again from the cells and names as they then are when an edit next needs it.
function setNames(document: XlsxDocument, names: readonly XlsxDefinedName[]): void {
	const workbook = document.workbook

	spliceAll(workbook.definedNames, 0, workbook.definedNames.length, names)
	workbook.changes.workbookSection("definedNames")
	document.dropEngine()
}

function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

function inside(range: SheetRange, row: number, col: number): boolean {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

// Whether formula text may refer to cells of `range`: a run of letters then digits that reads as a cell inside it,
// or a whole row or column range. Every reference is such a run, so a formula this says no to refers to none.
function mayReferInto(text: string, range: SheetRange): boolean {
	let i = 0

	while (i < text.length) {
		let j = i

		if (text.charCodeAt(j) === 36) j++

		const lettersStart = j
		let col = 0

		while (j < text.length && isLetter(text.charCodeAt(j))) {
			if (j - lettersStart < 3) col = col * 26 + ((text.charCodeAt(j) | 0x20) - 96)

			j++
		}

		const letters = j - lettersStart

		if (letters === 0) {
			// 1:3 (whole rows) or A:C (whole columns, after its letters) may meet the range.
			if (text.charCodeAt(j) === 58 || (isDigit(text.charCodeAt(j)) && /^\$?\d+:\$?\d/.test(text.slice(j)))) return true

			i = Math.max(j, i + 1)

			continue
		}

		if (text.charCodeAt(j) === 58 && letters <= 3) return true
		if (text.charCodeAt(j) === 36) j++

		const digitsStart = j
		let row = 0

		while (j < text.length && isDigit(text.charCodeAt(j))) {
			if (j - digitsStart < 8) row = row * 10 + text.charCodeAt(j) - 48

			j++
		}

		if (letters <= 3 && j > digitsStart && j - digitsStart <= 7 && inside(range, row - 1, col - 1)) return true

		i = j
	}

	return false
}

// Whether text may name `sheet` as a reference's sheet.
function mayName(text: string, sheet: string): boolean {
	if (!text.includes("!")) return false

	const upper = text.toUpperCase()
	const name = sheet.toUpperCase()

	return upper.includes(name) || (name.includes("'") && upper.includes(name.replaceAll("'", "''")))
}

// A formula on `own` (null for a workbook-wide name) after the move.
function moved(text: string, own: string | null, move: CellMove): string {
	return rewriteFormula(text, ref => moveReference(ref, own, move))
}

// Whether a formula on `own` may refer to the moved or the written-over cells.
function mayMeet(text: string, own: string | null, move: CellMove): boolean {
	return (
		(own !== null && sameSheet(own, move.sheet) && mayReferInto(text, move.range)) ||
		(own !== null && sameSheet(own, move.to) && mayReferInto(text, move.destination)) ||
		mayName(text, move.sheet) ||
		mayName(text, move.to)
	)
}

// The cut's checks (its cells are cleared as cells.clear would clear them) and what it moves, before anything
// changes.
async function planCut(
	document: XlsxDocument,
	cut: XlsxClip,
	sheet: SheetId,
	destination: SheetRange,
	slicing: Slicing | undefined
): Promise<CutPlan | { refused: SheetRefusal }> {
	const source = cut.grid.range
	const sourceModel = await document.ready(cut.sheet)
	const cells: { row: number; col: number }[] = []

	;(sourceModel.store as SheetStore).forEachCell(source, (row, col) => cells.push({ row, col }))

	for (const { row, col } of cells) if (document.locked(cut.sheet, row, col)) return { refused: { reason: "protectedSheet" } }

	const rows = Uint32Array.from(cells, cell => cell.row)
	const cols = Uint32Array.from(cells, cell => cell.col)

	if (splitsArray(sourceModel, rows, cols)) return { refused: { reason: "arrayFormula" } }

	await document.readyAllSheets(slicing)

	if (!document.allReady) return { refused: { reason: "structureLocked", detail: "unreadSheet" } }

	const workbook = document.workbook
	const move: CellMove = {
		sheet: workbook.sheet(cut.sheet)?.name ?? "",
		range: source,
		to: workbook.sheet(sheet)?.name ?? "",
		destination
	}

	// Names move like formulas (their attributes kept).
	const before = workbook.definedNames.slice()
	const after: XlsxDefinedName[] = []

	for (const defined of before) {
		const own = defined.sheet === null ? null : (workbook.sheet(defined.sheet)?.name ?? null)
		const formula = mayMeet(defined.formula, own, move) ? moved(defined.formula, own, move) : defined.formula
		const next = formula === defined.formula ? defined : nameWithFormula(defined, formula)

		if (next === null) return { refused: { reason: "structureLocked", detail: "definedNames" } }

		after.push(next)
	}

	const names = after.some((defined, i) => defined !== before[i]) ? { before, after } : null

	const repoints: Repoint[] = []
	const clock = slicing === undefined ? undefined : sliceClock(slicing)

	for (const entry of workbook.sheets) {
		const model = entry.model as XlsxSheetModel | null

		if (model === null) continue

		const store = model.store as SheetStore
		const formulas = store.formulas
		const own = entry.id === cut.sheet

		for (const block of store.blocks) {
			if (block.formulas === null) continue

			// A block at a time: calls wait in the session's order, so the store does not change meanwhile.
			if (clock?.due === true) await clock.pause()

			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
					const id = block.formulas[k] ?? -1

					if (id < 0) continue

					const col = block.cols[k] ?? 0

					// Cleared by the cut, or written over by the paste.
					if (own && inside(source, row, col)) continue
					if (entry.id === sheet && inside(destination, row, col)) continue

					const kind = formulas.kind(id)

					if (kind === FormulaKind.DATA_TABLE) {
						const formula = formulas.formula(id)

						for (const input of [formula.r1, formula.r2]) {
							const cell = input === undefined ? null : parseRef(input)

							if (
								cell !== null &&
								((own && inside(source, cell.startRow, cell.startCol)) ||
									(entry.id === sheet && inside(destination, cell.startRow, cell.startCol)))
							)
								return { refused: { reason: "structureLocked", detail: "dataTable" } }
						}

						continue
					}

					const text = document.formulaText(model, id, row, col)

					if (!mayMeet(text, entry.name, move)) continue

					const next = moved(text, entry.name, move)

					if (next === text) continue

					// As many cells as one edit writes.
					if (repoints.length === SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

					repoints.push({ sheet: entry.id, row, col, text: next, master: kind === FormulaKind.SHARED_MASTER })
				}
			}
		}
	}

	const parts = await planMove(workbook, move, slicing)

	return parts.ok ? { cells, repoints, names, parts: parts.plan } : { refused: parts.refusal }
}

// Clears the cut's cells (a shared formula's master unshared first, so its children keep their formulas) and
// moves the references into them, logged into the paste's step; sections and parts with them.
function applyCut(document: XlsxDocument, cut: XlsxClip, plan: CutPlan, log: CellLog, changes: SheetChangeSink): void {
	const source = document.model(cut.sheet)

	if (source === null) return

	for (const { row, col } of plan.cells) {
		const formula = document.state(cut.sheet, row, col).formula

		if (formula >= 0 && source.store.formulas.kind(formula) === FormulaKind.SHARED_MASTER) unshare(document, cut.sheet, row, col, log)
	}

	for (const repoint of plan.repoints) if (repoint.master) unshare(document, repoint.sheet, repoint.row, repoint.col, log)

	for (const { row, col } of plan.cells) {
		log.touch(cut.sheet, row, col, () => document.state(cut.sheet, row, col), true)
		document.write(cut.sheet, row, col, ABSENT)
	}

	for (const repoint of plan.repoints) {
		const model = document.model(repoint.sheet)
		const state = document.state(repoint.sheet, repoint.row, repoint.col)

		if (model === null || state.formula < 0) continue

		const formulas = model.store.formulas
		const before = formulas.formula(state.formula)
		// An array keeps its range; anything else becomes a formula of its own.
		const formula = formulas.add(
			before.kind === FormulaKind.ARRAY
				? { ...before, text: repoint.text }
				: { kind: FormulaKind.NORMAL, text: repoint.text, sharedIndex: -1, ref: null, flags: 0, cellMetadata: -1 }
		)

		log.touch(repoint.sheet, repoint.row, repoint.col, () => state, true)
		document.write(repoint.sheet, repoint.row, repoint.col, { ...state, formula })
	}

	plan.parts.apply()

	if (plan.names !== null) setNames(document, plan.names.after)

	changes.content(cut.sheet, cut.grid.range)
}

// The session's latest copy when `clipId` names it, `text` is still its text and the sheet it came from is still there.
function ownClip(document: XlsxDocument, clipId: number | undefined, text: string): XlsxClip | null {
	const held = document.clip

	return held !== null &&
		clipId === held.id &&
		lineEnds(text) === lineEnds(held.grid.tsv) &&
		document.workbook.sheet(held.sheet) !== undefined
		? held
		: null
}

const NO_ROWS: readonly RowSpan[] = []

// The rows a paste repeated down an area leaves out: while the sheet is filtered and the pasted block is one row
// (`tileRows`, read only then), the hidden ones, as Excel fills a filtered selection's visible cells only; none
// otherwise, a taller block landing on consecutive rows.
function repeatSkips(document: XlsxDocument, model: XlsxSheetModel, tileRows: () => number): readonly RowSpan[] {
	const hidden = filteredOutRows(document, model)

	return hidden.length > 0 && tileRows() === 1 ? hidden : NO_ROWS
}

// A values paste of `clip`: its values in full (numbers and formulas' results, in the file's own syntax), its other
// entries but formulas (quoted text), else what the cells show; never a cut.
function valuesGrid(clip: XlsxClip): GridClip {
	const inputs = new Map<number, string>()

	for (const [offset, input] of clip.grid.inputs) if (!input.startsWith("=")) inputs.set(offset, input)

	for (const [offset, value] of clip.values)
		inputs.set(
			offset,
			typeof value === "string" ? `'${value}` : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value)
		)

	return { ...clip.grid, cut: false, inputs }
}

// clipboard.paste: the session's own copy when `clip` names it and the text is still its text, else the text read
// as tab-separated values. `values` pastes the copy's values alone (Paste Values): no formats, formulas or markup, and
// a cut is a copy. Repeated over the paste area `area` as pasteRepeats says, each copy with its own formats and markup.
export async function pasteCells(
	document: XlsxDocument,
	sheet: SheetId,
	at: { readonly row: number; readonly col: number },
	text: string,
	clipId: number | undefined,
	changes: SheetChangeSink,
	slicing?: Slicing,
	values = false,
	area?: SheetRange
): Promise<SheetHandled> {
	// The session's own copy, while the sheet it came from is there (a cut whose sheet went is a cut no more).
	return pasteClip(document, sheet, at, text, ownClip(document, clipId, text), changes, slicing, values, area, true)
}

// A paste of `held` (a clip, or null for text alone). `latest`: `held` is the session's latest copy, which a pasted
// cut then names where its cells went; a drag's own clip (cells.move) is held nowhere.
export async function pasteClip(
	document: XlsxDocument,
	sheet: SheetId,
	at: { readonly row: number; readonly col: number },
	text: string,
	held: XlsxClip | null,
	changes: SheetChangeSink,
	slicing: Slicing | undefined,
	values: boolean,
	area: SheetRange | undefined,
	latest: boolean
): Promise<SheetHandled> {
	const grid = held === null ? null : values ? valuesGrid(held) : held.grid
	// What the paste carries beyond entries: none for values.
	const own = values ? null : held
	const target = document.workbook.sheet(sheet)

	if (target === undefined) return { refused: { reason: "tooLarge" } }

	// The paste area's merges: a copy that would cut through one is pasted once.
	const model = await document.ready(sheet)
	const block = pastedCells(text, grid, at, target.name, SHEET_MAX_EDIT_CELLS, area, area === undefined ? undefined : model.merges)

	if (block === null || block.cells.length === 0) return block === null ? { refused: { reason: "tooLarge" } } : null

	const range = { startRow: at.row, startCol: at.col, endRow: at.row + block.rows - 1, endCol: at.col + block.cols - 1 }
	// A pasted cell's offset in the clip (the same in every copy of it).
	const heldRows = grid === null ? 1 : clipRows(grid)
	const clipCols = grid === null ? 1 : grid.range.endCol - grid.range.startCol + 1
	const offsetOf = (cell: { readonly row: number; readonly col: number }): number =>
		cellKey((cell.row - at.row) % heldRows, (cell.col - at.col) % clipCols)
	// One row repeated down a filtered area lands on its visible rows only, as Excel pastes it.
	const skipped = block.rows > 1 ? repeatSkips(document, model, () => (grid === null ? parseTsv(text).length : heldRows)) : NO_ROWS
	const cells = skipped.length === 0 ? block.cells : block.cells.filter(cell => !rowHidden(skipped, cell.row))
	const styles = own === null ? undefined : Int32Array.from(cells, cell => own.styles.get(offsetOf(cell)) ?? 0)
	// A values paste's own entries are in the file's own syntax; what the cells show is read in the session's locale.
	const canonical = values && grid !== null ? Uint8Array.from(cells, cell => (grid.inputs.has(offsetOf(cell)) ? 1 : 0)) : undefined
	const cut = own?.grid.cut === true ? own : null
	const plan = cut === null ? null : await planCut(document, cut, sheet, range, slicing)

	if (plan !== null && "refused" in plan) return plan

	// Cells of this clip that hold markup the model does not carry their source cells (the writer keeps that markup).
	const store = (await document.ready(sheet)).store as SheetStore
	const origins =
		own === null || own.sources.size === 0
			? undefined
			: Float64Array.from(cells, cell => {
					const source = own.sources.get(offsetOf(cell))

					return source === undefined ? -1 : store.carry(source)
				})
	const inputs: CellInputs = {
		rows: Uint32Array.from(cells, cell => cell.row),
		cols: Uint32Array.from(cells, cell => cell.col),
		inputs: cells.map(cell => cell.input),
		...(styles !== undefined && { styles }),
		...(origins !== undefined && { origins }),
		...(canonical !== undefined && { canonical })
	}

	const handled = await setCells(
		document,
		sheet,
		inputs,
		changes,
		cut === null || plan === null ? undefined : log => applyCut(document, cut, plan, log, changes),
		slicing
	)

	if (handled === null || "refused" in handled) return handled
	if (latest && cut !== null && block.clip !== null) document.clip = { ...cut, sheet, grid: block.clip }

	changes.select(sheet, { activeRow: at.row, activeCol: at.col, ranges: [range] })

	if (plan === null) return handled

	const { parts, names } = plan

	return {
		bytes: handled.bytes,
		undo: async sink => {
			await handled.undo(sink)
			parts.revert()

			if (names !== null) setNames(document, names.before)
		},
		redo: async sink => {
			parts.apply()

			if (names !== null) setNames(document, names.after)

			await handled.redo(sink)
		}
	}
}

// --- HTML ---

function copiedValue(document: XlsxDocument, model: XlsxSheetModel, sheet: SheetId, row: number, col: number, text: string): ClipValue {
	const state = document.state(sheet, row, col)

	if (state.formula >= 0 && state.shown !== undefined) {
		const value = state.shown.value

		if (state.shown.error || value === null) return text === "" ? { kind: "empty" } : { kind: "typed", text }

		return typeof value === "number"
			? { kind: "number", value }
			: typeof value === "boolean"
				? { kind: "boolean", value }
				: { kind: "text", text: value }
	}

	switch (state.kind) {
		case CellKind.NUMBER:
			return { kind: "number", value: state.value }
		case CellKind.BOOLEAN:
			return { kind: "boolean", value: state.value !== 0 }
		case CellKind.SHARED_STRING:
		case CellKind.INLINE_STRING:
		case CellKind.FORMULA_STRING:
			return { kind: "text", text: document.stringOf(model, state.kind, state.value) }
		default:
			return text === "" ? { kind: "empty" } : { kind: "typed", text }
	}
}

// A range as clipboard HTML (html.ts): what each cell shows, its value, formula and format. Null past
// MAX_HTML_COPY_CELLS or MAX_HTML_COPY_LENGTH.
export async function copyHtml(
	document: XlsxDocument,
	sheet: SheetId,
	range: SheetRange,
	cut = false
): Promise<SheetQueryResult<"copyHtml">> {
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1

	if (rows <= 0 || cols <= 0 || rows * cols > MAX_HTML_COPY_CELLS || document.workbook.sheet(sheet) === undefined) return { html: null }

	const model = await document.ready(sheet)
	const store = model.store as SheetStore
	const cells = new Map<number, ClipOutCell>()
	// The rows copyCells takes, so the HTML and the text hold the same cells.
	const { runs, sourceRows } = copiedRows(document, model, range, !cut)

	forEachCopied(store, runs, (row, col, slot, clipRow) => {
		const view = document.cellView(sheet, row, col)
		const formula = store.formula(slot)

		cells.set(cellKey(clipRow, col - range.startCol), {
			text: view.text,
			value: copiedValue(document, model, sheet, row, col, view.text),
			// In the file's own syntax, whatever the session's locale shows (a paste reads it so).
			formula:
				formula < 0 || (view.flags & CellFlag.FORMULA_HIDDEN) !== 0 ? null : `=${document.formulaText(model, formula, row, col)}`,
			style: document.styles.renderStyle(view.xf),
			numFmt: document.styles.numFmtCode(view.xf)
		})
	})

	return {
		html: clipboardHtml(
			sourceRows?.length ?? rows,
			cols,
			{ row: range.startRow, col: range.startCol },
			(row, col) => cells.get(cellKey(row, col)) ?? null,
			MAX_HTML_COPY_LENGTH,
			sourceRows
		)
	}
}

// Whether a pasted cell's entry is in the file's own syntax (a formula, a value the HTML says exactly) rather than text
// typed in the session's locale.
function canonicalInput(cell: ClipCell): boolean {
	return cell.formula !== null || (cell.value.kind !== "typed" && cell.value.kind !== "empty")
}

// The entry a pasted cell is typed as at `row`, `col`: its formula moved there, else its value as this app reads it
// back exactly (text as text, numbers in full).
function pastedInput(cell: ClipCell, row: number, col: number): string {
	const formula = cell.formula

	if (formula !== null) {
		const text = formula.text.slice(1)

		return formula.kind === "r1c1"
			? `=${r1c1ToA1(text, row, col)}`
			: `=${formulaTranslator(text)(row - formula.row, col - formula.col)}`
	}

	const value = cell.value

	switch (value.kind) {
		case "typed":
			// Text formatted as Text stays text.
			return cell.format?.numFmt === "@" ? `'${value.text}` : value.text
		case "text":
			return `'${value.text}`
		case "number":
			return String(value.value)
		case "boolean":
			return value.value ? "TRUE" : "FALSE"
		case "empty":
			return ""
	}
}

// The cell format a pasted cell takes: the workbook's default with the HTML's format (and borders), plus the number
// format its entry implies when the HTML names none (a date typed as text). -1 for the format typing gives, when the
// table says nothing of formats at all. Each distinct format is made once.
function pastedXf(document: XlsxDocument, cell: ClipCell, input: string, formatted: boolean, made: Map<string, number>): number {
	if (!formatted) return -1

	const implied =
		cell.format?.numFmt === undefined && cell.formula === null
			? readEntry(input, false, document.date1904, canonicalInput(cell) ? undefined : document.settings.locale)
			: null
	const format =
		implied?.type === "number" && implied.format !== undefined ? { ...cell.format, numFmt: implied.format } : (cell.format ?? {})
	const key = JSON.stringify([format, cell.borders])
	let xf = made.get(key)

	if (xf === undefined) {
		xf = patchXf(document, 0, format)
		xf = cell.borders === null ? xf : borderedXf(document, xf, cell.borders)
		made.set(key, xf)
	}

	return xf
}

function borderedXf(document: XlsxDocument, index: number, borders: ClipBorders): number {
	const styles = document.workbook.styles
	const xf = styles.cellXfs[index] ?? styles.cellXfs[0]

	if (xf === undefined) return index

	const border = changedBorder(styles.borders[xf.borderId] ?? {}, borders)

	return appendXf(document, { ...xf, borderId: styles.appendBorder(border), flags: xf.flags | XfApply.BORDER })
}

// clipboard.pasteHtml: the session's own copy when `clip` names it and the text is still its text; else the HTML's
// first table, its values, formulas and formats (html.ts); else the text as tab-separated values. Repeated over the
// paste area `area` as pasteRepeats says, each copy's formulas moved to where it lands.
export async function pasteHtml(
	document: XlsxDocument,
	sheet: SheetId,
	at: { readonly row: number; readonly col: number },
	html: string,
	text: string,
	clipId: number | undefined,
	changes: SheetChangeSink,
	slicing?: Slicing,
	area?: SheetRange
): Promise<SheetHandled> {
	if (ownClip(document, clipId, text) !== null) return pasteCells(document, sheet, at, text, clipId, changes, slicing, false, area)

	const table = parseClipboardHtml(html, SHEET_MAX_EDIT_CELLS)

	if (table === "tooLarge") return { refused: { reason: "tooLarge" } }
	if (table === null) return pasteCells(document, sheet, at, text, clipId, changes, slicing, false, area)
	if (at.row + table.rows > SHEET_MAX_ROWS || at.col + table.cols > SHEET_MAX_COLS) return { refused: { reason: "tooLarge" } }

	const model = await document.ready(sheet)
	const { down, across } = pasteRepeats(table.rows, table.cols, at, area, model.merges)
	const copies = down * across

	if (table.cells.length * copies > SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

	// One row repeated down a filtered area lands on its visible rows only (repeatSkips).
	const skipped = down > 1 ? repeatSkips(document, model, () => table.rows) : NO_ROWS
	const skips = (tileRow: number): boolean => skipped.length > 0 && rowHidden(skipped, at.row + tileRow)
	// The table's spans are merged where they land, as Excel pastes them; one that cannot be is a refusal up front.
	const merges: SheetRange[] = []

	for (let tileRow = 0; tileRow < down; tileRow++)
		for (let tileCol = 0; tileCol < across && !skips(tileRow); tileCol++) {
			const row = at.row + tileRow * table.rows
			const col = at.col + tileCol * table.cols

			for (const span of table.spans)
				merges.push({
					startRow: row + span.startRow,
					startCol: col + span.startCol,
					endRow: row + span.endRow,
					endCol: col + span.endCol
				})
		}

	const mergeRefused = merges.length === 0 ? null : await mergeRefusal(document, sheet, merges)

	if (mergeRefused !== null) return { refused: mergeRefused }

	const formatted = table.cells.some(cell => cell.format !== null || cell.borders !== null)
	const made = new Map<string, number>()
	const count = table.cells.length * copies
	const rows = new Uint32Array(count)
	const cols = new Uint32Array(count)
	const inputs: string[] = []
	const styles = new Int32Array(count)
	const canonical = new Uint8Array(count)
	let i = 0

	try {
		for (let tileRow = 0; tileRow < down; tileRow++)
			for (let tileCol = 0; tileCol < across && !skips(tileRow); tileCol++)
				for (const cell of table.cells) {
					const row = at.row + tileRow * table.rows + cell.row
					const col = at.col + tileCol * table.cols + cell.col
					const input = pastedInput(cell, row, col)

					rows[i] = row
					cols[i] = col
					inputs.push(input)
					styles[i] = pastedXf(document, cell, input, formatted, made)
					canonical[i] = canonicalInput(cell) ? 1 : 0
					i++
				}
	} catch (error) {
		if (error instanceof StyleLimitError) return { refused: { reason: "styleLimit" } }

		throw error
	}

	const written = { rows: rows.subarray(0, i), cols: cols.subarray(0, i), inputs, canonical: canonical.subarray(0, i) }
	const handled = await setCells(
		document,
		sheet,
		formatted ? { ...written, styles: styles.subarray(0, i) } : written,
		changes,
		undefined,
		slicing
	)

	if (handled === null || "refused" in handled) return handled

	changes.select(sheet, {
		activeRow: at.row,
		activeCol: at.col,
		ranges: [{ startRow: at.row, startCol: at.col, endRow: at.row + table.rows * down - 1, endCol: at.col + table.cols * across - 1 }]
	})

	if (merges.length === 0) return handled

	// The cells the spans cover were pasted empty: the merge drops nothing.
	const merged = await mergeCells(document, sheet, merges, "merge", true, changes)

	if (merged === null) return handled

	// Refused past the check above (more formats than a workbook holds): the paste is taken back, so nothing changed.
	if ("refused" in merged) {
		await handled.undo(changes)

		return merged
	}

	return {
		bytes: handled.bytes + merged.bytes,
		undo: async sink => {
			await merged.undo(sink)
			await handled.undo(sink)
		},
		redo: async sink => {
			await handled.redo(sink)
			await merged.redo(sink)
		}
	}
}
