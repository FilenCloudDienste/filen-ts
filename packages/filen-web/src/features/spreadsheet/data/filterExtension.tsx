import { useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ArrowDownAZIcon, ArrowDownZAIcon, FilterIcon, FilterXIcon, RefreshCwIcon } from "lucide-react"
import type { SheetCommand, SheetFilterCriteria, SheetId } from "@filen/office/core/sheet"
import {
	FILTER_BUTTONS_LAYER,
	entryText,
	filterButtonAt,
	inFilterButton,
	type SheetCellPointer,
	type SheetCellPointerResult,
	type SheetGridExtension,
	type SheetGridHandle,
	type SheetGridModel,
	type SheetGridState,
	type SheetShortcut
} from "@filen/office/react/sheet"
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { FilterConditionDialog, FilterTop10Dialog } from "@/features/spreadsheet/data/filterDialogs"
import { FilterMenu } from "@/features/spreadsheet/data/filterMenu"
import { clearFilters, openCustomSort, quickSort, reapplyFilters, toggleFilter } from "@/features/spreadsheet/data/sortCommands"
import { SortDialog } from "@/features/spreadsheet/data/sortDialog"
import { clearTarget, filterAt, isFiltered, valueCriteria } from "@/features/spreadsheet/data/sortFilter.logic"
import { setSortFilterOpen, useSortFilterOpen } from "@/features/spreadsheet/data/sortFilterState"
import { useLatestRef } from "@/lib/useLatestRef"

// Sorting and autofilters in the sheet view: the grid draws each filter header's buttons (a press on one opens its
// menu beside it), the grid's menu sorts and filters by the active cell, Ctrl+Shift+L (Cmd+Shift+F on a Mac) turns
// the filter on or off, and the custom sort and condition dialogs open from the menus. A text file holds neither.

export interface SheetSortFilterOptions {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	handle: SheetHandle
	canEdit: boolean
	// A text file (csv, tsv): no sort or filter is saved in it.
	text: boolean
	run: (command: SheetCommand) => void
}

// What a held cell shows; `version` (the session's, when it was read) is what it depends on beside the cell.
function cellText(model: SheetGridModel, sheet: SheetId, row: number, col: number, version: number): string {
	const found = version < 0 ? null : model.entry(sheet, row, col)

	return found === null ? "" : entryText(found.tile, found.entry)
}

