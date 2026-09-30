import { canEncodeWindows1252, csvCellView, csvDoc, serializeCsv, type CsvFormat } from "@/features/spreadsheet/lib/csvView"
import { EditHistory } from "@/features/spreadsheet/lib/editHistory"
import {
	MAX_EDIT_CELLS,
	MAX_SHEET_CELLS,
	type AxisEdit,
	type DocState,
	type EditOp,
	type EditResult
} from "@/features/spreadsheet/lib/edits"
import { cellKey, keyCol, keyRow, MAX_COLUMNS, MAX_ROWS, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import type { SizeAxis } from "@/features/spreadsheet/lib/sizes.logic"

type Step =
	// `rowCount`/`rowWidths` are the sheet's extent just before this step's writes grew it — a setCells past
	// the current edge grows `rows` (see write()), and nothing else shrinks it back on undo.
	| { type: "cells"; before: Map<number, string>; rowCount: number; rowWidths: Map<number, number> }
	| { type: "structure"; edit: AxisEdit; removed: string[][] }

type StructureStep = Extract<Step, { type: "structure" }>

// How many cells a step's snapshot holds, for the history's total memory budget.
function stepWeight(step: Step): number {
	return step.type === "cells" ? step.before.size : step.removed.reduce((total, row) => total + row.length, 0)
}

// An open CSV or TSV: its rows of text (a CSV holds no formulas or formats: what is typed is what is
// stored, a leading "=" included), the way the file was written, and an undo history. Worker-side only.
export class CsvDocument {
	private rows: string[][]
	private readonly format: CsvFormat
	private readonly history = new EditHistory<Step>(stepWeight, MAX_SHEET_CELLS)

	constructor(rows: string[][], format: CsvFormat) {
		this.rows = rows
		this.format = format
	}

	get writable(): boolean {
		return this.format.writable
	}

	doc(): SpreadsheetDoc {
		return csvDoc(this.rows, this.writable)
	}

	apply(op: EditOp): EditResult {
		// A windows-1252 file's saved encoding never changes behind the user's back (see serializeCsv): a
		// cell that would hold a character the table cannot represent is refused outright, before any row is
		// touched, rather than silently reformatting the whole file to UTF-8 and corrupting every untouched
		// cell's bytes on the next save.
		if (op.type === "setCells" && this.format.encoding === "windows-1252" && op.cells.some(cell => !canEncodeWindows1252(cell.input))) {
			return { type: "refused", reason: "encoding", state: this.history.state() }
		}

		// Rows or columns inserted past the data move nothing: the file stays as it is.
		if (op.type === "insert" && this.pastData(op.axis, op.at)) {
			return { type: "none", state: this.history.state() }
		}

		const step = this.run(op)

		if (step === null) {
			return {
				type: "refused",
				reason: op.type === "addSheet" || op.type === "renameSheet" ? "sheetName" : "tooLarge",
				state: this.history.state()
			}
		}

		this.history.record(step, op)

		return this.result(op, step)
	}

	undo(): EditResult {
		const step = this.history.peekUndo()

		if (step === undefined) {
			return { type: "none", state: this.history.state() }
		}

		this.history.popUndo()

		if (step.type === "structure") {
			this.revertStructure(step)

			return this.shiftedResult({ ...step.edit, revert: true }, step.edit.type === "delete" ? this.restoredCells(step) : [])
		}

		const touched: number[] = []

		for (const [key, text] of step.before) {
			this.write(keyRow(key), keyCol(key), text)
			touched.push(key)
		}

		this.shrinkTo(step.rowCount, step.rowWidths)

		return this.cellsResult(touched)
	}

	redo(): EditResult {
		const op = this.history.peekRedo()

		if (op === undefined) {
			return { type: "none", state: this.history.state() }
		}

		const step = this.run(op)

		if (step === null) {
			return { type: "none", state: this.history.state() }
		}

		this.history.commitRedo(step)

		return this.result(op, step)
	}

	// The file's bytes as edited, and the state they hold.
	serialize(): { bytes: Uint8Array; version: number } {
		if (!this.writable) {
			throw new Error("spreadsheet: this CSV cannot be saved")
		}

		return { bytes: serializeCsv(this.rows, this.format), version: this.history.version }
	}

	// The state `version` names is now the file's: the document is clean exactly while it is back there.
	markSaved(version: number): DocState {
		return this.history.markSaved(version)
	}

	private width(): number {
		return this.rows.reduce((width, row) => Math.max(width, row.length), 0)
	}

	private pastData(axis: SizeAxis, at: number): boolean {
		return at >= (axis === "rows" ? this.rows.length : this.width())
	}

	private write(row: number, col: number, text: string): void {
		while (this.rows.length <= row) {
			this.rows.push([])
		}

		const values = this.rows[row] ?? []

		while (values.length <= col) {
			values.push("")
		}

		values[col] = text
		this.rows[row] = values
	}

	// Undoes exactly the growth write() performed for one "cells" step: rows a setCells pushed past the old
	// edge are dropped entirely, and rows it only widened are truncated back to their old width. A row
	// untouched by the step, or already at least this wide beforehand, is left alone.
	private shrinkTo(rowCount: number, rowWidths: ReadonlyMap<number, number>): void {
		for (const [row, width] of rowWidths) {
			const values = this.rows[row]

			if (values !== undefined && values.length > width) {
				values.length = width
			}
		}

		if (this.rows.length > rowCount) {
			this.rows.length = rowCount
		}
	}

	private run(op: EditOp): Step | null {
		switch (op.type) {
			case "setCells": {
				if (op.cells.length > MAX_EDIT_CELLS || op.cells.some(cell => cell.row >= MAX_ROWS || cell.col >= MAX_COLUMNS)) {
					return null
				}

				const before = new Map<number, string>()
				const rowWidths = new Map<number, number>()
				const rowCount = this.rows.length

				for (const { row, col, input } of op.cells) {
					const key = cellKey(row, col)

					if (!before.has(key)) {
						before.set(key, this.rows[row]?.[col] ?? "")
					}

					if (!rowWidths.has(row)) {
						rowWidths.set(row, this.rows[row]?.length ?? 0)
					}

					this.write(row, col, input)
				}

				return { type: "cells", before, rowCount, rowWidths }
			}
			case "insert":
			case "delete": {
				if (op.count <= 0 || op.at < 0) {
					return null
				}

				if (op.axis === "rows") {
					let removed: string[][] = []
					let at = op.at

					if (op.type === "insert") {
						// concat, not splice(...spread): inserting past ~125k rows spreads that many arguments
						// into one call and throws RangeError. Only ever inside the data (apply() drops an insert
						// past it).
						at = Math.min(op.at, this.rows.length)
						const empty = Array.from({ length: op.count }, (): string[] => [])

						this.rows = this.rows.slice(0, at).concat(empty, this.rows.slice(at))
					} else {
						removed = this.rows.splice(op.at, op.count)
					}

					return { type: "structure", edit: { type: op.type, axis: "rows", at, count: op.count }, removed }
				}

				const removed: string[][] = []

				if (op.type === "insert") {
					// Past the grid's last column, cells would take the keys of the next row's (cellKey).
					if (this.width() + op.count > MAX_COLUMNS) {
						return null
					}

					const empty = new Array<string>(op.count).fill("")

					this.rows = this.rows.map(row => (op.at < row.length ? row.slice(0, op.at).concat(empty, row.slice(op.at)) : row))
				} else {
					for (const row of this.rows) {
						removed.push(row.splice(op.at, op.count))
					}
				}

				return { type: "structure", edit: { type: op.type, axis: "cols", at: op.at, count: op.count }, removed }
			}
			// A CSV is one sheet, and holds no formats or sizes (its sizes live beside it: lib/sizeLayer.ts).
			case "addSheet":
			case "renameSheet":
			case "format":
			case "resize":
				return null
		}
	}

	// Reverses a structural step without re-copying the sheet: an insert's undo just deletes the same run
	// back out, and a delete's undo re-inserts exactly the cells it removed (touched rows only, on cols).
	private revertStructure(step: StructureStep): void {
		const { type, axis, at, count } = step.edit

		if (axis === "rows") {
			this.rows =
				type === "insert"
					? this.rows.slice(0, at).concat(this.rows.slice(at + count))
					: this.rows.slice(0, at).concat(step.removed, this.rows.slice(at))

			return
		}

		this.rows = this.rows.map((row, index) => {
			if (type === "insert") {
				return row.length > at + count ? row.slice(0, at).concat(row.slice(at + count)) : row
			}

			const removedRow = step.removed[index]

			return removedRow === undefined ? row : row.slice(0, at).concat(removedRow, row.slice(at))
		})
	}

	private result(op: EditOp, step: Step): EditResult {
		if (step.type === "structure") {
			return this.shiftedResult({ ...step.edit, revert: false }, [])
		}

		return op.type !== "setCells" ? this.sheetsResult() : this.cellsResult([...step.before.keys()])
	}

	private cellsResult(keys: readonly number[]): EditResult {
		return {
			type: "cells",
			patches: [
				{
					sheet: 0,
					cells: keys.map((key): [number, CellView | null] => [key, csvCellView(this.rows[keyRow(key)]?.[keyCol(key)] ?? "")]),
					rowCount: this.rows.length,
					colCount: this.width()
				}
			],
			styles: [],
			state: this.history.state()
		}
	}

	private sheetsResult(): EditResult {
		return { type: "sheets", sheets: this.doc().sheets, styles: [], state: this.history.state() }
	}

	// A move keeps each cell's text, which alone decides its view, so the page moves the views it holds
	// rather than taking a whole new sheet.
	private shiftedResult(shift: AxisEdit & { revert: boolean }, cells: [number, CellView][]): EditResult {
		return { type: "shifted", sheet: 0, shift, cells, rowCount: this.rows.length, colCount: this.width(), state: this.history.state() }
	}

	// The filled cells an undone delete put back, where they now sit.
	private restoredCells({ edit, removed }: StructureStep): [number, CellView][] {
		const cells: [number, CellView][] = []

		removed.forEach((values, index) => {
			values.forEach((text, offset) => {
				const view = csvCellView(text)

				if (view !== null) {
					cells.push([edit.axis === "rows" ? cellKey(edit.at + index, offset) : cellKey(index, edit.at + offset), view])
				}
			})
		})

		return cells
	}
}
