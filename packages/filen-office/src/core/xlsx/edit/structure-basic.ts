import { Relationships } from "../../opc/relationships"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import { SHEET_MAX_COLS, SHEET_MAX_EDIT_CELLS, SHEET_MAX_ROWS, type SheetAxis, type SheetId, type SheetRefusal } from "../../sheet/protocol"
import { defaultColWidth } from "../../sheet/sizes/sizes"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import type { AxisEdit } from "../../sheet/model/edits"
import { sameSheet } from "../../sheet/refs/formulaRefs"
import { ChangeLog } from "../model/changes"
import { FormulaTable } from "../model/formulas"
import { BLOCK_ROWS, SheetStore, type CellWrite, type RowProperties } from "../model/store"
import { SheetStrings } from "../model/strings"
import { CellKind, RowFlag, type XlsxSheetEntry, type XlsxSheetModel } from "../model/types"
import { XlsxSheet } from "../read/index"
import { preimage, type AxisShift } from "../refs/axis"
import { planRefEdit, type RefPlan } from "../refs/plan"
import { relationshipType } from "../write/index"
import type { XlsxDocument } from "./document"
import { StyleLimitError, appendXf, reportLogged } from "./format"
import type { RecalculatedCell } from "../../sheet/formula/index"
import { CellLog, rowState, type CellState } from "./history"

// Rows and columns inserted or deleted, and sheets added and renamed. Every construct that refers to cells moves
// through the references catalogue (refs/plan.ts), or the edit is refused with the construct that cannot move.

const SHEET_NAME = /^[^\\/?*[\]:]{1,31}$/

function locked(detail: string): { refused: SheetRefusal } {
	return { refused: { reason: "structureLocked", detail } }
}

export function engineSet(document: XlsxDocument, sheet: SheetId, cells: readonly { row: number; col: number }[]): void {
	const engine = document.engine
	const model = document.model(sheet)
	const index = document.engineIndex(sheet)

	if (engine === null || model === null || index < 0 || cells.length === 0) return

	document.guarded(() =>
		engine.set(
			index,
			cells.map(cell => document.engineCell(model, cell.row, cell.col))
		)
	)
}

// A sheet's cells whose formula a plan changed, at their positions after it.
export function planCellsOf(plan: RefPlan, sheet: SheetId): { row: number; col: number }[] {
	const pairs = plan.formulaCells.get(sheet) ?? []
	const cells: { row: number; col: number }[] = []

	for (let k = 0; k + 1 < pairs.length; k += 2) cells.push({ row: pairs[k] ?? 0, col: pairs[k + 1] ?? 0 })

	return cells
}

// The bounds of the cells `keep` takes.
export function cellBounds(
	cells: readonly { row: number; col: number }[],
	keep: (row: number, col: number) => boolean = () => true
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
	let startRow = Infinity
	let startCol = Infinity
	let endRow = -1
	let endCol = -1

	for (const { row, col } of cells) {
		if (!keep(row, col)) continue

		startRow = Math.min(startRow, row)
		endRow = Math.max(endRow, row)
		startCol = Math.min(startCol, col)
		endCol = Math.max(endCol, col)
	}

	return endRow < 0 ? null : { startRow, startCol, endRow, endCol }
}

export function planBytes(plan: RefPlan): number {
	let cells = 0

	for (const pairs of plan.formulaCells.values()) cells += pairs.length

	return 1024 + cells * 48
}

