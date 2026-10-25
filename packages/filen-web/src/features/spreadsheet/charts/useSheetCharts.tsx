import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { SheetRange } from "@filen/office/core/sheet"
import type { SheetGridHandle, SheetGridState } from "@filen/office/react/sheet"
import { SheetChart, type ChartEditType, type SheetChartEdit, type SheetChartSource } from "@filen/office/react/sheet/charts"
import type { SheetDrawingObject } from "@filen/office/react/sheet/drawings"
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu"
import { ChartPanel, type ChartPanelState } from "@/features/spreadsheet/charts/chartPanel"
import { ChartSheetView } from "@/features/spreadsheet/charts/chartSheetView"
import { CHART_TYPES } from "@/features/spreadsheet/charts/chartPanel.logic"
import { registerChartInsert } from "@/features/spreadsheet/charts/chartRequests"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { selectObject, useSelectedObject } from "@/features/spreadsheet/objects/objectSelection"

// Charts in the sheet view: each chart frame drawn from its cells (the objects overlay places it and calls
// renderChart), a chart of the selected cells inserted (the toolbar's Insert menu, the grid's menu), and the chart
// editor panel beside the grid (a chart frame double-clicked, "Edit chart…" in the grid's menu, Enter on a chartsheet's
// chart). Closed (its button, Escape, or the chart gone) while focus was in it, the panel hands focus back to where it
// was opened from, else to the grid.

export interface SheetChartsOptions {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	handle: SheetHandle
	canEdit: boolean
	// A text file: it holds no charts.
	text: boolean
}

export interface SheetCharts {
	readonly extension: SheetBodyExtension
	// The objects overlay draws chart frames with it (`scale`: the grid's zoom, which the frame's size includes).
	readonly renderChart: (object: SheetDrawingObject, width: number, height: number, scale?: number) => ReactNode
	readonly onEditObject: (object: SheetDrawingObject) => void
	// The editor panel, shown beside the grid while a chart is edited; null otherwise.
	readonly panel: ReactNode
}

interface OpenChart {
	readonly sheet: number
	readonly part: string
}

// Excel puts a new chart beside the data: here two columns right of the selection, level with its top.
function placementOf(range: SheetRange): { from: { row: number; col: number; rowOff: number; colOff: number } } {
	return { from: { row: range.startRow, col: Math.min(16_383, range.endCol + 2), rowOff: 0, colOff: 0 } }
}

// Focus that was in the panel when it unmounted lands on the body.
function focusLost(): boolean {
	return document.activeElement === null || document.activeElement === document.body
}

