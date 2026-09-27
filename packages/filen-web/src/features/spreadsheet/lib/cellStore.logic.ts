import type { CellPatch, EditResult } from "@/features/spreadsheet/lib/edits"
import type { CellView, SheetView, SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { sheetWithSizes } from "@/features/spreadsheet/lib/sizes.logic"

// A sheet's cells on the page, changed without copying them: the worker's Map as it arrived, plus the
// cells edited since (null: emptied). An edit copies only that patch, which folds into a new base once it
// outgrows about the square root of the base, so an edit costs O(√cells) amortised, not O(cells).
export class CellStore {
	readonly size: number
	private readonly base: ReadonlyMap<number, CellView>
	private readonly patch: ReadonlyMap<number, CellView | null>

	constructor(base: ReadonlyMap<number, CellView>, patch: ReadonlyMap<number, CellView | null> = new Map(), size = base.size) {
		this.base = base
		this.patch = patch
		this.size = size
	}

	get(key: number): CellView | undefined {
		const patched = this.patch.get(key)

		return patched === undefined ? this.base.get(key) : (patched ?? undefined)
	}

	has(key: number): boolean {
		return this.get(key) !== undefined
	}

	*keys(): Generator<number> {
		for (const [key, view] of this.patch) {
			if (view !== null) {
				yield key
			}
		}

		for (const key of this.base.keys()) {
			if (!this.patch.has(key)) {
				yield key
			}
		}
	}

	with(changes: Iterable<readonly [number, CellView | null]>): CellStore {
		const patch = new Map(this.patch)
		let size = this.size

		for (const [key, view] of changes) {
			const filled = patch.has(key) ? patch.get(key) != null : this.base.has(key)

			size += (view === null ? 0 : 1) - (filled ? 1 : 0)
			patch.set(key, view)
		}

		if (patch.size <= Math.max(1024, Math.sqrt(this.base.size))) {
			return new CellStore(this.base, patch, size)
		}

		const base = new Map(this.base)

		for (const [key, view] of patch) {
			if (view === null) {
				base.delete(key)
			} else {
				base.set(key, view)
			}
		}

		return new CellStore(base)
	}
}

// A sheet or workbook as the grid holds it: the worker's view, its cells in a CellStore.
export interface GridSheet extends Omit<SheetView, "cells"> {
	cells: CellStore
}

export interface GridDoc extends Omit<SpreadsheetDoc, "sheets"> {
	sheets: GridSheet[]
}

export function gridSheet(sheet: SheetView): GridSheet {
	return { ...sheet, cells: new CellStore(sheet.cells) }
}

export function gridDoc(doc: SpreadsheetDoc): GridDoc {
	return { ...doc, sheets: doc.sheets.map(gridSheet) }
}

function patched(sheet: GridSheet, patch: CellPatch): GridSheet {
	return {
		...sheet,
		cells: sheet.cells.with(patch.cells),
		// The view's extent also covers merges and formats, which a patch's does not.
		rowCount: Math.max(sheet.rowCount, patch.rowCount),
		colCount: Math.max(sheet.colCount, patch.colCount)
	}
}

// A sheet after a structural edit: the one sent, or (null) the one held, kept as it is so its cells and
// axes are not rebuilt. The result's length is the new sheet count, so an undone "add sheet" drops one.
function kept(doc: GridDoc, sheet: SheetView | null, index: number): GridSheet {
	if (sheet !== null) {
		return gridSheet(sheet)
	}

	const held = doc.sheets[index]

	if (held === undefined) {
		throw new Error(`spreadsheet: no sheet ${String(index)} to keep`)
	}

	return held
}

// Folds an edit's result into the view: patched cells for a cell edit (one patch per sheet it reached),
// the changed sheets for anything structural.
export function applyEditResult(doc: GridDoc, result: EditResult): GridDoc {
	switch (result.type) {
		case "cells": {
			const sheets = [...doc.sheets]

			for (const patch of result.patches) {
				const sheet = sheets[patch.sheet]

				if (sheet !== undefined) {
					sheets[patch.sheet] = patched(sheet, patch)
				}
			}

			return { ...doc, sheets, styles: result.styles.length > 0 ? result.styles : doc.styles }
		}
		case "sheets":
			return {
				...doc,
				sheets: result.sheets.map((sheet, index) => kept(doc, sheet, index)),
				styles: result.styles.length > 0 ? result.styles : doc.styles
			}
		case "sizes": {
			const sheet = doc.sheets[result.sheet]

			if (sheet === undefined) {
				return doc
			}

			const sheets = [...doc.sheets]

			sheets[result.sheet] = sheetWithSizes(sheet, result.axis, result.sizes)

			return { ...doc, sheets }
		}
		case "refused":
		case "none":
			return doc
	}
}