// axis.insert and axis.delete.
export async function moveAxis(
	document: XlsxDocument,
	sheet: SheetId,
	axis: SheetAxis,
	type: "insert" | "delete",
	at: number,
	count: number,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const target = document.entry(sheet)
	const limit = axis === "rows" ? SHEET_MAX_ROWS : SHEET_MAX_COLS

	if (target === undefined || target.kind !== "worksheet") return locked("sheet")
	if (!Number.isInteger(at) || !Number.isInteger(count) || at < 0 || count <= 0 || at + count > limit)
		return { refused: { reason: "tooLarge" } }

	const action = type === "insert" ? (axis === "rows" ? "insertRows" : "insertColumns") : axis === "rows" ? "deleteRows" : "deleteColumns"
	const protection = document.protects(sheet, action)

	if (protection !== null) return { refused: protection }

	await document.readyAllSheets()

	if (!document.allReady) return locked("unreadSheet")

	const model = target.model as XlsxSheetModel
	const store = model.store as SheetStore

	// Excel will not push cells off the sheet (nor would an undo bring them back).
	if (type === "insert" && (axis === "rows" ? store.rowExtent : store.colExtent) + count > limit)
		return { refused: { reason: "tooLarge", detail: "cells" } }

	const edit: AxisShift = { type, axis, at, count }
	const index = document.engineIndex(sheet)
	const engine = document.engine
	const engineRefusal = engine === null || index < 0 ? null : engine.moveRefusal(index, edit)

	if (engineRefusal === "spill") return { refused: { reason: "arrayFormula", detail: "spill" } }
	if (engineRefusal === "tooLarge") return { refused: { reason: "tooLarge", detail: "engine" } }

	const planned = await planRefEdit(document.workbook, { kind: "axis", sheet, shift: edit })

	if (!planned.ok) return { refused: planned.refusal }

	const plan = planned.plan

	// The cells a deletion takes: given back to the engine on undo.
	const removed: { row: number; col: number }[] = []

	if (type === "delete") {
		const range =
			axis === "rows"
				? { startRow: at, startCol: 0, endRow: at + count - 1, endCol: SHEET_MAX_COLS - 1 }
				: { startRow: 0, startCol: at, endRow: SHEET_MAX_ROWS - 1, endCol: at + count - 1 }

		store.forEachCell(range, (row, col, slot) => {
			if (store.formula(slot) >= 0 || store.kind(slot) !== CellKind.EMPTY) removed.push({ row, col })
		})
	}

	const post = new CellLog()
	const inverse: AxisEdit = { type: type === "insert" ? "delete" : "insert", axis, at, count }
	const forward = (): void => {
		plan.apply()
		document.shiftShown(sheet, edit)
		document.structureChanged()
	}
	const engineForward = async (clock: SliceClock | undefined): Promise<RecalculatedCell[]> =>
		engine === null || index < 0
			? []
			: await document.guardedSliced(() =>
					type === "insert"
						? engine.insertSliced(index, axis, at, count, clock)
						: engine.removeSliced(index, axis, at, count, clock)
				)
	const report = (sink: SheetChangeSink): void => {
		for (const [formulaSheet] of plan.formulaCells) {
			// On the edited sheet, cells past `at` are in the moved region, which `moved` invalidates.
			const bounds = cellBounds(
				planCellsOf(plan, formulaSheet),
				(row, col) => formulaSheet !== sheet || (axis === "rows" ? row : col) < at
			)

			if (bounds !== null) sink.content(formulaSheet, bounds)
		}

		reportLogged(post, sink, "content")
		sink.moved(sheet, axis, at, type === "insert" ? count : -count)
		sink.layout(sheet)
	}

	const clockOf = (): SliceClock | undefined => (slicing === undefined ? undefined : sliceClock(slicing))
	const turn = async (clock: SliceClock | undefined): Promise<void> => {
		if (clock?.due === true) await clock.pause()
	}
	// Before the engine's own move, one indivisible call: a turn whatever the slice holds, so it runs in a task of its
	// own and our work around it never shares one with it.
	const turnBeforeEngine = async (clock: SliceClock | undefined): Promise<void> => {
		if (clock !== undefined && engine !== null && index >= 0) await clock.pause()
	}
	const clock = clockOf()

	await turn(clock)
	forward()

	const inherited = type === "insert" ? await inheritFormat(document, sheet, model, axis, at, count, post, clock) : null

	await document.loadTables()
	await turnBeforeEngine(clock)
	await document.applySliced(await engineForward(clock), post, changes, clock)
	await sealSliced(document, post, clock)
	report(changes)

	return {
		bytes: planBytes(plan) + post.bytes + removed.length * 16 + (inherited?.bytes ?? 0),
		undo: async sink => {
			const clock = clockOf()

			await document.restoreLogSliced(post, "before", clock)
			inherited?.revert()
			plan.revert()
			document.shiftShown(sheet, inverse)
			document.structureChanged()
			await document.loadTables()
			await turn(clock)

			const live = document.engine

			if (clock !== undefined && live !== null && index >= 0) await clock.pause()

			if (live !== null && index >= 0) {
				await document.guardedSliced(() =>
					type === "insert" ? live.removeSliced(index, axis, at, count, clock) : live.insertSliced(index, axis, at, count, clock)
				)

				if (type === "delete") {
					engineSet(document, sheet, removed)

					// A deletion's #REF! does not come back with the rows: the engine gets the formulas again, where they
					// were before the edit.
					for (const [formulaSheet] of plan.formulaCells) {
						const cells = planCellsOf(plan, formulaSheet)

						engineSet(
							document,
							formulaSheet,
							formulaSheet === sheet
								? cells.map(cell =>
										axis === "rows"
											? { row: preimage(cell.row, edit), col: cell.col }
											: { row: cell.row, col: preimage(cell.col, edit) }
									)
								: cells
						)
					}
				}
			}

			report(sink)
		},
		redo: async sink => {
			const clock = clockOf()

			await turn(clock)
			forward()
			await inherited?.apply(clock)
			await document.loadTables()
			await turnBeforeEngine(clock)
			await engineForward(clock)
			await document.restoreLogSliced(post, "after", clock)
			report(sink)
		}
	}
}

