import type { SheetCommand } from "@filen/office/core/sheet"
import { entryText, type SheetGridModel } from "@filen/office/react/sheet"
import { clearTarget, filterAt, guessHeader, headerCellKind, type SortTarget } from "@/features/spreadsheet/data/sortFilter.logic"
import { setSortFilterOpen } from "@/features/spreadsheet/data/sortFilterState"

// The sort and filter commands as the toolbar's menu, the grid's menu and the shortcuts give them, from the grid's
// selection: one cell sorts (or filters) the data around it, or the filter range it is in; a range sorts itself.

function send(model: SheetGridModel, command: SheetCommand): void {
	void model.intent()
	void model.command(command)
}

// The cells a sort or a new filter takes: the selection when it is a range; for one cell, the filter it is in (its
// header kept) or the data region around it. Null for a selection of several ranges.
export async function sortTarget(model: SheetGridModel): Promise<SortTarget | null> {
	const { sheet, selection, layout } = model.getSnapshot()

	const range = selection.ranges.length === 1 ? selection.ranges[0] : undefined

	if (range === undefined) return null
	const { row, col } = selection.active
	const single = range.startRow === range.endRow && range.startCol === range.endCol

	if (single) {
		const filter = filterAt(layout, row, col)

		if (filter !== null) return { range: filter.range, header: true, filtered: true }
	}

	const region = single ? await model.session.query("dataRegion", { sheet, row, col }) : range
	const header = guessHeader(region, (r, c) => {
		const found = model.entry(sheet, r, c)

		if (found === null) return { kind: "empty", style: 0 }

		return {
			kind: headerCellKind(found.tile.flags[found.entry] ?? 0, entryText(found.tile, found.entry)),
			style: found.tile.styles[found.entry] ?? 0
		}
	})

	return { range: region, header, filtered: false }
}

// Sort A to Z (Z to A) by the active cell's column. False when the selection is several ranges.
export async function quickSort(model: SheetGridModel, descending: boolean): Promise<boolean> {
	const target = await sortTarget(model)

	if (target === null) return false

	const { sheet, selection } = model.getSnapshot()

	send(model, {
		type: "sort.apply",
		sheet,
		range: target.range,
		orientation: "rows",
		header: target.header,
		caseSensitive: false,
		keys: [{ index: Math.min(Math.max(selection.active.col, target.range.startCol), target.range.endCol), descending }]
	})

	return true
}

// Opens the custom sort dialog over the target. False when the selection is several ranges.
export async function openCustomSort(model: SheetGridModel): Promise<boolean> {
	const target = await sortTarget(model)

	if (target === null) return false

	const { col } = model.getSnapshot().selection.active

	setSortFilterOpen(model, {
		type: "sort",
		range: target.range,
		header: target.header,
		key: Math.min(Math.max(col, target.range.startCol), target.range.endCol)
	})

	return true
}

// Ctrl+Shift+L: the sheet's filter off, a table's buttons on or off, or a filter on the selection (one cell: its data
// region).
export async function toggleFilter(model: SheetGridModel): Promise<boolean> {
	const { sheet, selection, layout } = model.getSnapshot()
	const own = layout?.extensions?.filters?.ranges.find(range => range.table === null)

	if (own !== undefined) {
		send(model, { type: "filter.toggle", sheet, range: own.range, active: selection.active })

		return true
	}

	const target = await sortTarget(model)

	if (target === null) return false

	send(model, { type: "filter.toggle", sheet, range: target.range, active: selection.active })

	return true
}

function filterCell(model: SheetGridModel): { row: number; col: number } | null {
	const { selection, layout } = model.getSnapshot()

	return clearTarget(layout, selection.active.row, selection.active.col)
}

export function clearFilters(model: SheetGridModel): void {
	const cell = filterCell(model)

	if (cell !== null) send(model, { type: "filter.clear", sheet: model.getSnapshot().sheet, ...cell })
}

export function reapplyFilters(model: SheetGridModel): void {
	const cell = filterCell(model)

	if (cell !== null) send(model, { type: "filter.reapply", sheet: model.getSnapshot().sheet, ...cell })
}
