import { decodeUtf8 } from "../../xml/index"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetCommandOf, type SheetRange, type SheetRefusal } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import { formulaTranslator } from "../../sheet/refs/formulaRefs"
import { sortStateMarkup } from "../../sheet/filter/autoFilter"
import { BLANK_SORT_VALUE, sortOrder, type SortValue } from "../../sheet/sort/order"
import type { CellWrite, SheetStore } from "../model/store"
import { CARRIED, CellKind, ColFlag, FormulaKind, RowFlag, SLOT_BLOCK, type XlsxSheetModel } from "../model/types"
import type { EngineCell, RecalculatedCell } from "../../sheet/formula/index"
import { RefRefused } from "../refs/catalogue"
import { liveRelationships, refState } from "../refs/state"
import { contains, intersects } from "../refs/moveRefs"
import { parseRef, parseSqref, sectionSqrefs } from "../refs/sqref"
import { unshare } from "./cells"
import { reportLogged } from "./format"
import type { XlsxDocument } from "./document"
import { CellLog, StoreSnapshot, cellKeyOf, rowState, type ShownResult } from "./history"
import { filterTargets, loadTables, readCell, sortStateParts, sortValueOf, tableBody, type FilterTable, type SortStateEdit } from "./filter"
import { moveAnnotations } from "./sortAnnotations"

// Sort (sort.apply): the rows of a range ordered by up to 64 keys (columns of the range), or its columns by rows
// (left to right), in Excel's order (sort/order.ts), stably. As Excel sorts ("Sort data in a range or table",
// support.microsoft.com): the header row stays (My data has headers), hidden rows (columns) are not moved, a
// formula moves as a copy would (its relative references follow it, absolute ones stay), each cell takes its format
// with it, and its note, threaded comment and hyperlink go along (sortAnnotations.ts); tables do not sort left to
// right. Merged cells move with their line when all of them are the same size (Excel refuses others: "all the merged
// cells need to be the same size") and each lies on one line. What cannot move with its cells is refused rather than
// left behind: other merged cells, array formulas, pivot tables, a part of a table or its header, a hyperlink over
// more than one moved line, and conditional formats, validations or other ranges that cover the sorted lines
// unevenly. A sort of the sheet's autofilter (or a table's) writes its sort state there (§18.3.1.92).

// The most keys a sort takes (Excel's Sort dialog).
export const MAX_SORT_KEYS = 64

// Cells written per store batch: a batch rebuilds each block it touches once.
const WRITE_BATCH = 32_768

// Moved cells the formula engine is given per part, its evaluation held: the work yields between parts once its
// slice is up, and everything is recalculated once at the end.
const ENGINE_PART = 4_096

interface SortCells {
	// Per moved line (row, or column for a left-to-right sort), its cells' positions along the other axis and slots,
	// from lineStarts[i] to lineStarts[i + 1].
	readonly lineStarts: Int32Array
	readonly positions: Int32Array
	// Store slots reach past 2^31 from block 128 on (SLOT_BLOCK): doubles hold them exactly.
	readonly slots: Float64Array
}

// Ranges anchored to cells that must cover the sorted lines evenly (a moved cell keeps what covers it only then).
function evenlyCovered(range: SheetRange, area: SheetRange, rows: boolean): boolean {
	if (!intersects(range, area)) return true

	return rows
		? range.startRow <= area.startRow && range.endRow >= area.endRow
		: range.startCol <= area.startCol && range.endCol >= area.endCol
}

// The merges that meet `span` (the moved lines over the sorted range's width), or why they cannot move with their
// lines: Excel sorts merged cells only when all are the same size; here each must also lie on one line, within the
// sorted range.
function sortedMerges(model: XlsxSheetModel, span: SheetRange, rows: boolean): number[] | SheetRefusal {
	const met: number[] = []
	let size: string | null = null

	for (let k = 0; k + 3 < model.merges.length; k += 4) {
		const merge = {
			startRow: model.merges[k] ?? 0,
			startCol: model.merges[k + 1] ?? 0,
			endRow: model.merges[k + 2] ?? 0,
			endCol: model.merges[k + 3] ?? 0
		}

		if (!intersects(merge, span)) continue

		const shape = `${String(merge.endRow - merge.startRow)},${String(merge.endCol - merge.startCol)}`

		if (size !== null && shape !== size) return { reason: "merged", detail: "mergeSize" }

		size = shape

		if (!contains(span, merge) || (rows ? merge.startRow !== merge.endRow : merge.startCol !== merge.endCol))
			return { reason: "merged" }

		met.push(k)
	}

	return met
}