// What an insert takes from its neighbour besides cells: the axis format, put again on redo, taken back on undo
// before the plan's revert.
interface InheritedFormat {
	readonly bytes: number
	apply(clock: SliceClock | undefined): Promise<void>
	revert(): void
}

// Cells written to the store at once.
const INHERIT_BATCH = 1024

// Excel's Insert Options default: inserted rows (columns) take the format of the row above (column to the left), of
// the one below (to the right) at the sheet's first. The axis format is copied, and a cell of the neighbour whose
// format differs from what an empty cell of the new line shows gets an empty cell of that format in each new line;
// values, heights, widths and hidden state stay. Past the edit's cell limit only the axis format is copied. Called
// after the plan's shift; the cells go into `log`.
async function inheritFormat(
	document: XlsxDocument,
	sheet: SheetId,
	model: XlsxSheetModel,
	axis: SheetAxis,
	at: number,
	count: number,
	log: CellLog,
	clock: SliceClock | undefined
): Promise<InheritedFormat | null> {
	const store = model.store as SheetStore
	const rows = axis === "rows"
	const source = at > 0 ? at - 1 : at + count
	const end = at + count

	if (source >= (rows ? SHEET_MAX_ROWS : SHEET_MAX_COLS)) return null

	const pause = async (): Promise<void> => {
		if (clock?.due === true) await clock.pause()
	}
	let budget = SHEET_MAX_EDIT_CELLS
	let bytes = 0
	let apply: (clock: SliceClock | undefined) => Promise<void> = () => Promise.resolve()
	let revert = (): void => undefined

	if (rows) {
		const state = rowState(store, source)

		if ((state.flags & RowFlag.CUSTOM_FORMAT) !== 0 && state.style >= 0 && count <= budget) {
			const style = state.style

			budget -= count
			bytes += count * 16
			apply = async clock => {
				for (let from = at; from < end; from += BLOCK_ROWS) {
					const batch: RowProperties[] = []

					for (let row = from; row < Math.min(end, from + BLOCK_ROWS); row++)
						batch.push({ row, height: Number.NaN, style, flags: RowFlag.CUSTOM_FORMAT })

					store.setRows(batch)

					if (clock?.due === true) await clock.pause()
				}

				document.workbook.changes.sheetRows(sheet)
			}
		}
	} else {
		const shifted = model.cols
		const range = shifted.find(entry => source >= entry.first && source <= entry.last)

		// An insert inside a column range widens it: the new columns have its format already.
		if (range !== undefined && range.style >= 0 && !shifted.some(entry => entry.first < end && entry.last >= at)) {
			const next = [
				...shifted,
				{ first: at, last: end - 1, width: defaultColWidth(model.format, document.digitPx), style: range.style, flags: 0 }
			].sort((a, b) => a.first - b.first)

			bytes += 64
			apply = () => {
				model.cols = next
				document.workbook.changes.sheetSection(sheet, "cols")

				return Promise.resolve()
			}
			revert = () => {
				model.cols = shifted
			}
		}
	}

	await apply(clock)

	// The neighbour's cells whose format the new lines would not show: (position across, format) pairs.
	const copied: number[] = []
	let fits = true

	store.forEachCell(
		rows
			? { startRow: source, startCol: 0, endRow: source, endCol: SHEET_MAX_COLS - 1 }
			: { startRow: 0, startCol: source, endRow: SHEET_MAX_ROWS - 1, endCol: source },
		(row, col, slot) => {
			if (!fits) return

			const style = store.style(slot)

			if (style === (rows ? document.startingStyle(model, at, col) : document.startingStyle(model, row, at))) return

			copied.push(rows ? col : row, style)
			fits = (copied.length / 2) * count <= budget
		}
	)

	if (!fits || copied.length === 0) return { bytes, apply, revert }

	// A default-format cell without content is no cell: a record of its own stands for it.
	let plain = -1

	const base = document.workbook.styles.cellXfs[0]

	if (base !== undefined && copied.some((value, k) => k % 2 === 1 && value === 0)) {
		try {
			plain = appendXf(document, { ...base }, true)
		} catch (error) {
			if (!(error instanceof StyleLimitError)) throw error
		}
	}

	const pending: CellWrite[] = []
	const flush = async (): Promise<void> => {
		store.setCells(pending)
		pending.length = 0
		document.workbook.changes.sheetRows(sheet)
		await pause()
	}

	for (let line = at; line < end; line++) {
		for (let k = 0; k + 1 < copied.length; k += 2) {
			const style = copied[k + 1] === 0 ? plain : (copied[k + 1] ?? -1)
			const row = rows ? line : (copied[k] ?? 0)
			const col = rows ? (copied[k] ?? 0) : line

			// A cell the plan wrote there (a new table column's header) keeps its own.
			if (style < 0 || store.locate(row, col) >= 0) continue

			const state = document.state(sheet, row, col)

			log.touch(sheet, row, col, () => state, true)
			pending.push({ row, col, kind: CellKind.EMPTY, value: 0, style, formula: -1, origin: -1 })

			if (pending.length >= INHERIT_BATCH) await flush()
		}
	}

	if (pending.length > 0) await flush()

	return { bytes, apply, revert }
}

