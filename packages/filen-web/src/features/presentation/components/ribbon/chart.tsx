import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChartColumnIcon, Heading1Icon, ListIcon, SlidersHorizontalIcon, TableIcon, TagIcon } from "lucide-react"
import {
	chartEditOp,
	chartLabelsEdit,
	chartLegendEdit,
	chartTitleEdit,
	chartTypeEdit,
	type ShapeRef
} from "@filen/office/core/presentation"
import type { ChartData } from "@filen/office/dom/presentation"
import { selectedShapes, useShapeSelection } from "@filen/office/react/presentation"
import type { ChartEditType, SheetChartEdit } from "@filen/office/react/sheet/charts"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { ChartDataDialog } from "@/features/presentation/components/chartDataDialog"
import { CHART_ICONS } from "@/features/presentation/components/ribbon/insertCharts"
import { useRibbonDialog } from "@/features/presentation/components/ribbon/ribbonDialogs"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { ChartPanel } from "@/features/spreadsheet/charts/chartPanel"
import { CHART_TYPES, LEGEND_OPTIONS, editableType, typeKey } from "@/features/spreadsheet/charts/chartPanel.logic"

// The Chart tab, on the one chart selected: Edit data (its workbook in the sheet engine), the chart's type, its title,
// legend and data labels, and Format chart (the spreadsheet's chart editor panel: series, axes and the rest). What the
// chart holds is read from the worker for each render of its slide; every command is one op. A chart the editor
// cannot read (one the converter does not draw) shows the tab off.

const BUTTON = 30
const MENU = 44

interface SelectedChart {
	readonly target: ShapeRef
	readonly revision: number
}

function useSelectedChart(editor: PresentationRibbonEditor): SelectedChart | undefined {
	const state = useShapeSelection(editor.selection)
	const selected = selectedShapes(editor.render, state)
	const only = selected.length === 1 && selected[0]?.role === "chart" ? selected[0] : undefined
	const slide = editor.render?.ref

	return only === undefined || slide === undefined
		? undefined
		: { target: { slide, id: only.id }, revision: editor.render?.revision ?? -1 }
}

// What the chart holds, read once per render of its slide (an edit's answer renders it again) and shared by the
// tab's groups: the last read is kept per session.
const reads = new WeakMap<PresentationRibbonEditor["session"], { readonly key: string; readonly data: Promise<ChartData> }>()

function chartDataOf(editor: PresentationRibbonEditor, target: ShapeRef, key: string): Promise<ChartData> {
	const held = reads.get(editor.session)

	if (held?.key === key) return held.data

	const data = editor.session.chartData(target).catch((): ChartData => ({ info: null, data: false }))

	reads.set(editor.session, { key, data })

	return data
}

function useChartData(editor: PresentationRibbonEditor, chart: SelectedChart | undefined): ChartData | undefined {
	const [read, setRead] = useState<{ readonly key: string; readonly data: ChartData } | undefined>(undefined)
	const key = chart === undefined ? "" : `${String(chart.target.slide)}:${String(chart.target.id)}:${String(chart.revision)}`
	const target = chart?.target

	useEffect(() => {
		if (target === undefined) return undefined

		let live = true

		void chartDataOf(editor, target, key).then(data => {
			if (live) setRead({ key, data })
		})

		return () => {
			live = false
		}
	}, [editor, target, key])

	return read?.key === key ? read.data : undefined
}

// Format chart: the spreadsheet's chart panel on the chart `target`, while it stays the one selected. Between an
// edit and the next read it keeps showing the last read, so the panel is not torn down by each edit.
function ChartFormatDialog({ editor, target, onClose }: { editor: PresentationRibbonEditor; target: ShapeRef; onClose: () => void }) {
	const { t } = useTranslation("preview")
	const chart = useSelectedChart(editor)
	const same = chart?.target.slide === target.slide && chart.target.id === target.id
	const read = useChartData(editor, same ? chart : undefined)?.info ?? null
	const [last, setLast] = useState<ChartData["info"]>(null)

	if (read !== null && read !== last) setLast(read)

	const info = same ? (read ?? last) : null

	if (info === null) return null

	return (
		<Dialog
			open
			onOpenChange={open => {
				if (!open) onClose()
			}}
		>
			<DialogContent
				data-preview-surface
				className="flex max-h-[calc(100dvh-2rem)] flex-col gap-2 overflow-y-auto p-0 sm:max-w-md"
			>
				<DialogHeader className="px-4 pt-4">
					<DialogTitle>{t("previewPptxChartFormatTitle")}</DialogTitle>
					<DialogDescription className="sr-only">{t("previewPptxChartFormat")}</DialogDescription>
				</DialogHeader>
				<ChartPanel
					sheet={0}
					part={`${String(target.slide)}:${String(target.id)}`}
					state={{ status: "ready", info, readOnly: false }}
					canEdit
					selection={undefined}
					onEdit={edit => {
						void editor.command(chartEditOp(target, edit))
					}}
					onClose={onClose}
				/>
			</DialogContent>
		</Dialog>
	)
}