// The merges after a sort: those at `met` (indices into `merges`) on a moved line go with it.
function movedMerges(merges: Uint32Array, met: readonly number[], targets: ReadonlyMap<number, number>, rows: boolean): Uint32Array {
	const out = merges.slice()

	for (const k of met) {
		const target = targets.get(merges[rows ? k : k + 1] ?? 0)

		if (target === undefined) continue

		out[rows ? k : k + 1] = target
		out[rows ? k + 2 : k + 3] = target
	}

	return out
}

// Why the sorted area cannot move, or null. `area` is the moved lines' extent.
async function sortRefusal(
	document: XlsxDocument,
	model: XlsxSheetModel,
	area: SheetRange,
	rows: boolean,
	tables: readonly FilterTable[]
): Promise<SheetRefusal | null> {
	const store = model.store as SheetStore
	const sheet = model.id

	const formulas = store.formulas

	for (let id = 0; id < formulas.length; id++) {
		const kind = formulas.kind(id)

		if (kind !== FormulaKind.ARRAY && kind !== FormulaKind.DATA_TABLE) continue

		const ref = formulas.formula(id).ref

		if (ref !== null && intersects(ref, area) && store.formula(store.locate(ref.startRow, ref.startCol)) === id)
			return { reason: "arrayFormula" }
	}

	let dynamic = false

	store.forEachCell(area, (_row, _col, slot) => {
		const id = store.formula(slot)

		if (id >= 0 && (formulas.kind(id) === FormulaKind.ARRAY || formulas.formula(id).cellMetadata >= 0)) dynamic = true
	})

	if (dynamic) return { reason: "arrayFormula" }

	for (const table of tables) {
		if (!intersects(table.info.ref, area)) continue

		const body = tableBody(table)

		if (body === null || !contains(body, area)) {
			const header = { ...table.info.ref, endRow: table.info.ref.startRow + Math.max(0, table.info.headerRows) - 1 }

			return { reason: table.info.headerRows > 0 && intersects(header, area) ? "tableHeader" : "structureLocked", detail: "tables" }
		}

		if (!rows) return { reason: "unsupported", detail: "tableColumns" }
	}

	const state = refState(document.workbook)

	try {
		// Conditional formats and validations, and in extLst the x14 ones and sparkline locations: a range list that
		// does not read may cover anything.
		for (const section of ["conditionalFormatting", "dataValidations", "extLst"] as const)
			for (const markup of state.sectionMarkup(model, section))
				for (const sqref of sectionSqrefs(section, markup)) {
					const ranges = parseSqref(sqref)

					if (ranges === null || !ranges.every(range => evenlyCovered(range, area, rows)))
						return { reason: "structureLocked", detail: section }
				}

		for (const relationship of liveRelationships(document.workbook, model.part, model.relationships.all)) {
			if (relationship.external || relationship.partName === undefined) continue

			if (!relationship.type.endsWith("/pivotTable")) continue

			const bytes = await state.partBytes(relationship.partName)

			if (bytes === null) continue

			for (const match of decodeUtf8(bytes).matchAll(/<(?:\w+:)?location\b[^>]*\sref="([^"]*)"/g)) {
				const location = parseRef(match[1] ?? "")

				if (location === null || intersects(location, area)) return { reason: "pivot" }
			}
		}
	} catch (error) {
		if (error instanceof RefRefused) return error.refusal

		throw error
	}

	if (model.protection !== null) {
		// Locked cells cannot be sorted on a protected sheet, whatever it allows.
		for (let row = area.startRow; row <= area.endRow; row++)
			for (let col = area.startCol; col <= area.endCol; col++)
				if (document.locked(sheet, row, col)) return { reason: "protectedSheet", detail: "sort" }
	}

	return null
}