// Seals a log's entries in parts, yielding between them once the clock's slice is up.
async function sealSliced(document: XlsxDocument, log: CellLog, clock: SliceClock | undefined): Promise<void> {
	const state = (s: SheetId, r: number, c: number): CellState => document.state(s, r, c)

	for (let from = 0; ; from += SEAL_PART) {
		log.seal(state, from, Math.min(log.size, from + SEAL_PART))

		if (from + SEAL_PART >= log.size) break
		if (clock?.due === true) await clock.pause()
	}
}

// Log entries sealed between two looks at the slice clock.
const SEAL_PART = 4096

// --- Sheets ---

// Excel's rules for a sheet name: 1-31 characters, none of \ / ? * [ ] :, no apostrophe first or last, not
// "History" (reserved), unique whatever the case.
export function sheetNameRefusal(document: XlsxDocument, name: string, except: SheetId | null): SheetRefusal | null {
	if (!SHEET_NAME.test(name) || name.startsWith("'") || name.endsWith("'") || name.toUpperCase() === "HISTORY")
		return { reason: "sheetName", detail: "invalid" }

	if (document.workbook.sheets.some(entry => entry.id !== except && sameSheet(entry.name, name)))
		return { reason: "sheetName", detail: "taken" }

	return null
}

export function newSheetPart(document: XlsxDocument): string {
	const taken = new Set(document.workbook.sheets.map(entry => entry.part.toLowerCase()))
	const changes = document.workbook.changes

	for (let n = 1; ; n++) {
		const name = `xl/worksheets/sheet${String(n)}.xml`

		// Nor a name a sheet added and taken away again had: its relationships' ids are retired with it.
		if (!taken.has(name) && !document.workbook.opc.has(name) && !(changes instanceof ChangeLog && changes.hadName(name))) return name
	}
}

