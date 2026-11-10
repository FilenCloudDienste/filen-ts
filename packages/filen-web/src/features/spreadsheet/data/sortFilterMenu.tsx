import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ArrowDownAZIcon, ArrowDownZAIcon, ChevronDownIcon, FilterIcon, FilterXIcon, ListFilterIcon, RefreshCwIcon } from "lucide-react"
import { isMacPlatform, type SheetGridState } from "@filen/office/react/sheet"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MenuShortcut } from "@/components/ui/menuShortcut"
import { clearFilters, openCustomSort, quickSort, reapplyFilters, toggleFilter } from "@/features/spreadsheet/data/sortCommands"
import { clearTarget } from "@/features/spreadsheet/data/sortFilter.logic"
import { isTextSheetKind } from "@/features/spreadsheet/lib/sheetHosts"

// The toolbar's sort and filter menu, beside Find: sort the selection (or the data around the active cell) by the
// active column, the custom sort dialog, and the autofilter: on or off, cleared, applied again (a text file sorts,
// and holds no filter).
export function SortFilterMenu({ grid, disabled }: { grid: SheetGridState; disabled: boolean }) {
	const { t } = useTranslation("preview")
	const model = grid.model
	const [mac] = useState(isMacPlatform)
	const filtered = clearTarget(grid.layout, grid.selection.active.row, grid.selection.active.col) !== null
	const filterOn = grid.layout?.extensions?.filters?.ranges.some(range => range.table === null) === true
	const text = isTextSheetKind(model.kind)

	function oneRange(done: boolean): void {
		if (!done) {
			toast.error(t("previewSheetSortOneRange"))
		}
	}

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="sm"
									disabled={disabled}
									aria-label={t("previewSheetSortFilter")}
									className="shrink-0 gap-0.5 px-1.5"
								>
									<ListFilterIcon />
									<ChevronDownIcon className="size-3" />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("previewSheetSortFilter")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent data-preview-surface>
				<DropdownMenuItem
					onClick={() => {
						void quickSort(model, false).then(oneRange)
					}}
				>
					<ArrowDownAZIcon />
					{t("previewSheetSortAscending")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						void quickSort(model, true).then(oneRange)
					}}
				>
					<ArrowDownZAIcon />
					{t("previewSheetSortDescending")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						void openCustomSort(model).then(oneRange)
					}}
				>
					{t("previewSheetSortCustom")}
				</DropdownMenuItem>
				{text ? null : (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={filterOn}
							onCheckedChange={() => {
								void toggleFilter(model).then(oneRange)
							}}
						>
							<FilterIcon />
							{t("previewSheetFilter")}
							<MenuShortcut className="text-xs text-muted-foreground">{mac ? "⇧⌘F" : "Ctrl+Shift+L"}</MenuShortcut>
						</DropdownMenuCheckboxItem>
						<DropdownMenuItem
							disabled={!filtered}
							onClick={() => {
								clearFilters(model)
							}}
						>
							<FilterXIcon />
							{t("previewSheetFilterClearAll")}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={!filtered}
							onClick={() => {
								reapplyFilters(model)
							}}
						>
							<RefreshCwIcon />
							{t("previewSheetFilterReapply")}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