function hiddenCol(model: XlsxSheetModel, col: number): boolean {
	return model.cols.some(range => col >= range.first && col <= range.last && (range.flags & ColFlag.HIDDEN) !== 0)
}

// The area's cells by line: one pass over the store, positions ascending within each line.
function gatherCells(store: SheetStore, area: SheetRange, rows: boolean, lineCount: number): SortCells {
	const first = rows ? area.startRow : area.startCol
	const counts = new Int32Array(lineCount + 1)

	store.forEachCell(area, (row, col) => {
		const line = (rows ? row : col) - first + 1

		counts[line] = (counts[line] ?? 0) + 1
	})

	for (let i = 1; i <= lineCount; i++) counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0)

	const total = counts[lineCount] ?? 0
	const positions = new Int32Array(total)
	const slots = new Float64Array(total)
	const fill = counts.slice(0, lineCount)

	store.forEachCell(area, (row, col, slot) => {
		const line = (rows ? row : col) - first
		const at = fill[line] ?? 0

		fill[line] = at + 1

		positions[at] = rows ? col : row
		slots[at] = slot
	})

	return { lineStarts: counts, positions, slots }
}

// The slot of a line's cell at `position`, or -1.
function slotAt(cells: SortCells, line: number, position: number): number {
	let low = cells.lineStarts[line] ?? 0
	let high = cells.lineStarts[line + 1] ?? 0

	while (low < high) {
		const mid = (low + high) >>> 1

		if ((cells.positions[mid] ?? 0) < position) low = mid + 1
		else high = mid
	}

	return low < (cells.lineStarts[line + 1] ?? 0) && cells.positions[low] === position ? (cells.slots[low] ?? -1) : -1
}

// The sort state a sort of `range` writes: on the sheet's autofilter or a table whose range it sorts (the data rows
// below the header), or none.
function sortStateEdit(
	document: XlsxDocument,
	model: XlsxSheetModel,
	tables: readonly FilterTable[],
	command: SheetCommandOf<"sort.apply">,
	area: SheetRange
): SortStateEdit | null {
	if (command.orientation !== "rows") return null

	for (const target of filterTargets(document, model, tables)) {
		const data = { ...target.range, startRow: target.range.startRow + 1 }

		if (
			data.startRow > data.endRow ||
			area.startRow !== data.startRow ||
			area.startCol !== data.startCol ||
			area.endCol !== data.endCol
		)
			continue
		if (area.endRow > data.endRow) continue

		const markup = sortStateMarkup(target.filter.prefix, {
			ref: data,
			caseSensitive: command.caseSensitive,
			columnSort: false,
			conditions: command.keys.map(key => ({ ref: { ...data, startCol: key.index, endCol: key.index }, descending: key.descending }))
		})

		return sortStateParts(document, model, target, markup)
	}

	for (const table of tables) {
		const body = tableBody(table)

		if (body === null || !contains(body, area) || body.startCol !== area.startCol || body.endCol !== area.endCol) continue

		const markup = sortStateMarkup(table.prefix, {
			ref: body,
			caseSensitive: command.caseSensitive,
			columnSort: false,
			conditions: command.keys.map(key => ({ ref: { ...body, startCol: key.index, endCol: key.index }, descending: key.descending }))
		})

		return sortStateParts(document, model, { table, filter: table.filter, range: body }, markup)
	}

	return null
}

