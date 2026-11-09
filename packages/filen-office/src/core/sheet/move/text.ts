import { SHEET_MAX_EDIT_CELLS, type SheetCommandOf, type SheetRange } from "../protocol"
import { defineSheetFeature, type SheetCommandContext, type SheetHandled } from "../registry"
import { textShiftFeature } from "../shift/text"
import { TEXT_SHEET, textFeature, type TextSheetDocument } from "../text"
import { landedSelection, overlaps, planCellMove, runParts, usedPart } from "./plan"

// The text files' handler of cells.move (plan.ts): a text file holds nothing that refers to cells, so a move is the
// block's texts written at the destination (and emptied where they were), as one cell entry.

function inside(range: SheetRange, row: number, col: number): boolean {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

// Writes the texts of `from` at `to` (same size), emptying the cells of `from` the block leaves when `cut`.
function writeBlock(
	context: SheetCommandContext<TextSheetDocument>,
	from: SheetRange,
	to: SheetRange,
	cut: boolean
): SheetHandled | Promise<SheetHandled> {
	const document = context.doc
	const used = usedPart(from, document.rows.length, document.width)

	if (used === null) return null

	const down = to.startRow - from.startRow
	const right = to.startCol - from.startCol
	const target = {
		startRow: used.startRow + down,
		startCol: used.startCol + right,
		endRow: used.endRow + down,
		endCol: used.endCol + right
	}
	const rows: number[] = []
	const cols: number[] = []
	const inputs: string[] = []
	const lastRow = Math.min(used.endRow, document.rows.length - 1)

	// Read before anything is written: the block may overlap where it lands.
	for (let row = used.startRow; row <= used.endRow; row++)
		for (let col = used.startCol; col <= used.endCol; col++) {
			const text = row <= lastRow ? document.text(row, col) : ""

			if (text === document.text(row + down, col + right)) continue
			if (inputs.length === SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

			rows.push(row + down)
			cols.push(col + right)
			inputs.push(text)
		}

	if (cut)
		for (let row = used.startRow; row <= lastRow; row++)
			for (let col = used.startCol; col <= used.endCol; col++) {
				if (inside(target, row, col) || document.text(row, col) === "") continue
				if (inputs.length === SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

				rows.push(row)
				cols.push(col)
				inputs.push("")
			}

	const set = textFeature.commands?.["cells.set"]

	if (inputs.length === 0 || set === undefined) return null

	return set.run(context, {
		type: "cells.set",
		sheet: TEXT_SHEET,
		cells: { rows: Uint32Array.from(rows), cols: Uint16Array.from(cols), inputs }
	})
}

// The block `range` moved along its band to the gridline before index `at` (outside it), the texts between moving
// the other way.
function reorderTexts(
	context: SheetCommandContext<TextSheetDocument>,
	range: SheetRange,
	axis: "rows" | "cols",
	at: number
): SheetHandled | Promise<SheetHandled> {
	const document = context.doc
	const byRows = axis === "rows"
	const lead = byRows ? range.startRow : range.startCol
	const tail = byRows ? range.endRow : range.endCol
	const lo = Math.min(lead, at)
	const hi = Math.max(tail, at - 1)
	// The indices in their new order, from lo.
	const order: number[] = []

	if (at > tail) {
		for (let index = tail + 1; index < at; index++) order.push(index)
		for (let index = lead; index <= tail; index++) order.push(index)
	} else {
		for (let index = lead; index <= tail; index++) order.push(index)
		for (let index = at; index < lead; index++) order.push(index)
	}

	const rows: number[] = []
	const cols: number[] = []
	const inputs: string[] = []
	const crossEnd = byRows ? Math.min(range.endCol, document.width - 1) : Math.min(range.endRow, document.rows.length - 1)

	for (let cross = byRows ? range.startCol : range.startRow; cross <= crossEnd; cross++) {
		const read = (index: number): string => (byRows ? document.text(index, cross) : document.text(cross, index))
		const before = order.map(read)

		for (let index = lo; index <= hi; index++) {
			const next = before[index - lo] ?? ""

			if (next === read(index)) continue
			if (inputs.length === SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

			rows.push(byRows ? index : cross)
			cols.push(byRows ? cross : index)
			inputs.push(next)
		}
	}

	const set = textFeature.commands?.["cells.set"]

	if (inputs.length === 0 || set === undefined) return null

	return set.run(context, {
		type: "cells.set",
		sheet: TEXT_SHEET,
		cells: { rows: Uint32Array.from(rows), cols: Uint16Array.from(cols), inputs }
	})
}

// Whether a cell of `range` outside `except` holds text.
function holdsText(document: TextSheetDocument, range: SheetRange, except: SheetRange): boolean {
	const lastRow = Math.min(range.endRow, document.rows.length - 1)

	for (let row = range.startRow; row <= lastRow; row++) {
		const line = document.rows[row] ?? []
		const lastCol = Math.min(range.endCol, line.length - 1)

		for (let col = range.startCol; col <= lastCol; col++) if ((line[col] ?? "") !== "" && !inside(except, row, col)) return true
	}

	return false
}

async function moveTexts(context: SheetCommandContext<TextSheetDocument>, command: SheetCommandOf<"cells.move">): Promise<SheetHandled> {
	const planned = planCellMove(command.range, command.to, command.insert, command.copy)

	if (planned === null) return null
	if ("reason" in planned) return { refused: planned }

	const plan = planned
	const document = context.doc
	const axis = command.insert ?? "rows"

	if (!command.copy && command.insert === undefined && command.replace !== true) {
		const except = overlaps(plan.to, command.range) ? command.range : { startRow: -1, startCol: -1, endRow: -1, endCol: -1 }

		if (holdsText(document, plan.to, except)) return { refused: { reason: "occupied" } }
	}

	const shift = textShiftFeature.commands?.["cells.shift"]
	const shiftPart = (range: SheetRange, edit: "insert" | "delete") => (): SheetHandled | Promise<SheetHandled> =>
		shift?.run(context, { type: "cells.shift", sheet: TEXT_SHEET, range, edit, axis }) ?? null
	const parts: (() => SheetHandled | Promise<SheetHandled>)[] = []
	const { insert, close } = plan

	// A reorder along the band only permutes the texts between the block and the gridline: written as that, so the file
	// grows no empty records the insert would have pushed out.
	if (close !== null && insert !== null)
		parts.push(() => reorderTexts(context, command.range, axis, axis === "rows" ? insert.startRow : insert.startCol))
	else {
		if (insert !== null) parts.push(shiftPart(insert, "insert"))

		parts.push(() => writeBlock(context, plan.from, plan.to, !command.copy))
	}

	const handled = await runParts(parts, context.changes)

	if (handled !== null && !("refused" in handled))
		context.changes.select(TEXT_SHEET, landedSelection(plan, command.range, command.active))

	return handled
}

export const textMoveFeature = defineSheetFeature<TextSheetDocument>({
	id: "textMove",
	commands: {
		"cells.move": { info: { write: true }, run: moveTexts }
	}
})
