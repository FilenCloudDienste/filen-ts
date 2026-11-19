import { SHEET_MAX_EDIT_CELLS, type SheetId, type SheetRange } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled, type SheetReadContext, type SheetTarget } from "../../sheet/registry"
import type { SheetStore } from "../model/store"
import { CellKind, FormulaKind } from "../model/types"
import { contains, intersects } from "../refs/moveRefs"
import { recalculateLogged, splitsArray, unshare } from "./cells"
import type { XlsxDocument } from "./document"
import { StyleLimitError, XfPatcher, cellStep, reportLogged } from "./format"
import { CellLog, type CellState } from "./history"

// Merged cells (§18.3.1.55 mergeCell). As Excel merges them ("Merge and center", support.microsoft.com): the
// upper-left cell's value stays and the others' go (only once the user agreed: refused with mergeLosesValues
// first), every cell of the merge takes the upper-left one's format, and merges the range holds whole are taken in.
// "center" also centres it; "across" merges each row on its own. A merge that would cut through another one, a
// table or an array formula is refused.

declare module "../../sheet/protocol" {
	interface SheetCommandMap {
		"merge.cells": {
			readonly sheet: SheetId
			readonly ranges: readonly SheetRange[]
			readonly mode: "merge" | "center" | "across"
			// The user agreed that values outside the upper-left cells go.
			readonly discard?: boolean
		}
		"merge.unmerge": { readonly sheet: SheetId; readonly ranges: readonly SheetRange[] }
	}

	interface SheetRefusalReasons {
		// Cells other than the upper-left one hold values the merge would drop (the user is asked first).
		mergeLosesValues: true
	}
}

function quads(merges: Uint32Array): SheetRange[] {
	const out: SheetRange[] = []

	for (let k = 0; k + 3 < merges.length; k += 4)
		out.push({ startRow: merges[k] ?? 0, startCol: merges[k + 1] ?? 0, endRow: merges[k + 2] ?? 0, endCol: merges[k + 3] ?? 0 })

	return out
}

function packed(ranges: readonly SheetRange[]): Uint32Array {
	const out = new Uint32Array(ranges.length * 4)

	ranges.forEach((range, k) => out.set([range.startRow, range.startCol, range.endRow, range.endCol], k * 4))

	return out
}

// Ranges by first row, each with the furthest last row up to it: the ones that may share rows with a range are a
// run of it, found by two binary searches.
interface RowIndex {
	readonly ranges: readonly SheetRange[]
	readonly reach: Uint32Array
}

function rowIndex(ranges: readonly SheetRange[]): RowIndex {
	const sorted = [...ranges].sort((a, b) => a.startRow - b.startRow)
	const reach = new Uint32Array(sorted.length)
	let furthest = 0

	sorted.forEach((range, k) => {
		furthest = Math.max(furthest, range.endRow)
		reach[k] = furthest
	})

	return { ranges: sorted, reach }
}

// Whether a range of the index sharing rows with `range` passes `test`.
function someNear(index: RowIndex, range: SheetRange, test: (other: SheetRange) => boolean): boolean {
	let low = 0
	let high = index.ranges.length

	// The first whose rows up to it reach the range's first row.
	while (low < high) {
		const middle = (low + high) >>> 1

		if ((index.reach[middle] ?? 0) < range.startRow) low = middle + 1
		else high = middle
	}

	for (let k = low; k < index.ranges.length; k++) {
		const other = index.ranges[k] as SheetRange

		if (other.startRow > range.endRow) break

		if (test(other)) return true
	}

	return false
}

function area(range: SheetRange): number {
	return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
}

// The merges a command makes: each range whole, or each of its rows ("across"); single cells are none.
function mergesOf(ranges: readonly SheetRange[], mode: "merge" | "center" | "across"): SheetRange[] {
	const out: SheetRange[] = []

	for (const range of ranges) {
		if (mode !== "across") {
			if (area(range) > 1) out.push(range)

			continue
		}

		if (range.endCol === range.startCol) continue

		for (let row = range.startRow; row <= range.endRow; row++) out.push({ ...range, startRow: row, endRow: row })
	}

	return out
}

