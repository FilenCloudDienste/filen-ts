import { rangeCols, rangeRows, type CellPosition } from "../refs/cellRef"
import { formulaTranslator, rewriteFormula, sameSheet, type FormulaRef } from "../refs/formulaRefs"
import type { CellEntry } from "../grid/gridEdits"
import { cellKey, MAX_COLUMNS, MAX_ROWS, type CellRange } from "../model/model"

// A range copied or cut in the grid, kept beside its clipboard text: a paste of that same text back into
// the grid writes what the cells held (a formula, a number or date its format rounds or dresses up)
// rather than what they showed. `inputs` holds only those cells, by offset in the range.
export interface GridClip {
	tsv: string
	sheet: string
	range: CellRange
	cut: boolean
	inputs: ReadonlyMap<number, string>
}

// A cut formula's references as spreadsheets move them: one into the cut range follows its cells to
// `to` on `sheet`, and the rest keep pointing where they did (named by the sheet they are on, when the
// formula moves to another).
function movedFormula(formula: string, clip: GridClip, to: CellPosition, sheet: string): string {
	const rows = to.row - clip.range.startRow
	const cols = to.col - clip.range.startCol
	const otherSheet = !sameSheet(sheet, clip.sheet)

	return rewriteFormula(formula, (ref): FormulaRef | null | undefined => {
		const area = ref.area

		if (ref.external || ref.lastSheet !== null || (ref.sheet !== null && !sameSheet(ref.sheet, clip.sheet))) {
			return undefined
		}

		const inside =
			area !== null &&
			area.kind === "cell" &&
			Math.min(area.startRow, area.endRow) >= clip.range.startRow &&
			Math.max(area.startRow, area.endRow) <= clip.range.endRow &&
			Math.min(area.startCol, area.endCol) >= clip.range.startCol &&
			Math.max(area.startCol, area.endCol) <= clip.range.endCol

		if (!inside) {
			return otherSheet && ref.sheet === null ? { ...ref, sheet: clip.sheet } : undefined
		}

		const next = {
			...area,
			startRow: area.startRow + rows,
			endRow: area.endRow + rows,
			startCol: area.startCol + cols,
			endCol: area.endCol + cols
		}

		if (Math.max(next.startRow, next.endRow) >= MAX_ROWS || Math.max(next.startCol, next.endCol) >= MAX_COLUMNS) {
			return null
		}

		return { ...ref, sheet: ref.sheet === null ? null : sheet, area: next }
	})
}

// The clip's own entries pasted with its top-left cell at `to` on `sheet`, by offset in the range. A
// formula's references move as spreadsheets move them: a copy's relative ones by the paste's offset, a
// cut's as movedFormula does.
export function pastedInputs(clip: GridClip, to: CellPosition, sheet: string): Map<number, string> {
	const pasted = new Map<number, string>()

	for (const [offset, input] of clip.inputs) {
		if (!input.startsWith("=") || input.length === 1) {
			pasted.set(offset, input)

			continue
		}

		const formula = input.slice(1)

		pasted.set(
			offset,
			`=${clip.cut ? movedFormula(formula, clip, to, sheet) : formulaTranslator(formula)(to.row - clip.range.startRow, to.col - clip.range.startCol)}`
		)
	}

	return pasted
}

export interface PastedBlock {
	cells: CellEntry[]
	// The area written: the block, times the repeats over a paste area.
	rows: number
	cols: number
	// The clip kept after the paste: a cut's cells now live where they were pasted, so pasting them again
	// copies them from there.
	clip: GridClip | null
}

export interface PasteRepeats {
	readonly down: number
	readonly across: number
}

const ONCE: PasteRepeats = { down: 1, across: 1 }

// How often a block of `rows` by `cols` pasted at `to` repeats down and across the paste area `target`, as Excel
// fills one: an area starting at `to` whose height and width are whole multiples of the block takes it that many
// times, unless a tile would cut through one of `merges` (quads: startRow, startCol, endRow, endCol); any other
// area takes it once, at `to`.
export function pasteRepeats(
	rows: number,
	cols: number,
	to: CellPosition,
	target: CellRange | undefined,
	merges?: ArrayLike<number>
): PasteRepeats {
	if (target === undefined || rows <= 0 || cols <= 0 || target.startRow !== to.row || target.startCol !== to.col) return ONCE

	const height = target.endRow - target.startRow + 1
	const width = target.endCol - target.startCol + 1

	if (height % rows !== 0 || width % cols !== 0 || (height === rows && width === cols)) return ONCE

	if (merges !== undefined)
		for (let k = 0; k + 3 < merges.length; k += 4) {
			const startRow = merges[k] ?? 0
			const startCol = merges[k + 1] ?? 0
			const endRow = merges[k + 2] ?? 0
			const endCol = merges[k + 3] ?? 0

			if (startRow > target.endRow || endRow < target.startRow || startCol > target.endCol || endCol < target.startCol) continue

			if (
				startRow < target.startRow ||
				endRow > target.endRow ||
				startCol < target.startCol ||
				endCol > target.endCol ||
				Math.floor((startRow - target.startRow) / rows) !== Math.floor((endRow - target.startRow) / rows) ||
				Math.floor((startCol - target.startCol) / cols) !== Math.floor((endCol - target.startCol) / cols)
			)
				return ONCE
		}

	return { down: height / rows, across: width / cols }
}

