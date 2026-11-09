import type { DvListItem } from "@filen/office/core/sheet"
import { validationEntry, type SheetGridState } from "@filen/office/react/sheet"

// Where a list validation's values open from: a cell, by sheet, row and column.
export function listCellKey(sheet: number, row: number, col: number): string {
	return `${String(sheet)}:${String(row)}:${String(col)}`
}

// Where the column's entries open from (Alt+Down on a cell without a list validation).
export function columnListKey(sheet: number, row: number, col: number): string {
	return `column:${listCellKey(sheet, row, col)}`
}

// Whether Alt+Down on the active cell lists its column's entries: an editable cell without a list validation, no
// entry being typed.
export function columnListShown(grid: SheetGridState, canEdit: boolean): boolean {
	const { row, col } = grid.selection.active

	return validationEntry(grid.layout, row, col)?.dropdown !== true && canEdit && !grid.readOnly && grid.editing === null
}

const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true })

// The column's entries as the list shows them: in order (Excel's AutoComplete list is sorted).
export function sortedEntries(entries: readonly DvListItem[]): DvListItem[] {
	return entries.toSorted((a, b) => COLLATOR.compare(a.text, b.text))
}

// Whether the active cell offers a list validation's values (Alt+Down opens them).
export function listShown(grid: SheetGridState, canEdit: boolean): boolean {
	const { row, col } = grid.selection.active

	return validationEntry(grid.layout, row, col)?.dropdown === true && canEdit && !grid.readOnly && grid.editing === null
}