// Why the merges cannot be made, or null.
export async function mergeRefusal(
	document: XlsxDocument,
	sheet: SheetId,
	merges: readonly SheetRange[]
): Promise<{ reason: "merged" | "arrayFormula" | "protectedSheet" | "tooLarge"; detail?: string } | null> {
	const model = await document.ready(sheet)

	if (model.protection !== null) return { reason: "protectedSheet", detail: "merge" }

	let cells = 0

	for (const merge of merges) cells += area(merge)

	if (cells > SHEET_MAX_EDIT_CELLS) return { reason: "tooLarge" }

	// By first row, each against the ones after it that start before it ends (one per row of a Merge Across).
	const sorted = rowIndex(merges).ranges

	for (let k = 0; k < sorted.length; k++) {
		const merge = sorted[k] as SheetRange

		for (let j = k + 1; j < sorted.length && (sorted[j] as SheetRange).startRow <= merge.endRow; j++)
			if (intersects(merge, sorted[j] as SheetRange)) return { reason: "merged" }
	}

	if (model.merges.length > 0) {
		const existing = rowIndex(quads(model.merges))

		for (const merge of merges)
			if (someNear(existing, merge, other => intersects(other, merge) && !contains(merge, other))) return { reason: "merged" }
	}

	for (const table of await document.sheetTables(sheet))
		for (const merge of merges) if (intersects(table.range, merge)) return { reason: "merged", detail: "table" }

	const store = model.store as SheetStore
	const rows: number[] = []
	const cols: number[] = []

	for (const merge of merges) {
		store.forEachCell(merge, (row, col, slot) => {
			const formula = store.formula(slot)

			if (formula >= 0) {
				rows.push(row)
				cols.push(col)

				const kind = store.formulas.kind(formula)

				if (kind === FormulaKind.ARRAY || kind === FormulaKind.DATA_TABLE) cells = -1
			}
		})
	}

	if (cells < 0 || splitsArray(model, rows, cols)) return { reason: "arrayFormula" }

	return null
}

// Cells written to the store at once: about a block's worth, each block rebuilt about once.
const CELLS_PER_BATCH = 1024

function holds(state: CellState): boolean {
	return state.formula >= 0 || state.kind !== CellKind.EMPTY
}

export async function mergeCells(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	mode: "merge" | "center" | "across",
	discard: boolean,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const merges = mergesOf(ranges, mode)

	if (merges.length === 0) return null

	const refusal = await mergeRefusal(document, sheet, merges)

	if (refusal !== null) return { refused: refusal }

	const model = await document.ready(sheet)
	const store = model.store as SheetStore

	if (!discard) {
		for (const merge of merges) {
			let losing = false

			store.forEachCell(merge, (row, col) => {
				if ((row !== merge.startRow || col !== merge.startCol) && holds(document.state(sheet, row, col))) losing = true
			})

			if (losing) return { refused: { reason: "mergeLosesValues" } }
		}
	}

	// Built from the cells as they stand before the merge, so dropped values are what it recalculates.
	if (document.engine === null && document.allReady && document.hasFormulas) {
		await document.loadTables()
		document.buildEngine(changes)
	}

	const log = new CellLog()
	const centred = mode === "merge" ? null : new XfPatcher(document, { align: "center" })
	// Written to the store in batches, so a block is rebuilt once per batch rather than once per cell it gains. Merges
	// do not overlap: no cell is named twice, and none read before its write is pending.
	const pending: { row: number; col: number; state: CellState }[] = []
	const flush = (): void => {
		document.writeCells(sheet, pending)
		pending.length = 0
	}

	try {
		for (const merge of merges) {
			const anchor = document.state(sheet, merge.startRow, merge.startCol)
			const style = centred === null ? anchor.style : centred.xf(anchor.style)

			for (let row = merge.startRow; row <= merge.endRow; row++) {
				for (let col = merge.startCol; col <= merge.endCol; col++) {
					const before = document.state(sheet, row, col)
					const upperLeft = row === merge.startRow && col === merge.startCol
					let next: CellState

					if (upperLeft) next = { ...before, present: before.present || style !== 0, style }
					else
						next =
							style === 0 && !before.present
								? before
								: { present: style !== 0, kind: CellKind.EMPTY, value: 0, style, formula: -1, shown: undefined }

					if (
						next.present === before.present &&
						next.kind === before.kind &&
						next.style === before.style &&
						next.formula === before.formula
					)
						continue

					// It rewrites its children, which may be pending here: those go to the store first.
					if (!upperLeft && before.formula >= 0 && store.formulas.kind(before.formula) === FormulaKind.SHARED_MASTER) {
						flush()
						unshare(document, sheet, row, col, log)
					}

					log.touch(sheet, row, col, () => document.state(sheet, row, col), !upperLeft)
					pending.push({ row, col, state: next })

					if (pending.length >= CELLS_PER_BATCH) flush()
				}
			}
		}

		flush()
	} catch (error) {
		if (error instanceof StyleLimitError) {
			// What is still pending was never written: the log restores the cells that were.
			pending.length = 0
			log.restore(document.restoreCell, "before")

			return { refused: { reason: "styleLimit" } }
		}

		throw error
	}

	const before = model.merges
	const made = rowIndex(merges)
	const kept = quads(before).filter(existing => !someNear(made, existing, merge => contains(merge, existing)))
	const after = packed([...kept, ...merges])
	const setMerges = (value: Uint32Array, sink: SheetChangeSink): void => {
		model.merges = value
		document.workbook.changes.sheetSection(sheet, "mergeCells")
		sink.layout(sheet)
	}

	// Merged first: a dynamic array no longer spills over the merged cells (#SPILL!).
	setMerges(after, changes)
	recalculateLogged(document, log, changes)
	document.spillsChanged(sheet, log, changes)
	log.seal((s, r, c) => document.state(s, r, c))
	reportLogged(log, changes, "content")

	const cells = cellStep(document, log, sink => reportLogged(log, sink, "content"), true)

	return {
		bytes: cells.bytes + (before.byteLength + after.byteLength),
		undo: async sink => {
			setMerges(before, sink)
			await cells.undo(sink)
		},
		redo: async sink => {
			await cells.redo(sink)
			setMerges(after, sink)
		}
	}
}

