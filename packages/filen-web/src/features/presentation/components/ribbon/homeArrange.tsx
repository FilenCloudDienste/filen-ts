import { useTranslation } from "react-i18next"
import { BringToFrontIcon, GroupIcon, LayersIcon, UngroupIcon } from "lucide-react"
import { canGroup, canUngroup, canZOrder, zOrderOp } from "@filen/office/core/presentation"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { runGrouping, useArrange, Z_ITEMS } from "@/features/presentation/components/ribbon/arrange"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { useSelectionPane } from "@/features/presentation/lib/selectionPane"

// Home ▸ Drawing's Arrange menu, as PowerPoint's (Alt+H, S, L): Order Objects, Group Objects and the Selection Pane.
// The orders and grouping are the Arrange tab's own commands (ribbon/arrange.tsx) on the selection of the slide in view.

const MENU = 44

function ArrangeMenu({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, selected, ids, order, run } = useArrange(editor)
	const store = usePresentationEditor()?.selectionPane
	const pane = useSelectionPane(store)
	const focus = useCommandMenuFocus()
	const chosen = new Set(ids)

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxHomeArrange")}
				icon={<BringToFrontIcon />}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewPptxOrderObjects")}</DropdownMenuLabel>
					{Z_ITEMS.map(item => (
						<DropdownMenuItem
							key={item.to}
							disabled={slide === undefined || !canZOrder(order, chosen, item.to)}
							onClick={() => {
								focus.ran()

								if (slide !== undefined) run(zOrderOp(slide, ids, item.to))
							}}
						>
							<item.icon />
							{t(item.label)}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewPptxGroupObjects")}</DropdownMenuLabel>
					<DropdownMenuItem
						disabled={slide === undefined || !canGroup(selected)}
						onClick={() => {
							focus.ran()

							if (slide !== undefined) runGrouping(editor, slide, selected, "group")
						}}
					>
						<GroupIcon />
						{t("previewPptxGroup")}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={slide === undefined || !canUngroup(selected)}
						onClick={() => {
							focus.ran()

							if (slide !== undefined) runGrouping(editor, slide, selected, "ungroup")
						}}
					>
						<UngroupIcon />
						{t("previewPptxUngroup")}
					</DropdownMenuItem>
				</DropdownMenuGroup>
				{store === undefined ? null : (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								focus.ran()
								// The menu's entry toggles the pane, as PowerPoint's does.
								store.setOpen(!pane.open)
							}}
						>
							<LayersIcon />
							{t("previewPptxSelectionPane")}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export const homeArrangeGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: "drawing",
			label: context.t("previewPptxHomeArrange", { ns: "preview" }),
			icon: BringToFrontIcon,
			width: MENU,
			priority: 1,
			single: true,
			content: <ArrangeMenu editor={editor} />
		}
	]
}
