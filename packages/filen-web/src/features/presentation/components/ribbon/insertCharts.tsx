import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	ChartAreaIcon,
	ChartBarIcon,
	ChartColumnIcon,
	ChartLineIcon,
	ChartPieIcon,
	ChartScatterIcon,
	DonutIcon,
	type LucideIcon
} from "lucide-react"
import {
	INSERT_CHART_TYPES,
	insertChartOp,
	sampleChartCells,
	sampleScatterCells,
	type ChartCell,
	type InsertDeck
} from "@filen/office/core/presentation"
import type { ChartEditType } from "@filen/office/react/sheet/charts"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import { RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { insertObject, useSlideInView } from "@/features/presentation/components/ribbon/insertObjects"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { typeKey } from "@/features/spreadsheet/charts/chartPanel.logic"

// Insert ▸ Chart: a chart of each type over sample data (four categories of three series; a scatter chart's x and y
// values), centred on the slide in view as one insert op and selected; its data is then edited in Edit Data on the
// Chart tab. The worker makes the chart part and its embedded workbook (pptx) or the chart object with its own table
// (ODP).

const MENU = 44

export const CHART_ICONS: Readonly<Record<ChartEditType, LucideIcon>> = {
	column: ChartColumnIcon,
	bar: ChartBarIcon,
	line: ChartLineIcon,
	area: ChartAreaIcon,
	pie: ChartPieIcon,
	doughnut: DonutIcon,
	scatter: ChartScatterIcon
}

// A new chart's sample data in the user's language.
export function sampleCells(type: ChartEditType, t: TFunction<"preview">): ChartCell[][] {
	if (type === "scatter") return sampleScatterCells({ x: t("previewPptxChartSampleX"), y: t("previewPptxChartSampleY") })

	return sampleChartCells({
		categories: [1, 2, 3, 4].map(number => t("previewPptxChartSampleCategory", { number })),
		series: [1, 2, 3].map(number => t("previewPptxChartSampleSeries", { number }))
	})
}

function ChartMenu({ editor }: { editor: PresentationRibbonEditor }) {
	const slide = useSlideInView(editor)
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const deck: InsertDeck = { size: editor.info.size, format: editor.info.format }

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxInsertChart")}
				icon={<ChartColumnIcon />}
				disabled={slide === undefined}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewPptxInsertChartTypes")}</DropdownMenuLabel>
					{INSERT_CHART_TYPES.map(({ type }) => {
						const Icon = CHART_ICONS[type]

						return (
							<DropdownMenuItem
								key={type}
								onClick={() => {
									focus.ran()
									void insertObject(editor, (at, id) => insertChartOp(deck, at, id, type, sampleCells(type, t)))
								}}
							>
								<Icon />
								{t(typeKey(type))}
							</DropdownMenuItem>
						)
					})}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export const insertChartsGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: "chart",
			label: context.t("previewPptxInsertChart", { ns: "preview" }),
			icon: ChartColumnIcon,
			width: MENU,
			priority: 3,
			single: true,
			content: <ChartMenu editor={editor} />
		}
	]
}