// A paste of clipboard `text` with its top-left cell at `to` on `sheet`, repeated over the paste area `target` as
// pasteRepeats says (a cut never repeats: Excel moves its cells once). `clip` is the grid's own, given only while
// `text` is its clipboard text: its range is then filled whole, since the text drops a trailing row of blanks (and a
// lone blank cell altogether) while a cell showing nothing may still hold a formula; each repeat moves its formulas'
// relative references to its own origin. Null past `limit` entries, before any is built.
export function pastedCells(
	text: string,
	clip: GridClip | null,
	to: CellPosition,
	sheet: string,
	limit: number,
	target?: CellRange,
	merges?: ArrayLike<number>
): PastedBlock | null {
	const fields = parseTsv(text)
	const cells: CellEntry[] = []

	if (clip === null) {
		let cols = 0
		let count = 0

		for (const values of fields) {
			cols = Math.max(cols, values.length)
			count += values.length
		}

		const rows = fields.length
		const { down, across } = pasteRepeats(rows, cols, to, target, merges)

		if (count * down * across > limit) {
			return null
		}

		for (let row = 0; row < rows * down; row++) {
			const values = fields[row % rows] ?? []

			for (let tile = 0; tile < across; tile++) {
				for (const [colOffset, input] of values.entries()) {
					cells.push({ row: to.row + row, col: to.col + tile * cols + colOffset, input })
				}
			}
		}

		return { cells, rows: rows * down, cols: cols * across, clip: null }
	}

	const rows = rangeRows(clip.range)
	const cols = rangeCols(clip.range)

	if (clip.cut) {
		if (rows * cols > limit) {
			return null
		}

		const inputs = pastedInputs(clip, to, sheet)

		for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
			for (let colOffset = 0; colOffset < cols; colOffset++) {
				cells.push({
					row: to.row + rowOffset,
					col: to.col + colOffset,
					input: inputs.get(cellKey(rowOffset, colOffset)) ?? fields[rowOffset]?.[colOffset] ?? ""
				})
			}
		}

		return {
			cells,
			rows,
			cols,
			clip: {
				tsv: clip.tsv,
				sheet,
				range: { startRow: to.row, startCol: to.col, endRow: to.row + rows - 1, endCol: to.col + cols - 1 },
				cut: false,
				inputs
			}
		}
	}

	const { down, across } = pasteRepeats(rows, cols, to, target, merges)

	if (rows * cols * down * across > limit) {
		return null
	}

	// Each formula parsed once, moved to every repeat's origin.
	const formulas = new Map<number, (rows: number, cols: number) => string>()

	for (const [offset, input] of clip.inputs) {
		if (input.startsWith("=") && input.length > 1) {
			formulas.set(offset, formulaTranslator(input.slice(1)))
		}
	}

	for (let row = 0; row < rows * down; row++) {
		const rowOffset = row % rows

		for (let col = 0; col < cols * across; col++) {
			const colOffset = col % cols
			const offset = cellKey(rowOffset, colOffset)
			const formula = formulas.get(offset)

			cells.push({
				row: to.row + row,
				col: to.col + col,
				input:
					formula === undefined
						? (clip.inputs.get(offset) ?? fields[rowOffset]?.[colOffset] ?? "")
						: `=${formula(to.row + row - rowOffset - clip.range.startRow, to.col + col - colOffset - clip.range.startCol)}`
			})
		}
	}

	return { cells, rows: rows * down, cols: cols * across, clip }
}

// Tab-separated clipboard text back into rows of cells: quoted fields may hold tabs, line ends and doubled
// quotes, and a trailing line end (which every spreadsheet adds) is not an extra empty row.
export function parseTsv(text: string): string[][] {
	const rows: string[][] = []
	let row: string[] = []
	let field = ""
	let quoted = false
	let index = 0

	while (index < text.length) {
		const char = text.charAt(index)

		if (quoted) {
			if (char === '"' && text.charAt(index + 1) === '"') {
				field += '"'
				index += 2

				continue
			}

			if (char === '"') {
				quoted = false
			} else {
				field += char
			}

			index++

			continue
		}

		if (char === '"' && field === "") {
			quoted = true
		} else if (char === "\t") {
			row.push(field)
			field = ""
		} else if (char === "\n" || char === "\r") {
			row.push(field)
			rows.push(row)
			row = []
			field = ""

			if (char === "\r" && text.charAt(index + 1) === "\n") {
				index++
			}
		} else {
			field += char
		}

		index++
	}

	if (field !== "" || row.length > 0) {
		row.push(field)
		rows.push(row)
	}

	return rows
}