export function relativeTarget(from: string, part: string): string {
	const directory = from.slice(0, from.lastIndexOf("/") + 1)

	return part.startsWith(directory) ? part.slice(directory.length) : `/${part}`
}

// sheet.add: an empty worksheet at `index` (after the last by default), named as asked or "SheetN".
export async function addSheet(
	document: XlsxDocument,
	requested: string | undefined,
	index: number | undefined,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const workbook = document.workbook
	const sheets = workbook.sheets
	const clockOf = (): SliceClock | undefined => (slicing === undefined ? undefined : sliceClock(slicing))
	let name = requested

	if (name === undefined) {
		const taken = new Set(sheets.map(entry => entry.name.toUpperCase()))
		let n = sheets.length + 1

		while (taken.has(`SHEET${String(n)}`)) n++

		name = `Sheet${String(n)}`
	}

	const refusal = sheetNameRefusal(document, name, null)

	if (refusal !== null) return { refused: refusal }

	const at = index === undefined ? sheets.length : Math.max(0, Math.min(sheets.length, Math.floor(index)))

	if (sheets.length >= workbook.limits.maxSheets) return { refused: { reason: "tooLarge" } }

	// A sheet put between others: what refers to sheets by their position must allow the order to change (local
	// names follow their sheet by id; a 3-D reference takes the new sheet in, as in Excel).
	if (at < sheets.length) {
		const lock = await orderLock(document)

		if (lock !== null) return { refused: lock }
	}

	await workbook.parts.relationships(workbook.workbookPart)

	const part = newSheetPart(document)
	const relationship = workbook.changes.addRelationship(workbook.workbookPart, {
		type: relationshipType(workbook.strict, "worksheet"),
		target: relativeTarget(workbook.workbookPart, part)
	})
	const id = workbook.allocateSheetId()
	const model = new XlsxSheet({
		id,
		part,
		store: new SheetStore([], new SheetStrings(), new FormulaTable()),
		sections: [],
		relationships: new Relationships([]),
		rootStart: 0,
		rootOpenEnd: 0,
		rootEnd: 0,
		prefix: "",
		utf16: false
	})
	const entry: XlsxSheetEntry = {
		id,
		name,
		state: "visible",
		kind: "worksheet",
		sheetId: sheets.reduce((highest, sheet) => Math.max(highest, sheet.sheetId), 0) + 1,
		relationshipId: relationship.id,
		part,
		model
	}
	const activeBefore = workbook.activeTab
	const activeAfter = at <= activeBefore && at < sheets.length ? activeBefore + 1 : activeBefore
	// What INDIRECT recalculates, naming the new sheet by name: its results (logged), taken back by the undo.
	const log = new CellLog()
	let logged = false
	const added = async (sink: SheetChangeSink): Promise<void> => {
		sheets.splice(at, 0, entry)
		workbook.activeTab = activeAfter
		workbook.changes.workbookSection("sheets")

		if (activeAfter !== activeBefore) workbook.changes.workbookSection("bookViews")

		const engine = document.engine

		if (engine !== null) {
			const clock = clockOf()
			const results = await document.guardedSliced(() => engine.addSheetSliced(entry.name, clock))

			if (document.engine === engine) document.engineSheets.push(id)

			if (logged) await document.restoreLogSliced(log, "after", clock)
			else {
				await document.applySliced(results, log, sink, clock)
				await sealSliced(document, log, clock)
				logged = true
			}

			reportLogged(log, sink, "content")
		}

		sink.sheets()
	}

	await added(changes)

	return {
		bytes: 512,
		undo: async sink => {
			const position = sheets.indexOf(entry)

			if (position >= 0) sheets.splice(position, 1)

			workbook.activeTab = activeBefore
			workbook.changes.removeRelationship(workbook.workbookPart, relationship.id)

			const engine = document.engine

			const clock = clockOf()

			if (engine !== null && document.engineSheets.at(-1) === id) {
				await document.guardedSliced(() => engine.removeLastSheetSliced(clock))
				document.engineSheets.pop()
			}

			await document.restoreLogSliced(log, "before", clock)
			reportLogged(log, sink, "content")
			sink.sheets()
		},
		redo: async sink => {
			workbook.changes.addRelationship(workbook.workbookPart, { type: relationship.type, target: relationship.target })
			await added(sink)
		}
	}
}

