import { csvCellView, csvDoc, serializeCsv, type CsvFormat } from "@/features/spreadsheet/lib/csvView"
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

const HISTORY_LIMIT = 100

type Step =
	| { type: "cells"; before: Map<number, string> }
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

			return this.sheetsResult()
		}

		const touched: number[] = []

		for (const [key, text] of last.step.before) {
			this.write(keyRow(key), keyCol(key), text)
			touched.push(key)
		}

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

	private run(op: EditOp): Step | null {
		switch (op.type) {
			case "setCells": {
				if (op.cells.length > MAX_EDIT_CELLS || op.cells.some(cell => cell.row >= MAX_ROWS || cell.col >= MAX_COLS)) {
					return null
				}

				const before = new Map<number, string>()

				for (const { row, col, input } of op.cells) {
					const key = cellKey(row, col)

					if (!before.has(key)) {
						before.set(key, this.rows[row]?.[col] ?? "")
					}

					this.write(row, col, input)
				}

				return { type: "cells", before }
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
						// into one call and throws RangeError. Clamped here, so the step below must record the
						// clamped `at`, not op.at — revertStructure() undoes exactly the range actually written.
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
					const empty = new Array<string>(op.count).fill("")

					this.rows = this.rows.map(row => (op.at < row.length ? row.slice(0, op.at).concat(empty, row.slice(op.at)) : row))
				} else {
					for (const row of this.rows) {
						removed.push(row.splice(op.at, op.count))
					}
				}

				return { type: "structure", axis: "cols", kind: op.type, at: op.at, count: op.count, removed }
			}
			// A CSV is one sheet, and holds no formats.
			case "addSheet":
			case "renameSheet":
			case "format":
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
		return step.type === "structure" || op.type !== "setCells" ? this.sheetsResult() : this.cellsResult([...step.before.keys()])
	}

	private cellsResult(keys: readonly number[]): EditResult {
		return {
			type: "cells",
			patches: [
				{
					sheet: 0,
					cells: keys.map((key): [number, CellView | null] => [key, csvCellView(this.rows[keyRow(key)]?.[keyCol(key)] ?? "")]),
					rowCount: this.rows.length,
					colCount: this.rows.reduce((width, row) => Math.max(width, row.length), 0)
				}
			],
			styles: [],
			state: this.state()
		}
	}

	private sheetsResult(): EditResult {
		return { type: "sheets", sheets: this.doc().sheets, styles: [], state: this.state() }
	}
}
