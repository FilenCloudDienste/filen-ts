import { landedSelection, overlaps, planCellMove, runParts, splitsMerge, usedPart } from "../../sheet/move/plan"
import type { SheetCommandOf, SheetRange } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import type { Slicing } from "../../slicing"
import type { SheetStore } from "../model/store"
import { CellKind } from "../model/types"
import { clipOf, pasteClip } from "./clipboard"
import type { XlsxDocument } from "./document"
import { shiftCells } from "./shiftCells"

// A workbook's cells.move (core/sheet/move/plan.ts): Excel's drag of the selection's border. The block goes as a cut
// and its paste go (clipboard.ts: every formula referring to the moved cells follows them, the moved formulas keep
// what they refer to, formats, validations, hyperlinks and merges move along), or as a copy and its paste (relative
// references move); an insert is Insert Cells first (shiftCells.ts), and a block moved along its own band closes its
// gap with Delete Cells after. The drag's clip is its own: the clipboard's copy and its moving border are untouched.

// Whether a cell of `range` outside `except` holds a value or a formula (formats alone are no data).
function holdsData(store: SheetStore, range: SheetRange, except: SheetRange | null): boolean {
	let found = false

	store.forEachCell(range, (row, col, slot) => {
		if (found) return
		if (except !== null && row >= except.startRow && row <= except.endRow && col >= except.startCol && col <= except.endCol) return

		if (store.kind(slot) !== CellKind.EMPTY || store.formula(slot) >= 0) found = true
	})

	return found
}

async function moveCells(
	document: XlsxDocument,
	command: SheetCommandOf<"cells.move">,
	changes: SheetChangeSink,
	slicing: Slicing | undefined
): Promise<SheetHandled> {
	const { sheet, range } = command
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { refused: { reason: "structureLocked", detail: "sheet" } }

	const planned = planCellMove(range, command.to, command.insert, command.copy)

	if (planned === null) return null
	if ("reason" in planned) return { refused: planned }

	const plan = planned
	const model = await document.ready(sheet, slicing)
	const store = model.store as SheetStore

	// Part of a merged cell cannot be moved, nor written over (Excel: "Cannot change part of a merged cell").
	if (splitsMerge(model.merges, range) || (plan.insert === null && splitsMerge(model.merges, plan.to)))
		return { refused: { reason: "merged" } }

	if (!command.copy && plan.insert === null && command.replace !== true)
		if (holdsData(store, plan.to, overlaps(plan.to, range) ? range : null)) return { refused: { reason: "occupied" } }

	const axis = command.insert ?? "rows"
	const parts: (() => Promise<SheetHandled>)[] = []
	const { insert, close } = plan

	if (insert !== null) parts.push(() => shiftCells(document, sheet, insert, "insert", axis, changes, slicing))

	parts.push(async () => {
		// Whole rows (columns) move the cells there are; merges count, as they move with a cut.
		let rowExtent = store.rowExtent
		let colExtent = store.colExtent
		const merges = (document.model(sheet) ?? model).merges

		for (let k = 0; k + 3 < merges.length; k += 4) {
			rowExtent = Math.max(rowExtent, (merges[k + 2] ?? 0) + 1)
			colExtent = Math.max(colExtent, (merges[k + 3] ?? 0) + 1)
		}

		const from = usedPart(plan.from, rowExtent, colExtent)

		if (from === null) return null

		const at = {
			row: plan.to.startRow + from.startRow - plan.from.startRow,
			col: plan.to.startCol + from.startCol - plan.from.startCol
		}
		// A moved block is cut, so what refers to it follows it (also when the Delete Cells after closes its gap).
		const clip = await clipOf(document, sheet, from, !command.copy, -1)

		return pasteClip(document, sheet, at, clip.grid.tsv, clip, changes, slicing, false, undefined, false)
	})

	if (close !== null) parts.push(() => shiftCells(document, sheet, close, "delete", axis, changes, slicing))

	const handled = await runParts(parts, changes)

	if (handled !== null && !("refused" in handled)) changes.select(sheet, landedSelection(plan, range, command.active))

	return handled
}

export const moveCellsFeature = defineSheetFeature<XlsxDocument>({
	id: "moveCells",
	commands: {
		"cells.move": {
			info: { write: true },
			run: (context, command) => moveCells(context.doc, command, context.changes, context.slicing)
		}
	}
})
