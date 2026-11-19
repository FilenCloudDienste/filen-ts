import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../protocol"
import { defineSheetFeature } from "../registry"
import type { TextSheetDocument } from "../text"
import { dataRegion, navigate, type SheetOccupancy } from "./navigate"

// Ctrl+arrow and the data region over a text file's rows: nothing is hidden.

class TextOccupancy implements SheetOccupancy {
	private readonly rows: readonly (readonly string[])[]

	constructor(document: TextSheetDocument) {
		this.rows = document.rows
	}

	filled(row: number, col: number): boolean {
		return (this.rows[row]?.[col] ?? "") !== ""
	}

	nextInCol(col: number, row: number, step: 1 | -1, until = step === 1 ? SHEET_MAX_ROWS - 1 : 0): number {
		const end = step === 1 ? Math.min(until, this.rows.length - 1) : until

		for (let at = step === 1 ? row : Math.min(row, this.rows.length - 1); step === 1 ? at <= end : at >= end; at += step)
			if (this.filled(at, col)) return at

		return -1
	}

	nextInRow(row: number, col: number, step: 1 | -1, until = step === 1 ? SHEET_MAX_COLS - 1 : 0): number {
		const values = this.rows[row]

		if (values === undefined) return -1

		const end = step === 1 ? Math.min(until, values.length - 1) : until

		for (let at = step === 1 ? col : Math.min(col, values.length - 1); step === 1 ? at <= end : at >= end; at += step)
			if ((values[at] ?? "") !== "") return at

		return -1
	}

	hiddenRow(): boolean {
		return false
	}

	hiddenCol(): boolean {
		return false
	}
}

export const textNavigateFeature = defineSheetFeature<TextSheetDocument>({
	id: "navigate",
	queries: {
		navigate: { run: (context, request) => navigate(new TextOccupancy(context.doc), request) },
		dataRegion: { run: (context, request) => dataRegion(new TextOccupancy(context.doc), request.row, request.col) }
	}
})
