import type { CellPosition } from "@/features/spreadsheet/lib/cellRef.logic"
import { MAX_COLS, MAX_ROWS } from "@/features/spreadsheet/lib/edits"
import { formulaTranslator, rewriteFormula, type FormulaRef } from "@/features/spreadsheet/lib/formulaRefs"
import type { CellEntry } from "@/features/spreadsheet/lib/gridEdits.logic"
import { cellKey, type CellRange, type CellView } from "@/features/spreadsheet/lib/model"

// How far a copy reaches: past this the clipboard text would run to hundreds of megabytes.
export const MAX_COPY_CELLS = 1_000_000

function tsvField(text: string): string {
	return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// A range as the tab-separated text other spreadsheets paste: what each cell shows, quoted where a tab, a
// line end or a quote would break the layout. Null past MAX_COPY_CELLS. `inputs` collects, by offset in
// the range, what editing each cell starts from where that is not what it shows.
export function rangeToTsv(
	sheet: { cells: { get: (key: number) => CellView | undefined } },
	range: CellRange,
	inputs?: Map<number, string>
): string | null {
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1

	if (rows * cols > MAX_COPY_CELLS) {
		return null
	}

	const lines: string[] = []

	for (let row = range.startRow; row <= range.endRow; row++) {
		const fields: string[] = []

		for (let col = range.startCol; col <= range.endCol; col++) {
			const view = sheet.cells.get(cellKey(row, col))

			if (view?.input !== undefined) {
				inputs?.set(cellKey(row - range.startRow, col - range.startCol), view.input)
			}

			fields.push(tsvField(view?.text ?? ""))
		}

		lines.push(fields.join("\t"))
	}

	return lines.join("\r\n")
}

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

// Null past MAX_COPY_CELLS.
export function rangeToClip(
	sheet: { name: string; cells: { get: (key: number) => CellView | undefined } },
	range: CellRange,
	cut: boolean
): GridClip | null {
	const inputs = new Map<number, string>()
	const tsv = rangeToTsv(sheet, range, inputs)

	return tsv === null ? null : { tsv, sheet: sheet.name, range, cut, inputs }
}

// A cut whose cells changed since (restored by an undo, or edited) is no longer what there is to move: a
// paste copies it instead, as spreadsheets end a cut.
export function endedCut(clip: GridClip | null): GridClip | null {
	return clip?.cut === true ? { ...clip, cut: false } : clip
}

function sameSheet(a: string, b: string): boolean {
	return a.toUpperCase() === b.toUpperCase()
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

		if (Math.max(next.startRow, next.endRow) >= MAX_ROWS || Math.max(next.startCol, next.endCol) >= MAX_COLS) {
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
	rows: number
	cols: number
	// The clip kept after the paste: a cut's cells now live where they were pasted, so pasting them again
	// copies them from there.
	clip: GridClip | null
}

// A paste of clipboard `text` with its top-left cell at `to` on `sheet`. `clip` is the grid's own, given
// only while `text` is its clipboard text: its range is then filled whole, since the text drops a trailing
// row of blanks (and a lone blank cell altogether) while a cell showing nothing may still hold a formula.
// Null past `limit` entries, before the rest is built.
export function pastedCells(text: string, clip: GridClip | null, to: CellPosition, sheet: string, limit: number): PastedBlock | null {
	const fields = parseTsv(text)
	const cells: CellEntry[] = []

	if (clip === null) {
		let cols = 0

		for (const [rowOffset, values] of fields.entries()) {
			cols = Math.max(cols, values.length)

			for (const [colOffset, input] of values.entries()) {
				if (cells.length === limit) {
					return null
				}

				cells.push({ row: to.row + rowOffset, col: to.col + colOffset, input })
			}
		}

		return { cells, rows: fields.length, cols, clip: null }
	}

	const inputs = pastedInputs(clip, to, sheet)
	const rows = clip.range.endRow - clip.range.startRow + 1
	const cols = clip.range.endCol - clip.range.startCol + 1

	for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
		for (let colOffset = 0; colOffset < cols; colOffset++) {
			if (cells.length === limit) {
				return null
			}

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
		clip: clip.cut
			? {
					tsv: clip.tsv,
					sheet,
					range: { startRow: to.row, startCol: to.col, endRow: to.row + rows - 1, endCol: to.col + cols - 1 },
					cut: false,
					inputs
				}
			: clip
	}
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