export function useSheetCharts({ grid, gridRef, handle, canEdit, text }: SheetChartsOptions): SheetCharts {
	const { t } = useTranslation("preview")
	const model = grid.model
	const session = handle.session
	const selected = useSelectedObject(model)
	const [open, setOpen] = useState<OpenChart | null>(null)
	const [panelState, setPanelState] = useState<ChartPanelState>({ status: "loading" })
	const [source] = useState<SheetChartSource>(() => ({
		render: (part, width, height, since) =>
			session.query("chart.render", { part, width, height, ...(since === undefined ? {} : { since }) }),
		media: partName => session.query("drawing.media", { partName })
	}))
	const drawings = text ? undefined : grid.layout?.extensions?.drawings
	const version = grid.state.version
	const chartsheet = grid.sheets.find(entry => entry.id === grid.sheet)?.kind === "chartsheet"
	// The chart of the chartsheet on show (read once per sheet).
	const [sheetChart, setSheetChart] = useState<{
		readonly sheet: number
		readonly part: string
		readonly width: number
		readonly height: number
	} | null>(null)
	const insertable = canEdit && !text
	const selectedChart =
		selected?.sheet === grid.sheet && selected.object.kind === "chart" && selected.object.chartPart !== undefined
			? selected.object
			: undefined
	const shownChart = chartsheet && sheetChart?.sheet === grid.sheet ? sheetChart : null
	const shownPart =
		open !== null &&
		open.sheet === grid.sheet &&
		(shownChart?.part === open.part || drawings?.objects.some(object => object.chartPart === open.part) === true)
			? open.part
			: null

	useEffect(() => {
		if (!chartsheet) return

		let cancelled = false
		const sheet = grid.sheet

		session.query("chart.sheet", { sheet }).then(
			found => {
				if (!cancelled) setSheetChart(found === null ? null : { sheet, ...found })
			},
			() => {
				if (!cancelled) setSheetChart(null)
			}
		)

		return () => {
			cancelled = true
		}
	}, [session, chartsheet, grid.sheet])

	// The chart left the sheet on show (deleted, undone, another sheet): its editor closes.
	if (open !== null && drawings !== undefined && shownPart === null) setOpen(null)

	// Where the editor was opened from (a chartsheet's chart), and each time it closed.
	const opener = useRef<HTMLElement | null>(null)
	const panelOpen = shownPart !== null && open !== null
	const [wasOpen, setWasOpen] = useState(panelOpen)
	const [closings, setClosings] = useState(0)

	if (wasOpen !== panelOpen) {
		setWasOpen(panelOpen)

		if (!panelOpen) setClosings(count => count + 1)
	}

	useEffect(() => {
		if (closings === 0 || !focusLost()) return

		const back = opener.current

		if (back?.isConnected === true) back.focus()
		else gridRef.current?.focus()
	}, [closings, gridRef])

	// The editor reads the chart again after every change the session reports (an edit here, undo, data).
	useEffect(() => {
		if (open === null) return

		let cancelled = false

		session.query("chart.get", { sheet: open.sheet, part: open.part }).then(
			got => {
				if (!cancelled)
					setPanelState(got === null ? { status: "gone" } : { status: "ready", info: got.info, readOnly: got.refusal !== null })
			},
			() => {
				if (!cancelled) setPanelState({ status: "gone" })
			}
		)

		return () => {
			cancelled = true
		}
	}, [session, open, version])

	const openPart = (part: string): void => {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
		setPanelState({ status: "loading" })
		setOpen({ sheet: grid.sheet, part })
	}

	const openEditor = (object: SheetDrawingObject): void => {
		if (object.chartPart !== undefined && object.kind === "chart") openPart(object.chartPart)
	}

	const insert = async (type: ChartEditType): Promise<void> => {
		const sheet = grid.sheet
		let range = grid.selection.ranges[0]

		if (range === undefined) return

		// One cell: the data around it, as Excel charts the current region.
		if (range.startRow === range.endRow && range.startCol === range.endCol)
			range = await session.query("dataRegion", { sheet, row: range.startRow, col: range.startCol })

		void model.intent()

		const result = await model.command({ type: "chart.insert", sheet, range, chart: type, placement: placementOf(range) })

		if (!result.ok) return

		const added = model.layout(sheet)?.extensions?.drawings?.objects.at(-1)

		if (added?.chartPart !== undefined) {
			selectObject(model, { sheet, key: added.key })
			opener.current = null
			setPanelState({ status: "loading" })
			setOpen({ sheet, part: added.chartPart })
		}
	}

	// The toolbar's Insert menu asks for a chart of the selection.
	const onRequest = useEffectEvent((type: ChartEditType) => {
		if (insertable) void insert(type)
	})

	useEffect(
		() =>
			registerChartInsert(model, type => {
				onRequest(type)
			}),
		[model]
	)

	const edit = (change: SheetChartEdit): void => {
		if (open === null) return

		void model.intent()
		void model.command({ type: "chart.edit", sheet: open.sheet, part: open.part, edit: change })
	}

	const renderChart = (object: SheetDrawingObject, width: number, height: number, scale = 1): ReactNode =>
		object.chartPart === undefined || object.kind !== "chart" ? undefined : (
			<SheetChart
				part={object.chartPart}
				width={width / (scale > 0 ? scale : 1)}
				height={height / (scale > 0 ? scale : 1)}
				source={source}
				version={version}
			/>
		)

	return {
		extension: {
			id: "charts",
			...(selectedChart !== undefined && {
				ribbon: {
					editChart: () => {
						openEditor(selectedChart)
					}
				}
			}),
			overlay:
				shownChart === null ? undefined : (
					<ChartSheetView
						part={shownChart.part}
						width={shownChart.width}
						height={shownChart.height}
						source={source}
						version={version}
						onEdit={() => {
							openPart(shownChart.part)
						}}
					/>
				),
			menuItems: text ? undefined : (
				<>
					{shownChart === null ? null : (
						<ContextMenuItem
							onClick={() => {
								openPart(shownChart.part)
							}}
						>
							{t("previewSheetChartEdit")}
						</ContextMenuItem>
					)}
					{selectedChart === undefined ? null : (
						<ContextMenuItem
							onClick={() => {
								openEditor(selectedChart)
							}}
						>
							{t("previewSheetChartEdit")}
						</ContextMenuItem>
					)}
					{insertable && !chartsheet ? (
						<ContextMenuSub>
							<ContextMenuSubTrigger>{t("previewSheetChartInsertMenu")}</ContextMenuSubTrigger>
							<ContextMenuSubContent>
								{CHART_TYPES.map(type => (
									<ContextMenuItem
										key={type.value}
										onClick={() => {
											void insert(type.value)
										}}
									>
										{t(type.key)}
									</ContextMenuItem>
								))}
							</ContextMenuSubContent>
						</ContextMenuSub>
					) : null}
				</>
			)
		},
		renderChart,
		onEditObject: openEditor,
		panel:
			shownPart === null || open === null ? null : (
				<ChartPanel
					key={open.part}
					sheet={open.sheet}
					part={open.part}
					state={panelState}
					canEdit={canEdit}
					selection={grid.selection.ranges[0]}
					onEdit={edit}
					onClose={() => {
						setOpen(null)
					}}
				/>
			)
	}
}