export async function sortRange(
	document: XlsxDocument,
	command: SheetCommandOf<"sort.apply">,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const { sheet, range, orientation, header, caseSensitive, keys } = command
	const rows = orientation === "rows"

	if (
		!Number.isInteger(range.startRow) ||
		!Number.isInteger(range.endRow) ||
		!Number.isInteger(range.startCol) ||
		!Number.isInteger(range.endCol) ||
		range.startRow < 0 ||
		range.startCol < 0 ||
		range.endRow >= SHEET_MAX_ROWS ||
		range.endCol >= SHEET_MAX_COLS ||
		range.startRow > range.endRow ||
		range.startCol > range.endCol
	)
		return { refused: { reason: "tooLarge" } }

	if (keys.length === 0 || keys.length > MAX_SORT_KEYS) return { refused: { reason: "unsupported", detail: "sortKeys" } }

	for (const key of keys) {
		const inside = rows
			? key.index >= range.startCol && key.index <= range.endCol
			: key.index >= range.startRow && key.index <= range.endRow

		if (!Number.isInteger(key.index) || !inside) return { refused: { reason: "unsupported", detail: "sortKeys" } }
	}

	const model = await document.ready(sheet, slicing)
	const store = model.store as SheetStore
	let tables: FilterTable[]

	try {
		tables = await loadTables(document, model)
	} catch (error) {
		if (error instanceof RefRefused) return { refused: error.refusal }

		throw error
	}

	// The lines that move: past the header, and no further than the store holds anything (the rest are blank and
	// stay last).
	const firstLine = (rows ? range.startRow : range.startCol) + (header ? 1 : 0)
	const lastLine = Math.min(rows ? range.endRow : range.endCol, (rows ? store.rowExtent : store.colExtent) - 1)
	const area: SheetRange = rows
		? {
				startRow: firstLine,
				endRow: lastLine,
				startCol: range.startCol,
				endCol: Math.min(range.endCol, Math.max(range.startCol, store.colExtent - 1))
			}
		: {
				startCol: firstLine,
				endCol: lastLine,
				startRow: range.startRow,
				endRow: Math.min(range.endRow, Math.max(range.startRow, store.rowExtent - 1))
			}
	const stateEdit = lastLine < firstLine ? null : sortStateEdit(document, model, tables, command, area)

	if (lastLine < firstLine) return null

	const refusal = await sortRefusal(document, model, area, rows, tables)

	if (refusal !== null) return { refused: refusal }

	// The moved lines over the range's whole width: what lies on a line there (a merge, a note on a blank cell) moves
	// with it.
	const span: SheetRange = rows
		? { startRow: firstLine, endRow: lastLine, startCol: range.startCol, endCol: range.endCol }
		: { startCol: firstLine, endCol: lastLine, startRow: range.startRow, endRow: range.endRow }
	const merged = sortedMerges(model, span, rows)

	if (!Array.isArray(merged)) return { refused: merged }

	// Hidden lines stay where they are; the visible ones are sorted among the visible places.
	const lineCount = lastLine - firstLine + 1
	const visible: number[] = []

	for (let line = 0; line < lineCount; line++) {
		const index = firstLine + line
		const hidden = rows ? (rowState(store, index).flags & RowFlag.HIDDEN) !== 0 : hiddenCol(model, index)

		if (!hidden) visible.push(line)
	}

	let cells = gatherCells(store, area, rows, lineCount)
	const valueOf = (line: number, position: number): SortValue => {
		const slot = slotAt(cells, line, position)

		if (slot < 0) return BLANK_SORT_VALUE

		const row = rows ? firstLine + line : position
		const col = rows ? position : firstLine + line

		return sortValueOf(readCell(document, model, row, col, slot, false), caseSensitive)
	}
	const order = sortOrder(visible.length, keys, (key, item) => valueOf(visible[item] ?? 0, keys[key]?.index ?? 0))
	// The line each visible place takes its cells from.
	const moves: number[] = []

	for (let k = 0; k < visible.length; k++) {
		const target = visible[k] ?? 0
		const source = visible[order[k] ?? k] ?? 0

		if (source !== target) moves.push(target, source)
	}

	if (moves.length === 0 && stateEdit === null) return null

	const targets = new Map<number, number>()

	for (let k = 0; k < moves.length; k += 2) targets.set(firstLine + (moves[k + 1] ?? 0), firstLine + (moves[k] ?? 0))

	const annotations = moves.length === 0 ? null : await moveAnnotations(document, model, { rows, span, targets })

	if (annotations !== null && "refused" in annotations) return annotations

	const mergesBefore = model.merges
	const mergesAfter = merged.length === 0 || moves.length === 0 ? mergesBefore : movedMerges(mergesBefore, merged, targets, rows)
	const setMerges = (value: Uint32Array, sink: SheetChangeSink): void => {
		if (mergesAfter === mergesBefore) return

		model.merges = value
		document.workbook.changes.sheetSection(sheet, "mergeCells")
		sink.layout(sheet)
	}

	// Built from the cells as they stand before the sort, so the sort is what it recalculates.
	if (moves.length > 0 && document.engine === null && document.allReady && document.hasFormulas) {
		await document.loadTables()
		document.buildEngine(changes)
	}

	const before = new StoreSnapshot(store, true)
	const shownBefore = new Map(document.shownResults.get(sheet) ?? [])
	let formulas = false

	if (moves.length > 0) {
		// A shared formula a moved cell belongs to becomes formulas of their own first (its master or a child moving
		// would leave the others reading a master that is not there).
		const masters = new Set<number>()

		store.forEachCell(area, (_row, _col, slot) => {
			const id = store.formula(slot)

			if (id >= 0 && (store.formulas.kind(id) === FormulaKind.SHARED_CHILD || store.formulas.kind(id) === FormulaKind.SHARED_MASTER))
				masters.add(store.formulas.sharedIndex(id))
		})

		if (masters.size > 0) {
			const scratch = new CellLog()

			for (let id = 0; id < store.formulas.length; id++) {
				if (store.formulas.kind(id) !== FormulaKind.SHARED_MASTER || !masters.has(store.formulas.sharedIndex(id))) continue

				const ref = store.formulas.formula(id).ref

				if (ref === null) continue

				store.forEachCell(ref, (row, col, slot) => {
					if (store.formula(slot) === id) unshare(document, sheet, row, col, scratch)
				})
			}

			cells = gatherCells(store, area, rows, lineCount)
		}

		formulas = await writeMoves(document, model, cells, moves, rows, firstLine, slicing === undefined ? undefined : sliceClock(slicing))
		document.workbook.changes.sheetRows(sheet)

		if (formulas) document.workbook.changes.formulasChanged()
	}

	const after = new StoreSnapshot(store, true)
	const shownAfter = new Map(document.shownResults.get(sheet) ?? [])
	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	// The moved lines over the area, consecutive ones as one range (moves go by target, ascending).
	const movedAreas = (): SheetRange[] => {
		const out: SheetRange[] = []
		let start = -1
		let end = -1
		const push = (): void => {
			if (start < 0) return

			out.push(
				rows
					? { startRow: start, endRow: end, startCol: area.startCol, endCol: area.endCol }
					: { startRow: area.startRow, endRow: area.endRow, startCol: start, endCol: end }
			)
		}

		for (let k = 0; k < moves.length; k += 2) {
			const line = firstLine + (moves[k] ?? 0)

			if (line === end + 1 && start >= 0) {
				end = line

				continue
			}

			push()
			start = line
			end = line
		}

		push()

		return out
	}
	// Gives the engine the moved lines' cells as they now stand in parts of ENGINE_PART, each built as it goes,
	// yielding between them, and recalculates once: a total over the moved rows is worked out once, not once per
	// part. What it recalculated (when `report`), or none when it failed (dropped, built again when next needed).
	const engineInParts = async (report: boolean): Promise<RecalculatedCell[]> => {
		const engine = document.engine
		const index = document.engineIndex(sheet)

		if (engine === null || index < 0) return []

		const from = rows ? area.startCol : area.startRow
		const to = rows ? area.endCol : area.endRow

		try {
			engine.holdEvaluation()

			let part: EngineCell[] = []

			for (let k = 0; k < moves.length; k += 2) {
				const line = firstLine + (moves[k] ?? 0)

				for (let position = from; position <= to; position++) {
					part.push(rows ? document.engineCell(model, line, position) : document.engineCell(model, position, line))

					if (part.length < ENGINE_PART) continue

					engine.set(index, part)
					part = []

					if (clock?.due === true) await clock.pause()
				}
			}

			if (part.length > 0) engine.set(index, part)

			return await engine.releaseEvaluation(report, clock)
		} catch {
			document.dropEngine()

			return []
		}
	}
	// What the moves made the formula engine recalculate (dependents anywhere, moved formulas included): logged, so
	// undo and redo put the results back as they were rather than working them out again.
	const results = new CellLog()

	if (moves.length > 0 && document.engine !== null)
		document.applyRecalculated(sheet, movedAreas(), await engineInParts(true), results, changes)

	results.seal((s, r, c) => document.state(s, r, c))

	const setShown = (shown: ReadonlyMap<number, ShownResult>): void => {
		if (shown.size === 0) document.shownResults.delete(sheet)
		else document.shownResults.set(sheet, new Map(shown))
	}
	// The engine takes the moved cells as they now stand; its results are the log's (not read back).
	const syncEngine = async (): Promise<void> => {
		if (moves.length > 0 && document.engine !== null) await engineInParts(false)
	}
	const report = (sink: SheetChangeSink): void => {
		if (moves.length > 0) sink.content(sheet, area)

		reportLogged(results, sink, "content")
	}

	if (stateEdit !== null) stateEdit.apply("after", changes)

	setMerges(mergesAfter, changes)

	// Notes shown all the time are the layout's.
	if (annotations !== null) changes.layout(sheet)

	report(changes)

	let bytes =
		(stateEdit?.bytes ?? 0) + before.bytes + after.bytes + results.bytes + (annotations?.bytes ?? 0) + mergesAfter.byteLength * 2

	// The blocks the sort replaced stay with the step (its undo gives them back).
	for (let k = 0; k < moves.length; k += 2) bytes += ((rows ? area.endCol - area.startCol : area.endRow - area.startRow) + 1) * 24

	return {
		bytes,
		undo: async sink => {
			if (moves.length > 0) {
				before.restore(store)
				setShown(shownBefore)
				document.workbook.changes.sheetRows(sheet)
			}

			// The sheet's cells came back with the store (only moves log results), shared formulas the sort unshared
			// outside the range too, which the log holds unshared; other sheets' recalculated cells are put back.
			for (let i = results.size - 1; i >= 0; i--) {
				const state = results.before[i]
				const at = results.sheets[i] ?? 0

				if (state !== undefined && at !== sheet) document.restoreCell(at, results.rows[i] ?? 0, results.cols[i] ?? 0, state)
			}

			await syncEngine()
			stateEdit?.apply("before", sink)
			setMerges(mergesBefore, sink)

			if (annotations !== null) {
				annotations.undo()
				sink.layout(sheet)
			}

			report(sink)
		},
		redo: async sink => {
			if (moves.length > 0) {
				after.restore(store)
				setShown(shownAfter)
				document.workbook.changes.sheetRows(sheet)
			}

			results.restore(document.restoreCell, "after")
			await syncEngine()
			stateEdit?.apply("after", sink)
			setMerges(mergesAfter, sink)

			if (annotations !== null) {
				annotations.redo()
				sink.layout(sheet)
			}

			report(sink)
		}
	}
}

