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

// The list's row height (px) and how many rows it shows at most: only the rows in view are drawn, so a list of
// 32,767 values (or a long column's entries) costs a screenful of rows.
export const LIST_ROW = 28
export const LIST_ROWS = 9

// The list's visible height for this many values.
export function listHeight(count: number): number {
	return Math.min(count, LIST_ROWS) * LIST_ROW
}

// The rows drawn at a scroll offset, [first, last): those in view and a few either side.
export function listWindow(scrollTop: number, count: number): { readonly first: number; readonly last: number } {
	const first = Math.max(0, Math.floor(scrollTop / LIST_ROW) - 2)

	return { first, last: Math.min(count, first + LIST_ROWS + 4) }
}

// The scroll offset that brings a row into view, moving as little as it can (as scrollIntoView's "nearest").
export function scrollToRow(index: number, scrollTop: number, count: number): number {
	const top = index * LIST_ROW
	const view = listHeight(count)

	if (top < scrollTop) return top

	if (top + LIST_ROW > scrollTop + view) return top + LIST_ROW - view

	return scrollTop
}
