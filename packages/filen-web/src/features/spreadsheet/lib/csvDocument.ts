import { canEncodeWindows1252, csvCellView, csvDoc, serializeCsv, type CsvFormat } from "@/features/spreadsheet/lib/csvView"
import {
	MAX_COLS,
	MAX_EDIT_CELLS,
	MAX_ROWS,
	MAX_SHEET_CELLS,
	type DocState,
	type EditOp,
	type EditResult
} from "@/features/spreadsheet/lib/edits"
import { cellKey, keyCol, keyRow, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import type { AxisShift } from "@/features/spreadsheet/lib/sizes.logic"

const HISTORY_LIMIT = 100

type Step =
	// `rowCount`/`rowWidths` are the sheet's extent just before this step's writes grew it — a setCells past
	// the current edge grows `rows` (see write()), and nothing else shrinks it back on undo.
	| { type: "cells"; before: Map<number, string>; rowCount: number; rowWidths: Map<number, number> }
	| { type: "structure"; axis: "rows" | "cols"; kind: "insert" | "delete"; at: number; count: number; removed: string[][] }

// How many cells a step's snapshot holds, for the history's total memory budget.
function stepWeight(step: Step): number {
	return step.type === "cells" ? step.before.size : step.removed.reduce((total, row) => total + row.length, 0)
}

// An open CSV or TSV: its rows of text (a CSV holds no formulas or formats: what is typed is what is
// stored, a leading "=" included), the way the file was written, and an undo history. Worker-side only.
export class CsvDocument {
	private rows: string[][]
	private readonly format: CsvFormat
	private undoSteps: { step: Step; op: EditOp; before: number; after: number }[] = []
	private redoSteps: { op: EditOp; after: number }[] = []
	private historyWeight = 0
	// Identifies the current state; `saved` is the state last written to the file (0: as opened).
	private current = 0
	private nextState = 1
	private saved = 0

	constructor(rows: string[][], format: CsvFormat) {
		this.rows = rows
		this.format = format
	}

	doc(): SpreadsheetDoc {
		return csvDoc(this.rows, this.format.writable)
	}

	private state(): DocState {
		return { dirty: this.current !== this.saved, canUndo: this.undoSteps.length > 0, canRedo: this.redoSteps.length > 0 }
	}

	apply(op: EditOp): EditResult {
		// A windows-1252 file's saved encoding never changes behind the user's back (see serializeCsv): a
		// cell that would hold a character the table cannot represent is refused outright, before any row is
		// touched, rather than silently reformatting the whole file to UTF-8 and corrupting every untouched
		// cell's bytes on the next save.
		if (op.type === "setCells" && this.format.encoding === "windows-1252" && op.cells.some(cell => !canEncodeWindows1252(cell.input))) {
			return { type: "refused", reason: "encoding", state: this.state() }
		}

		// Rows or columns inserted past the data move nothing: the file stays as it is.
		if (op.type === "insert" && this.pastData(op.axis, op.at)) {
			return { type: "none", state: this.state() }
		}

		const step = this.run(op)

		if (step === null) {
			return {
				type: "refused",
				reason: op.type === "addSheet" || op.type === "renameSheet" ? "sheetName" : "tooLarge",
				state: this.state()
			}
		}

		const after = this.nextState++

		this.pushStep({ step, op, before: this.current, after })
		this.redoSteps = []
		this.current = after

		return this.result(op, step)
	}

	undo(): EditResult {
		const last = this.undoSteps.pop()

		if (last === undefined) {
			return { type: "none", state: this.state() }
		}

		this.historyWeight -= stepWeight(last.step)
		this.redoSteps.push({ op: last.op, after: last.after })
		this.current = last.before

		if (last.step.type === "structure") {
			this.revertStructure(last.step)

			return this.sheetsResult(shiftOf(last.step, true))
		}

		const touched: number[] = []

		for (const [key, text] of last.step.before) {
			this.write(keyRow(key), keyCol(key), text)
			touched.push(key)
		}

		this.shrinkTo(last.step.rowCount, last.step.rowWidths)

		return this.cellsResult(touched)
	}

	redo(): EditResult {
		const redone = this.redoSteps.pop()

		if (redone === undefined) {
			return { type: "none", state: this.state() }
		}

		const redoSteps = this.redoSteps
		const step = this.run(redone.op)

		if (step === null) {
			return { type: "none", state: this.state() }
		}

		this.pushStep({ step, op: redone.op, before: this.current, after: redone.after })
		this.current = redone.after
		this.redoSteps = redoSteps

		return this.result(redone.op, step)
	}

	// The file's bytes as edited, and the state they hold.
	serialize(): { bytes: Uint8Array; version: number } {
		if (!this.format.writable) {
			throw new Error("spreadsheet: this CSV cannot be saved")
		}

		return { bytes: serializeCsv(this.rows, this.format), version: this.current }
	}

	// The state `version` names is now the file's: the document is clean exactly while it is back there.
	markSaved(version: number): DocState {
		this.saved = version

		return this.state()
	}

	// Drops the oldest undo steps once they pass HISTORY_LIMIT steps or MAX_SHEET_CELLS of snapshotted
	// cells, always keeping at least the step just pushed. Unique state ids are never reused, so a save
	// point whose step falls out of history stays unreachable, and dirty stays true, without bookkeeping.
	private pushStep(entry: { step: Step; op: EditOp; before: number; after: number }): void {
		this.undoSteps.push(entry)
		this.historyWeight += stepWeight(entry.step)

		while (this.undoSteps.length > 1 && (this.undoSteps.length > HISTORY_LIMIT || this.historyWeight > MAX_SHEET_CELLS)) {
			const dropped = this.undoSteps.shift()

			this.historyWeight -= dropped === undefined ? 0 : stepWeight(dropped.step)
		}
	}

	private width(): number {
		return this.rows.reduce((width, row) => Math.max(width, row.length), 0)
	}

	private pastData(axis: "rows" | "cols", at: number): boolean {
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
				if (op.cells.length > MAX_EDIT_CELLS || op.cells.some(cell => cell.row >= MAX_ROWS || cell.col >= MAX_COLS)) {
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

					return { type: "structure", axis: "rows", kind: op.type, at, count: op.count, removed }
				}

				const removed: string[][] = []

				if (op.type === "insert") {
					// Past the grid's last column, cells would take the keys of the next row's (cellKey).
					if (this.width() + op.count > MAX_COLS) {
						return null
					}

					const empty = new Array<string>(op.count).fill("")

					this.rows = this.rows.map(row => (op.at < row.length ? row.slice(0, op.at).concat(empty, row.slice(op.at)) : row))
				} else {
					for (const row of this.rows) {
						removed.push(row.splice(op.at, op.count))
					}
				}

				return { type: "structure", axis: "cols", kind: op.type, at: op.at, count: op.count, removed }
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
	private revertStructure(step: Extract<Step, { type: "structure" }>): void {
		if (step.axis === "rows") {
			this.rows =
				step.kind === "insert"
					? this.rows.slice(0, step.at).concat(this.rows.slice(step.at + step.count))
					: this.rows.slice(0, step.at).concat(step.removed, this.rows.slice(step.at))

			return
		}

		this.rows = this.rows.map((row, index) => {
			if (step.kind === "insert") {
				return row.length > step.at + step.count ? row.slice(0, step.at).concat(row.slice(step.at + step.count)) : row
			}

			const removedRow = step.removed[index]

			return removedRow === undefined ? row : row.slice(0, step.at).concat(removedRow, row.slice(step.at))
		})
	}

	private result(op: EditOp, step: Step): EditResult {
		if (step.type === "structure") {
			return this.sheetsResult(shiftOf(step, false))
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
			state: this.state()
		}
	}

	// `shift`: where the edit moved rows or columns, for the sizes kept beside the file.
	private sheetsResult(shift?: AxisShift & { revert: boolean }): EditResult {
		return { type: "sheets", sheets: this.doc().sheets, styles: [], state: this.state(), ...(shift === undefined ? {} : { shift }) }
	}
}

function shiftOf(step: Extract<Step, { type: "structure" }>, revert: boolean): AxisShift & { revert: boolean } {
	return { axis: step.axis, kind: step.kind, at: step.at, count: step.count, revert }
}