export function useSheetSortFilter({ grid, gridRef, handle, canEdit, text, run }: SheetSortFilterOptions): SheetBodyExtension {
	const { t } = useTranslation("preview")
	const model = grid.model
	const open = useSortFilterOpen(model)
	const { layout, selection } = grid
	const rightToLeft = layout?.rightToLeft ?? false
	const usable = canEdit && !text

	function pointer(event: SheetCellPointer): SheetCellPointerResult {
		if (event.kind !== "down" || event.editing || text) return undefined

		const current = model.getSnapshot().layout
		const target = filterButtonAt(current, event.row, event.col)
		const cell = target === null ? null : (gridRef.current?.clientRect({ row: event.row, col: event.col }) ?? null)

		if (target === null || cell === null || current === null) return false
		if (!inFilterButton(cell, event.clientX, event.clientY, model.scale(current), current.rightToLeft)) return false

		// A second press on the button of the open menu closes it.
		const shown = open?.type === "menu" && open.row === event.row && open.col === event.col

		setSortFilterOpen(model, shown ? null : { type: "menu", row: event.row, col: event.col })

		return true
	}

	const pointerRef = useLatestRef(pointer)
	const [gridExtension] = useState<SheetGridExtension>(() => ({
		id: "sortFilter",
		layers: [FILTER_BUTTONS_LAYER],
		pointer: event => pointerRef.current(event)
	}))

	function oneRange(done: boolean): void {
		if (!done) {
			toast.error(t("previewSheetSortOneRange"))
		}
	}

	// Filter by the active cell's value (or fill colour): in the filter it is in, or in a new one on its data.
	async function filterBySelected(by: "value" | "color"): Promise<void> {
		const snapshot = model.getSnapshot()
		const { row, col } = snapshot.selection.active
		const found = model.entry(snapshot.sheet, row, col)
		const fill = found === null ? undefined : model.style(found.tile.styles[found.entry] ?? 0).fill
		const criteria: SheetFilterCriteria =
			by === "color" ? { kind: "color", cell: true, color: fill ?? null } : valueCriteria(snapshot.active.text, null)

		if (filterAt(snapshot.layout, row, col) === null) {
			if (!(await toggleFilter(model))) {
				oneRange(false)

				return
			}
		}

		void model.intent()
		void model.command({ type: "filter.column", sheet: snapshot.sheet, row, col, criteria })
	}

	function shortcut(key: SheetShortcut): boolean {
		switch (key) {
			case "filter":
				if (usable) void toggleFilter(model).then(oneRange)

				return true
			case "sortAscending":
			case "sortDescending":
				if (canEdit) void quickSort(model, key === "sortDescending").then(oneRange)

				return true
			// The filters of the active cell's data, as the ribbon's Clear and Reapply act.
			case "clearFilters":
			case "reapplyFilter": {
				const snapshot = model.getSnapshot()

				if (usable && clearTarget(snapshot.layout, snapshot.selection.active.row, snapshot.selection.active.col) !== null) {
					if (key === "clearFilters") clearFilters(model)
					else reapplyFilters(model)
				}

				return true
			}
			default:
				break
		}

		// Alt+Down on a filter header opens its menu; elsewhere another drop-down may take it.
		if (key === "openDropdown") {
			const snapshot = model.getSnapshot()
			const { row, col } = snapshot.selection.active

			if (filterButtonAt(snapshot.layout, row, col) === null) return false

			setSortFilterOpen(model, { type: "menu", row, col })

			return true
		}

		return false
	}

	const active = selection.active
	const inFilter = filterAt(layout, active.row, active.col)
	const filtered = clearTarget(layout, active.row, active.col) !== null
	const menuRange = open?.type === "menu" ? filterAt(layout, open.row, open.col) : null
	const headerName = inFilter === null ? "" : cellText(model, grid.sheet, inFilter.range.startRow, active.col, grid.state.version)

	const sortItems = (
		<ContextMenuSub>
			<ContextMenuSubTrigger disabled={!canEdit}>{t("previewSheetSortMenu")}</ContextMenuSubTrigger>
			<ContextMenuSubContent data-preview-surface>
				<ContextMenuItem
					onClick={() => {
						void quickSort(model, false).then(oneRange)
					}}
				>
					<ArrowDownAZIcon />
					{t("previewSheetSortAscending")}
				</ContextMenuItem>
				<ContextMenuItem
					onClick={() => {
						void quickSort(model, true).then(oneRange)
					}}
				>
					<ArrowDownZAIcon />
					{t("previewSheetSortDescending")}
				</ContextMenuItem>
				<ContextMenuItem
					onClick={() => {
						void openCustomSort(model).then(oneRange)
					}}
				>
					{t("previewSheetSortCustom")}
				</ContextMenuItem>
			</ContextMenuSubContent>
		</ContextMenuSub>
	)
	const sortDialog =
		open?.type === "sort" ? (
			<SortDialog
				model={model}
				open={open}
				run={run}
			/>
		) : null

	// A text file sorts; it holds no filter.
	if (text) return { id: "sortFilter", menuItems: sortItems, dialogs: sortDialog }

	return {
		id: "sortFilter",
		grid: gridExtension,
		overlay:
			open?.type === "menu" && menuRange !== null ? (
				<FilterMenu
					key={`${String(grid.sheet)}:${String(open.row)}:${String(open.col)}`}
					model={model}
					gridRef={gridRef}
					session={handle.session}
					range={menuRange}
					row={open.row}
					col={open.col}
					rightToLeft={rightToLeft}
					canEdit={canEdit}
					run={run}
				/>
			) : null,
		menuItems: (
			<>
				{sortItems}
				<ContextMenuSub>
					<ContextMenuSubTrigger disabled={!usable}>{t("previewSheetFilterMenu")}</ContextMenuSubTrigger>
					<ContextMenuSubContent data-preview-surface>
						<ContextMenuItem
							onClick={() => {
								void toggleFilter(model).then(oneRange)
							}}
						>
							<FilterIcon />
							{t("previewSheetFilter")}
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() => {
								void filterBySelected("value")
							}}
						>
							{t("previewSheetFilterBySelected")}
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() => {
								void filterBySelected("color")
							}}
						>
							{t("previewSheetFilterBySelectedColor")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={inFilter === null || !isFiltered(inFilter, active.col)}
							onClick={() => {
								run({ type: "filter.column", sheet: grid.sheet, row: active.row, col: active.col, criteria: null })
							}}
						>
							<FilterXIcon />
							{t("previewSheetFilterClearColumn", { name: headerName })}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={!filtered}
							onClick={() => {
								clearFilters(model)
							}}
						>
							{t("previewSheetFilterClearAll")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={!filtered}
							onClick={() => {
								reapplyFilters(model)
							}}
						>
							<RefreshCwIcon />
							{t("previewSheetFilterReapply")}
						</ContextMenuItem>
					</ContextMenuSubContent>
				</ContextMenuSub>
			</>
		),
		dialogs:
			open?.type === "sort" ? (
				sortDialog
			) : open?.type === "condition" ? (
				<FilterConditionDialog
					model={model}
					open={open}
					date1904={model.date1904}
					run={run}
				/>
			) : open?.type === "top10" ? (
				<FilterTop10Dialog
					model={model}
					open={open}
					run={run}
				/>
			) : null,
		shortcut
	}
}
