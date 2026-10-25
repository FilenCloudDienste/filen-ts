import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { SheetCommand } from "@filen/office/core/sheet"
import type { SheetGridState } from "@filen/office/react/sheet"
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu"
import type { PreviewKey } from "@/lib/i18n"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import { SheetSeriesDialog } from "@/features/spreadsheet/fill/seriesDialog"

const DIRECTIONS: readonly { readonly direction: "down" | "right" | "up" | "left"; readonly key: PreviewKey }[] = [
	{ direction: "down", key: "previewSheetFillDown" },
	{ direction: "right", key: "previewSheetFillRight" },
	{ direction: "up", key: "previewSheetFillUp" },
	{ direction: "left", key: "previewSheetFillLeft" }
]

// Filling from the grid's menu: Down, Right, Up and Left (as Ctrl+D and Ctrl+R) and the Series dialog, as Excel's
// Home > Fill offers them. The fill handle and the keys are the grid's own.
export function useSheetFill({
	grid,
	canEdit,
	run
}: {
	grid: SheetGridState
	canEdit: boolean
	run: (command: SheetCommand) => void
}): SheetBodyExtension {
	const { t } = useTranslation("preview")
	const [seriesOpen, setSeriesOpen] = useState(false)

	return {
		id: "fill",
		...(canEdit && {
			ribbon: {
				fillSeries: () => {
					setSeriesOpen(true)
				}
			}
		}),
		menuItems: canEdit ? (
			<ContextMenuSub>
				<ContextMenuSubTrigger>{t("previewSheetFill")}</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					{DIRECTIONS.map(item => (
						<ContextMenuItem
							key={item.direction}
							onClick={() => {
								run({ type: "fill.copy", sheet: grid.sheet, ranges: grid.selection.ranges, direction: item.direction })
							}}
						>
							{t(item.key)}
						</ContextMenuItem>
					))}
					<ContextMenuItem
						onClick={() => {
							setSeriesOpen(true)
						}}
					>
						{t("previewSheetFillSeries")}
					</ContextMenuItem>
				</ContextMenuSubContent>
			</ContextMenuSub>
		) : undefined,
		dialogs: (
			<SheetSeriesDialog
				open={seriesOpen && canEdit}
				grid={grid}
				run={run}
				onClose={() => {
					setSeriesOpen(false)
				}}
			/>
		)
	}
}
