import { SHEET_MAX_COLS, SHEET_MAX_EDIT_CELLS, SHEET_MAX_ROWS, type SheetAxis, type SheetId, type SheetRange } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import type { CellWrite, SheetStore } from "../model/store"
import { CellKind, type XlsxSourceCell } from "../model/types"
import type { AxisShift } from "../refs/axis"
import { planRefEdit } from "../refs/plan"
import type { XlsxDocument } from "./document"
import { reportLogged } from "./format"
import { CellLog, StoreSnapshot, cellKeyOf, type CellState } from "./history"
import { changedNames, rebuildEngine } from "./sheets"
import { cellBounds, moveAxis, planBytes, planCellsOf } from "./structure-basic"

// Excel's Insert and Delete of cells (support.microsoft.com, "Insert or delete cells, rows, and columns"): cells
// inserted with the cells there shifted down or right, or deleted with the cells after them shifted up or left.
// What refers to the cells follows them through the references catalogue (refs/plan.ts, its band rules), or the
// edit is refused with the construct that cannot.

// "cells.shift" is declared with the text files' own handler (core/sheet/shift/text.ts), which keeps the text path
// free of the workbook's modules.

// What a step holds beyond its plan, logs and snapshots.
const STEP_BYTES = 512

export async function shiftCells(
	document: XlsxDocument,
	sheet: SheetId,
	range: SheetRange,
	type: "insert" | "delete",
	axis: SheetAxis,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const target = document.entry(sheet)

	if (target === undefined || target.kind !== "worksheet") return { refused: { reason: "structureLocked", detail: "sheet" } }

	const { startRow, startCol, endRow, endCol } = range

	if (
		![startRow, startCol, endRow, endCol].every(Number.isInteger) ||
		startRow < 0 ||
		startCol < 0 ||
		startRow > endRow ||
		startCol > endCol ||
		endRow >= SHEET_MAX_ROWS ||
		endCol >= SHEET_MAX_COLS
	)
		return { refused: { reason: "tooLarge" } }

	const rows = axis === "rows"
	const at = rows ? startRow : startCol
	const count = rows ? endRow - startRow + 1 : endCol - startCol + 1
	const band = rows ? { start: startCol, end: endCol } : { start: startRow, end: endRow }
	const limit = rows ? SHEET_MAX_ROWS : SHEET_MAX_COLS

	// Every column (row) of the sheet: whole rows (columns), as Excel inserts or deletes them.
	if (band.start === 0 && band.end === (rows ? SHEET_MAX_COLS : SHEET_MAX_ROWS) - 1)
		return moveAxis(document, sheet, axis, type, at, count, changes, slicing)

	await document.readyAllSheets(slicing)

	if (!document.allReady) return { refused: { reason: "structureLocked", detail: "unreadSheet" } }

	const model = target.model

	if (model === null) return { refused: { reason: "structureLocked", detail: "unreadSheet" } }

	// A protected sheet allows inserting and deleting whole rows and columns alone (§18.3.1.85).
	if (model.protection !== null) return { refused: { reason: "protectedSheet", detail: `${type}Cells` } }

	const store = model.store as SheetStore
	const shift: AxisShift = { type, axis, at, count, band }
	const cross = (lo: number, hi: number): SheetRange =>
		rows
			? { startRow: lo, startCol: band.start, endRow: hi, endCol: band.end }
			: { startRow: band.start, startCol: lo, endRow: band.end, endCol: hi }

	// Excel will not push cells off the sheet (nor would an undo bring them back).
	if (type === "insert") {
		let pushed = false

		store.forEachCell(cross(limit - count, limit - 1), () => {
			pushed = true
		})

		if (pushed) return { refused: { reason: "tooLarge", detail: "cells" } }
	}

	// The band's cells from `at` on: each one's place, and where it goes unless deleted. As many as one edit writes.
	const moved: { readonly write: CellWrite; readonly source: XlsxSourceCell | null }[] = []
	const vacated: number[] = []
	// Results the session shows for deleted formula cells the file keeps none for, given back on undo.
	const shown: { readonly row: number; readonly col: number; readonly state: CellState }[] = []
	let deletedStrings = 0
	let visited = 0

	store.forEachCell(cross(at, limit - 1), (row, col, slot) => {
		if (++visited > SHEET_MAX_EDIT_CELLS) return

		const index = rows ? row : col

		vacated.push(row, col)

		if (type === "delete" && index < at + count) {
			const state = document.state(sheet, row, col)

			if (store.kind(slot) === CellKind.SHARED_STRING) deletedStrings++
			if (state.shown !== undefined) shown.push({ row, col, state })

			return
		}

		const next = type === "insert" ? index + count : index - count

		moved.push({
			write: {
				row: rows ? next : row,
				col: rows ? col : next,
				kind: store.kind(slot),
				value: store.value(slot),
				style: store.style(slot),
				formula: store.formula(slot),
				origin: -1
			},
			// A cell holding markup the model does not carries it along (the source of the row it lands in is not its own).
			source: store.carriesMarkup(slot) ? store.sourceCell(slot, model.part) : null
		})
	})

	if (visited > SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

	// An engine an earlier edit dropped is built from the cells as they stand, so this edit is what it recalculates.
	await document.engineBeforeRows(changes)

	const planned = await planRefEdit(document.workbook, { kind: "axis", sheet, shift })

	if (!planned.ok) return { refused: planned.refusal }

	const plan = planned.plan
	const workbook = document.workbook
	const shared = workbook.sharedStrings

	// Every position written: the cells' old places emptied, their new ones filled, the added table columns' headers.
	const writes = new Map<number, CellWrite>()

	for (let k = 0; k + 1 < vacated.length; k += 2) {
		const row = vacated[k] ?? 0
		const col = vacated[k + 1] ?? 0

		writes.set(cellKeyOf(row, col), { row, col, kind: CellKind.EMPTY, value: 0, style: 0, formula: -1, origin: -1 })
	}

	for (const { write, source } of moved)
		writes.set(cellKeyOf(write.row, write.col), source === null ? write : { ...write, origin: store.carry(source) })

	for (const header of plan.headers) {
		const source = store.locate(header.row, header.styleFrom)
		let index = shared.find(header.name)

		if (index < 0) index = shared.append(header.name)

		writes.set(cellKeyOf(header.row, header.col), {
			row: header.row,
			col: header.col,
			kind: CellKind.SHARED_STRING,
			value: index,
			style: source < 0 ? 0 : store.style(source),
			formula: -1,
			origin: -1
		})
	}

	const references = plan.headers.length - deletedStrings
	const cells = [...writes.values()]
	const region = cellBounds(cells)
	// What the engine gets, per sheet, as (row, col) pairs: every written position, and every cell whose formula
	// changed (on the edited sheet, those not written already).
	const engineCells = new Map<SheetId, Uint32Array>()
	const written = new Uint32Array(cells.length * 2)

	cells.forEach((cell, k) => {
		written[k * 2] = cell.row
		written[k * 2 + 1] = cell.col
	})

	for (const [formulaSheet, pairs] of plan.formulaCells) {
		if (formulaSheet !== sheet) {
			engineCells.set(formulaSheet, Uint32Array.from(pairs))

			continue
		}

		const extra: number[] = []

		for (let k = 0; k + 1 < pairs.length; k += 2)
			if (!writes.has(cellKeyOf(pairs[k] ?? 0, pairs[k + 1] ?? 0))) extra.push(pairs[k] ?? 0, pairs[k + 1] ?? 0)

		engineCells.set(sheet, extra.length === 0 ? written : Uint32Array.from([...written, ...extra]))
	}

	if (!engineCells.has(sheet)) engineCells.set(sheet, written)

	const inverse: AxisShift = { ...shift, type: type === "insert" ? "delete" : "insert" }
	// What the engine recalculated beyond the moved cells, given back on undo.
	const post = new CellLog()
	// The store as it was and as the edit leaves it, columns too: a later insert of columns shifts a block's columns
	// in place, and the undo of that insert need not shift them back.
	const before = new StoreSnapshot(store, true)
	const counted = (sign: number): void => {
		if (references === 0) return

		shared.adjustReferences(sign * references)
		workbook.changes.sharedStringsAppended()
	}

	store.setCells(cells)
	workbook.changes.sheetRows(sheet)
	counted(1)

	const after = new StoreSnapshot(store, true)
	const clockOf = (): SliceClock | undefined => (slicing === undefined ? undefined : sliceClock(slicing))
	const turn = async (clock: SliceClock | undefined): Promise<void> => {
		if (clock?.due === true) await clock.pause()
	}
	const settle = async (edit: AxisShift): Promise<void> => {
		document.shiftShown(sheet, edit)
		document.structureChanged()
		await document.loadTables()
	}
	const report = (sink: SheetChangeSink): void => {
		if (region !== null) sink.content(sheet, region)

		for (const [formulaSheet] of plan.formulaCells) {
			if (formulaSheet === sheet) continue

			const bounds = cellBounds(planCellsOf(plan, formulaSheet))

			if (bounds !== null) sink.content(formulaSheet, bounds)
		}

		const own = cellBounds(planCellsOf(plan, sheet))

		if (own !== null) sink.content(sheet, own)

		reportLogged(post, sink, "content")
		sink.layout(sheet)
	}
	// The engine gets every cell the edit moved or whose formula changed, as they now stand.
	const engineSync = (log: CellLog | null, sink: SheetChangeSink): void => {
		const engine = document.engine

		if (engine === null) return

		for (const [engineSheet, pairs] of engineCells) {
			const list: { row: number; col: number }[] = []

			for (let k = 0; k + 1 < pairs.length; k += 2) list.push({ row: pairs[k] ?? 0, col: pairs[k + 1] ?? 0 })

			if (log !== null) {
				document.recalculate(engineSheet, list, log, sink)

				continue
			}

			const engineModel = document.model(engineSheet)
			const index = document.engineIndex(engineSheet)

			if (engineModel !== null && index >= 0)
				document.guarded(() =>
					engine.set(
						index,
						list.map(cell => document.engineCell(engineModel, cell.row, cell.col))
					)
				)
		}
	}

	const namesBefore = workbook.definedNames.slice()

	plan.apply()

	// A defined name the edit moved: the engine holds the names as it was built (named expressions, the text INDIRECT
	// reads, a one-cell name spelled as its cell), and a cell move changes none of them. It is given the moved cells
	// first, which settles the dynamic arrays' ranges and recalculates what reads the cells through other ranges, then
	// built again from the workbook as it stands, with what reads the moved names recalculated and logged; on undo and
	// redo it is built again once the cells are back. The session never stays without an engine: a structure edit
	// after this one recalculates through it.
	const names = changedNames(document, namesBefore)
	const rebuild = (sink: SheetChangeSink): void => {
		document.dropEngine()

		if (document.hasFormulas && document.allReady) document.buildEngine(sink)
	}

	await settle(shift)
	await turn(clockOf())
	engineSync(post, changes)

	if (names.size > 0) rebuildEngine(document, plan, names, post, changes)

	// Sealed after a rebuild too, which returns unsealed when there is nothing to build.
	post.seal((s, r, c) => document.state(s, r, c))

	report(changes)

	return {
		bytes: planBytes(plan) + post.bytes + before.bytes + after.bytes + written.byteLength + STEP_BYTES,
		undo: async sink => {
			post.restore(document.restoreCell, "before")
			plan.revert()
			before.restore(store)
			workbook.changes.sheetRows(sheet)
			counted(-1)
			await settle(inverse)

			for (const { row, col, state } of shown) document.write(sheet, row, col, state, true)

			await turn(clockOf())

			if (names.size > 0) rebuild(sink)
			else engineSync(null, sink)

			report(sink)
		},
		redo: async sink => {
			after.restore(store)
			workbook.changes.sheetRows(sheet)
			counted(1)
			plan.apply()
			await settle(shift)
			await turn(clockOf())

			if (names.size > 0) {
				// The results first: built before them, the store holds each dynamic array at one cell and the
				// engine keeps #SPILL! for it.
				post.restore(document.restoreCell, "after")
				rebuild(sink)
			} else {
				engineSync(null, sink)
				post.restore(document.restoreCell, "after")
			}

			report(sink)
		}
	}
}

export const shiftCellsFeature = defineSheetFeature<XlsxDocument>({
	id: "shiftCells",
	commands: {
		"cells.shift": {
			info: { write: true },
			run: (context, command) =>
				shiftCells(context.doc, command.sheet, command.range, command.edit, command.axis, context.changes, context.slicing)
		}
	}
})
