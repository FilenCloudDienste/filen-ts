import { csvCellView, csvDoc, serializeCsv, type CsvFormat } from "@/features/spreadsheet/lib/csvView"
import { MAX_COLS, MAX_EDIT_CELLS, MAX_ROWS, type DocState, type EditOp, type EditResult } from "@/features/spreadsheet/lib/edits"
import { cellKey, keyCol, keyRow, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"

const HISTORY_LIMIT = 100

type Step = { type: "cells"; before: Map<number, string> } | { type: "rows"; rows: string[][] }

// An open CSV or TSV: its rows of text (a CSV holds no formulas or formats: what is typed is what is
// stored, a leading "=" included), the way the file was written, and an undo history. Worker-side only.
export class CsvDocument {
	private rows: string[][]
	private readonly format: CsvFormat
	private undoSteps: { step: Step; op: EditOp }[] = []
	private redoOps: EditOp[] = []
	private version = 0
	private saved = 0

	constructor(rows: string[][], format: CsvFormat) {
		this.rows = rows
		this.format = format
	}

	doc(): SpreadsheetDoc {
		return csvDoc(this.rows)
	}

	private state(): DocState {
		return { dirty: this.version !== this.saved, canUndo: this.undoSteps.length > 0, canRedo: this.redoOps.length > 0 }
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

		this.undoSteps.push({ step, op })

		if (this.undoSteps.length > HISTORY_LIMIT) {
			this.undoSteps.shift()
			this.saved = this.saved === this.version - HISTORY_LIMIT ? -1 : this.saved
		}

		this.redoOps = []
		this.version++

		return this.result(op, step)
	}

	undo(): EditResult {
		const last = this.undoSteps.pop()

		if (last === undefined) {
			return { type: "none", state: this.state() }
		}

		this.redoOps.push(last.op)
		this.version--

		if (last.step.type === "rows") {
			this.rows = last.step.rows

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
		const op = this.redoOps.pop()

		if (op === undefined) {
			return { type: "none", state: this.state() }
		}

		const redoOps = this.redoOps
		const step = this.run(op)

		if (step === null) {
			return { type: "none", state: this.state() }
		}

		this.undoSteps.push({ step, op })
		this.version++
		this.redoOps = redoOps

		return this.result(op, step)
	}

	// The file's bytes as edited (nothing is marked saved: see XlsxDocument.serialize).
	serialize(): Uint8Array {
		return serializeCsv(this.rows, this.format)
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

				const rows = this.rows.map(row => row.slice())

				if (op.axis === "rows") {
					if (op.type === "insert") {
						this.rows.splice(Math.min(op.at, this.rows.length), 0, ...Array.from({ length: op.count }, (): string[] => []))
					} else {
						this.rows.splice(op.at, op.count)
					}
				} else {
					for (const row of this.rows) {
						if (op.type === "insert") {
							if (op.at < row.length) row.splice(op.at, 0, ...new Array<string>(op.count).fill(""))
						} else {
							row.splice(op.at, op.count)
						}
					}
				}

				return { type: "rows", rows }
			}
			// A CSV is one sheet, and holds no formats.
			case "addSheet":
			case "renameSheet":
			case "format":
				return null
		}
	}

	private result(op: EditOp, step: Step): EditResult {
		return step.type === "rows" || op.type !== "setCells" ? this.sheetsResult() : this.cellsResult([...step.before.keys()])
	}

	private cellsResult(keys: readonly number[]): EditResult {
		return {
			type: "cells",
			sheet: 0,
			cells: keys.map(key => [key, csvCellView(this.rows[keyRow(key)]?.[keyCol(key)] ?? "")]),
			rowCount: this.rows.length,
			colCount: this.rows.reduce((width, row) => Math.max(width, row.length), 0),
			styles: [],
			state: this.state()
		}
	}

	private sheetsResult(): EditResult {
		return { type: "sheets", sheets: this.doc().sheets, styles: [], state: this.state() }
	}
}