// Writes each moved line's cells where they go (`moves`: target, source pairs of lines), in store batches: every
// source is read before anything is written. Yields between lines and batches once the slice is up. Returns whether
// a formula moved.
async function writeMoves(
	document: XlsxDocument,
	model: XlsxSheetModel,
	cells: SortCells,
	moves: readonly number[],
	rows: boolean,
	firstLine: number,
	clock: SliceClock | undefined
): Promise<boolean> {
	const store = model.store as SheetStore
	const sheet = model.id
	const shown = document.shownResults.get(sheet)
	const moved = new Map<number, ShownResult>()
	const vacated: number[] = []
	const formulaTexts = new Map<number, (rows: number, cols: number) => string>()
	let formulas = false
	let total = 0

	for (let k = 0; k < moves.length; k += 2) {
		const source = moves[k + 1] ?? 0

		total += (cells.lineStarts[source + 1] ?? 0) - (cells.lineStarts[source] ?? 0)
	}

	const kinds = new Uint8Array(total)
	const values = new Float64Array(total)
	const styles = new Uint32Array(total)
	const ids = new Int32Array(total)
	const origins = new Uint32Array(total)
	const targetRows = new Uint32Array(total)
	const targetCols = new Uint32Array(total)
	let n = 0

	// Every source cell's state, read once before any write.
	for (let k = 0; k < moves.length; k += 2) {
		const target = moves[k] ?? 0
		const source = moves[k + 1] ?? 0
		const delta = target - source

		for (let at = cells.lineStarts[source] ?? 0; at < (cells.lineStarts[source + 1] ?? 0); at++) {
			const slot = cells.slots[at] ?? -1
			const position = cells.positions[at] ?? 0
			const block = store.blocks[Math.floor(slot / SLOT_BLOCK)]
			const index = slot % SLOT_BLOCK

			if (block === undefined) continue

			const id = block.formulas?.[index] ?? -1
			let formula = id

			if (id >= 0) {
				const sourceRow = rows ? firstLine + source : position
				const sourceCol = rows ? position : firstLine + source
				let translate = formulaTexts.get(id)

				if (translate === undefined) {
					translate = formulaTranslator(document.formulaText(model, id, sourceRow, sourceCol))

					if (store.formulas.kind(id) === FormulaKind.NORMAL) formulaTexts.set(id, translate)
				}

				formula = store.formulas.add({
					kind: FormulaKind.NORMAL,
					text: translate(rows ? delta : 0, rows ? 0 : delta),
					sharedIndex: -1,
					ref: null,
					flags: store.formulas.formula(id).flags,
					cellMetadata: -1
				})
				formulas = true
			}

			// A source cell with markup the model does not hold (a picture in the cell, rich runs) carries it along;
			// any other leaves its position's source cell behind (origin 0).
			const origin = store.origin(slot)
			const carried = origin < CARRIED && store.carriesMarkup(slot) ? store.sourceCell(slot, model.part) : null

			targetRows[n] = rows ? firstLine + target : position
			targetCols[n] = rows ? position : firstLine + target
			kinds[n] = block.kinds[index] ?? 0
			values[n] = block.values[index] ?? 0
			styles[n] = block.styles[index] ?? 0
			ids[n] = formula
			origins[n] = origin >= CARRIED ? origin : carried === null ? 0 : store.carry(carried)

			if (shown !== undefined) {
				const result = shown.get(cellKeyOf(rows ? firstLine + source : position, rows ? position : firstLine + source))

				if (result !== undefined) moved.set(cellKeyOf(targetRows[n] ?? 0, targetCols[n] ?? 0), result)
			}

			n++
		}

		// The target line's cells that no source cell replaces go.
		for (let at = cells.lineStarts[target] ?? 0; at < (cells.lineStarts[target + 1] ?? 0); at++) {
			const position = cells.positions[at] ?? 0

			if (slotAt(cells, source, position) < 0)
				vacated.push(rows ? firstLine + target : position, rows ? position : firstLine + target)
		}

		if (clock?.due === true) await clock.pause()
	}

	let batch: CellWrite[] = []
	const flush = async (): Promise<void> => {
		store.setCells(batch)
		batch = []

		if (clock?.due === true) await clock.pause()
	}

	for (let i = 0; i < vacated.length; i += 2) {
		batch.push({ row: vacated[i] ?? 0, col: vacated[i + 1] ?? 0, kind: CellKind.EMPTY, value: 0, style: 0, formula: -1, origin: -1 })

		if (batch.length >= WRITE_BATCH) await flush()
	}

	for (let i = 0; i < n; i++) {
		batch.push({
			row: targetRows[i] ?? 0,
			col: targetCols[i] ?? 0,
			kind: (kinds[i] ?? 0) as CellKind,
			value: values[i] ?? 0,
			style: styles[i] ?? 0,
			formula: ids[i] ?? -1,
			origin: origins[i] ?? 0
		})

		if (batch.length >= WRITE_BATCH) await flush()
	}

	await flush()

	// Shown results follow their cells.
	if (shown !== undefined || moved.size > 0) {
		const next = new Map(shown ?? [])

		for (let k = 0; k < moves.length; k += 2) {
			const target = moves[k] ?? 0

			for (let at = cells.lineStarts[target] ?? 0; at < (cells.lineStarts[target + 1] ?? 0); at++) {
				const position = cells.positions[at] ?? 0

				next.delete(cellKeyOf(rows ? firstLine + target : position, rows ? position : firstLine + target))
			}
		}

		for (const [key, result] of moved) next.set(key, result)

		if (next.size === 0) document.shownResults.delete(sheet)
		else document.shownResults.set(sheet, next)
	}

	return formulas
}

export const sortFeature = defineSheetFeature<XlsxDocument>({
	id: "sort",
	commands: {
		"sort.apply": {
			info: { write: true, protection: "sort" },
			run: (context, command) => sortRange(context.doc, command, context.changes, context.slicing)
		}
	}
})
