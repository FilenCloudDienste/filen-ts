import type { CellPatch, EditResult } from "@/features/spreadsheet/lib/edits"
import { cellKey, keyCol, keyRow, type CellView, type SheetView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { sheetWithSizes, shiftIndex, type SizeAxis } from "@/features/spreadsheet/lib/sizes.logic"

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

// A sheet's cells once `count` rows or columns are inserted or deleted at `at`: one new base holding the
// same views under their moved keys, then `restored` on top. Never with(), which would copy a large
// restore's base a second time.
export function shiftedStore(
	store: CellStore,
	axis: SizeAxis,
	kind: "insert" | "delete",
	at: number,
	count: number,
	restored: Iterable<readonly [number, CellView]>
): CellStore {
	const cells = new Map<number, CellView>()

	for (const key of store.keys()) {
		const view = store.get(key)
		const row = keyRow(key)
		const col = keyCol(key)
		const moved = shiftIndex(axis === "rows" ? row : col, kind, at, count)

		if (view !== undefined && moved !== null) {
			cells.set(axis === "rows" ? cellKey(moved, col) : cellKey(row, moved), view)
		}
	}

	for (const [key, view] of restored) {
		cells.set(key, view)
	}

	return new CellStore(cells)
}

interface Extent {
	rowCount: number
	colCount: number
}

// A sheet after a structural edit: the one sent, or (null) the one held, kept so its cells and axes are
// not rebuilt, under its new name, with the cells patched that changed on it and its extent as sent. A
// patch only ever grows a held extent, so an undone edit that grew the sheet leaves it too large until
// an exact one arrives. The result's length is the new sheet count, so an undone "add sheet" drops one.
function kept(
	doc: GridDoc,
	sheet: SheetView | null,
	index: number,
	name: string | undefined,
	patch: CellPatch | undefined,
	extent: Extent | undefined
): GridSheet {
	if (sheet !== null) {
		return gridSheet(sheet)
	}

	const held = doc.sheets[index]

	if (held === undefined) {
		throw new Error(`spreadsheet: no sheet ${String(index)} to keep`)
	}

	const named = name === undefined || name === held.name ? held : { ...held, name }
	const folded = patch === undefined ? named : patched(named, patch)

	return extent === undefined || (extent.rowCount === folded.rowCount && extent.colCount === folded.colCount)
		? folded
		: { ...folded, rowCount: extent.rowCount, colCount: extent.colCount }
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
		case "sheets": {
			const patches = new Map(result.patches?.map(patch => [patch.sheet, patch]))
			const extents = new Map(result.extents?.map(extent => [extent.sheet, extent]))

			return {
				...doc,
				sheets: result.sheets.map((sheet, index) =>
					kept(doc, sheet, index, result.names?.[index], patches.get(index), extents.get(index))
				),
				styles: result.styles.length > 0 ? result.styles : doc.styles
			}
		}
		case "shifted": {
			const sheet = doc.sheets[result.sheet]

			if (sheet === undefined) {
				return doc
			}

			const { type, axis, at, count, revert } = result.shift
			// Undoing an insert deletes the run again; undoing a delete inserts it back.
			const kind = revert ? (type === "insert" ? "delete" : "insert") : type
			const sheets = [...doc.sheets]

			// The extent as sent, not the larger of it and the held one: a delete shrinks the sheet.
			sheets[result.sheet] = {
				...sheet,
				cells: shiftedStore(sheet.cells, axis, kind, at, count, result.cells),
				rowCount: result.rowCount,
				colCount: result.colCount
			}

			return { ...doc, sheets }
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