export async function unmergeCells(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const model = await document.ready(sheet)

	if (model.protection !== null) return { refused: { reason: "protectedSheet", detail: "merge" } }

	const before = model.merges
	const all = quads(before)
	const kept = all.filter(existing => !ranges.some(range => intersects(range, existing)))

	if (kept.length === all.length) return null

	const after = packed(kept)
	const set = (value: Uint32Array, sink: SheetChangeSink): void => {
		model.merges = value
		document.workbook.changes.sheetSection(sheet, "mergeCells")
		sink.layout(sheet)

		for (const range of all) sink.look(sheet, range)
	}

	set(after, changes)

	// A dynamic array the merge held back spills again.
	const log = new CellLog()

	document.spillsChanged(sheet, log, changes)

	if (log.size === 0)
		return { bytes: before.byteLength + after.byteLength, undo: sink => set(before, sink), redo: sink => set(after, sink) }

	log.seal((s, r, c) => document.state(s, r, c))
	reportLogged(log, changes, "content")

	const cells = cellStep(document, log, sink => reportLogged(log, sink, "content"), true)

	return {
		bytes: cells.bytes + before.byteLength + after.byteLength,
		undo: async sink => {
			await cells.undo(sink)
			set(before, sink)
		},
		redo: async sink => {
			set(after, sink)
			await cells.redo(sink)
		}
	}
}

// Whether the selection has merges to undo (menus).
function unmergeCheck(context: SheetReadContext<XlsxDocument>, target: SheetTarget): { reason: "unsupported" } | null {
	// A sheet still being parsed answers from the preview of its first rows.
	const model = context.doc.model(target.sheet) ?? context.doc.previews.get(target.sheet)?.model ?? null

	if (model === null) return null

	return quads(model.merges).some(existing => target.ranges.some(range => intersects(range, existing))) ? null : { reason: "unsupported" }
}

export const mergeFeature = defineSheetFeature<XlsxDocument>({
	id: "merge",
	commands: {
		"merge.cells": {
			info: { write: true },
			run: (context, command) =>
				mergeCells(context.doc, command.sheet, command.ranges, command.mode, command.discard === true, context.changes)
		},
		"merge.unmerge": {
			info: { write: true },
			check: unmergeCheck,
			run: (context, command) => unmergeCells(context.doc, command.sheet, command.ranges, context.changes)
		}
	}
})
