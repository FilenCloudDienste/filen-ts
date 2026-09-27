import { useRef, useState } from "react"
import { spreadsheetWorker } from "@/features/spreadsheet/lib/spreadsheetClient"
import type { DocState, EditOp, EditResult } from "@/features/spreadsheet/lib/edits"
import type { SpreadsheetDoc } from "@/features/spreadsheet/lib/model"

// The grid's side of editing: operations go to the worker one after another (a later one never overtakes
// an earlier one), and each result folds into the view — patched cells for a cell edit, whole sheets for
// anything structural.
export function applyEditResult(doc: SpreadsheetDoc, result: EditResult): SpreadsheetDoc {
	switch (result.type) {
		case "cells":
			return {
				...doc,
				styles: result.styles.length > 0 ? result.styles : doc.styles,
				sheets: doc.sheets.map((sheet, index) => {
					if (index !== result.sheet) {
						return sheet
					}

					const cells = new Map(sheet.cells)

					for (const [key, view] of result.cells) {
						if (view === null) {
							cells.delete(key)
						} else {
							cells.set(key, view)
						}
					}

					return {
						...sheet,
						cells,
						rowCount: Math.max(sheet.rowCount, result.rowCount),
						colCount: Math.max(sheet.colCount, result.colCount)
					}
				})
			}
		case "sheets":
			return { ...doc, sheets: result.sheets, styles: result.styles.length > 0 ? result.styles : doc.styles }
		case "refused":
		case "none":
			return doc
	}
}

export interface SpreadsheetEdits {
	doc: SpreadsheetDoc
	state: DocState
	apply: (op: EditOp) => Promise<EditResult>
	undo: () => Promise<EditResult>
	redo: () => Promise<EditResult>
}

export function useSpreadsheetEdits(id: number, initial: SpreadsheetDoc): SpreadsheetEdits {
	const [doc, setDoc] = useState(initial)
	const [state, setState] = useState<DocState>({ dirty: false, canUndo: false, canRedo: false })
	const queue = useRef<Promise<unknown>>(Promise.resolve())

	function run(call: () => Promise<EditResult>): Promise<EditResult> {
		const next = queue.current.then(call).then(result => {
			setDoc(prev => applyEditResult(prev, result))
			setState(result.state)

			return result
		})

		queue.current = next.catch(() => undefined)

		return next
	}

	return {
		doc,
		state,
		apply: op => run(() => spreadsheetWorker().apply(id, op)),
		undo: () => run(() => spreadsheetWorker().undo(id)),
		redo: () => run(() => spreadsheetWorker().redo(id))
	}
}