function ChartControls({ editor, group }: { editor: PresentationRibbonEditor; group: "data" | "type" | "elements" }) {
	const { t } = useTranslation("preview")
	const chart = useSelectedChart(editor)
	const data = useChartData(editor, chart)
	const info = data?.info ?? null
	const dialog = useRibbonDialog(editor)
	const off = chart === undefined || info === null
	const run = (edit: SheetChartEdit): void => {
		if (chart !== undefined) void editor.command(chartEditOp(chart.target, edit))
	}
	const plot = info?.plots[0]
	const type = plot === undefined || !editableType(plot.type) ? undefined : plot.type
	const labelsShown = info?.plots.some(each => each.labels !== null) === true

	return (
		<>
			{group === "data" ? (
				<RibbonButton
					label={data !== undefined && !data.data ? t("previewPptxChartLinkedData") : t("previewPptxChartEditData")}
					text={t("previewPptxChartEditData")}
					icon={<TableIcon />}
					disabled={chart === undefined || data?.data !== true}
					onClick={() => {
						if (chart === undefined) return

						const target = chart.target

						dialog.open((live, close) => (
							<ChartDataDialog
								editor={live}
								target={target}
								onClose={close}
							/>
						))
					}}
				/>
			) : group === "type" ? (
				<DropdownMenu>
					<RibbonMenuTrigger
						label={off ? t("previewPptxChartReadOnly") : t("previewPptxChartType")}
						icon={type === undefined ? <ChartColumnIcon /> : <TypeIcon type={type} />}
						disabled={off}
					/>
					<DropdownMenuContent data-preview-surface>
						<DropdownMenuGroup>
							<DropdownMenuLabel>{t("previewPptxChartType")}</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={type ?? ""}
								onValueChange={value => {
									const next = CHART_TYPES.find(entry => entry.value === value)?.value
									const edit = info === null || next === undefined ? undefined : chartTypeEdit(info, next)

									if (edit !== undefined) run(edit)
								}}
							>
								{CHART_TYPES.map(entry => (
									<DropdownMenuRadioItem
										key={entry.value}
										value={entry.value}
									>
										<TypeIcon type={entry.value} />
										{t(typeKey(entry.value))}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				<>
					<RibbonButton
						label={t("previewPptxChartTitle")}
						icon={<Heading1Icon />}
						disabled={off}
						pressed={info?.title !== null && info !== null}
						onClick={() => {
							run(chartTitleEdit(info?.title === null ? "" : null))
						}}
					/>
					<DropdownMenu>
						<RibbonMenuTrigger
							label={t("previewPptxChartLegend")}
							icon={<ListIcon />}
							disabled={off}
						/>
						<DropdownMenuContent data-preview-surface>
							<DropdownMenuGroup>
								<DropdownMenuLabel>{t("previewPptxChartLegend")}</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={info?.legend ?? "none"}
									onValueChange={value => {
										const option = LEGEND_OPTIONS.find(entry => entry.value === value)

										if (option !== undefined) run(chartLegendEdit(option.value === "none" ? null : option.value))
									}}
								>
									{LEGEND_OPTIONS.map(entry => (
										<DropdownMenuRadioItem
											key={entry.value}
											value={entry.value}
										>
											{t(entry.key)}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<RibbonButton
						label={t("previewPptxChartLabels")}
						icon={<TagIcon />}
						disabled={off}
						pressed={labelsShown}
						onClick={() => {
							run(chartLabelsEdit(!labelsShown))
						}}
					/>
					<RibbonButton
						label={t("previewPptxChartFormat")}
						icon={<SlidersHorizontalIcon />}
						disabled={off}
						onClick={() => {
							if (chart === undefined) return

							const target = chart.target

							dialog.open((live, close) => (
								<ChartFormatDialog
									editor={live}
									target={target}
									onClose={close}
								/>
							))
						}}
					/>
				</>
			)}
			{dialog.view}
		</>
	)
}

function TypeIcon({ type }: { type: ChartEditType }) {
	const Icon = CHART_ICONS[type]

	return <Icon />
}

export const chartGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	const t = context.t

	return [
		{
			id: "chartData",
			label: t("previewPptxChartData", { ns: "preview" }),
			icon: TableIcon,
			width: 3 * BUTTON,
			priority: 4,
			content: (
				<ChartControls
					editor={editor}
					group="data"
				/>
			)
		},
		{
			id: "chartType",
			label: t("previewPptxChartType", { ns: "preview" }),
			icon: ChartColumnIcon,
			width: MENU,
			priority: 4,
			single: true,
			content: (
				<ChartControls
					editor={editor}
					group="type"
				/>
			)
		},
		{
			id: "chartElements",
			label: t("previewPptxChartElements", { ns: "preview" }),
			icon: ListIcon,
			width: 3 * BUTTON + MENU,
			priority: 3,
			content: (
				<ChartControls
					editor={editor}
					group="elements"
				/>
			)
		}
	]
}