// Why the order of the sheets cannot change, or null: the catalogue's refusal of a move, which reads everything
// that refers to sheets by position.
export async function orderLock(document: XlsxDocument): Promise<SheetRefusal | null> {
	await document.readyAllSheets()

	if (!document.allReady) return { reason: "structureLocked", detail: "unreadSheet" }

	const first = document.workbook.sheets[0]

	if (first === undefined) return null

	const probe = await planRefEdit(document.workbook, { kind: "moveSheet", sheet: first.id, to: 0 })

	return probe.ok ? null : probe.refusal
}

// sheet.rename: the name, and every formula, defined name and part that names the sheet.
export async function renameSheet(
	document: XlsxDocument,
	sheet: SheetId,
	name: string,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const target = document.entry(sheet)

	if (target === undefined) return { refused: { reason: "sheetName", detail: "missing" } }
	if (target.name === name) return null

	const refusal = sheetNameRefusal(document, name, sheet)

	if (refusal !== null) return { refused: refusal }

	await document.readyAllSheets()

	if (!document.allReady) return locked("unreadSheet")

	const planned = await planRefEdit(document.workbook, { kind: "renameSheet", sheet, name })

	if (!planned.ok) return { refused: planned.refusal }

	const plan = planned.plan
	const workbook = document.workbook
	const from = target.name
	// What INDIRECT recalculates, naming sheets by name: its results (logged), put back by undo and redo.
	const log = new CellLog()
	let logged = false
	const apply = async (which: "before" | "after", sink: SheetChangeSink): Promise<void> => {
		const clock = slicing === undefined ? undefined : sliceClock(slicing)

		if (which === "after") plan.apply()
		else plan.revert()

		target.name = which === "after" ? name : from
		workbook.changes.workbookSection("sheets")
		document.structureChanged()

		const engine = document.engine
		const index = document.engineIndex(sheet)

		if (engine !== null && index >= 0) {
			const results = await document.guardedSliced(() => engine.renameSheetSliced(index, target.name, clock))

			if (!logged) {
				await document.applySliced(results, log, sink, clock)
				await sealSliced(document, log, clock)
				logged = true

				return finish(sink)
			}
		}

		if (logged) await document.restoreLogSliced(log, which, clock)

		finish(sink)
	}
	const finish = (sink: SheetChangeSink): void => {
		if (logged) {
			reportLogged(log, sink, "content")
		}

		for (const [formulaSheet] of plan.formulaCells) {
			const bounds = cellBounds(planCellsOf(plan, formulaSheet))

			if (bounds !== null) sink.content(formulaSheet, bounds)
		}

		sink.sheets()
	}

	await apply("after", changes)

	return { bytes: planBytes(plan), undo: sink => apply("before", sink), redo: sink => apply("after", sink) }
}
