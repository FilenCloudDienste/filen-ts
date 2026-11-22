import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import type { SheetId, SheetRange } from "@filen/office/core/sheet"
import type {
	ChartAxisInfo,
	ChartAxisPatch,
	ChartInfo,
	ChartLabels,
	ChartPlotInfo,
	ChartSeriesInfo,
	SheetChartEdit
} from "@filen/office/react/sheet/charts"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import type { PreviewKey } from "@/lib/i18n"
import {
	CHART_TYPES,
	COMBO_TYPES,
	LEGEND_OPTIONS,
	axisKey,
	editableType,
	groupingOptions,
	labelPositionOptions,
	numberField,
	numberText,
	selectionReference,
	seriesLabel,
	typeKey
} from "@/features/spreadsheet/charts/chartPanel.logic"

// The chart editor beside the grid (owner's layout A): the chart's type, its series and the cells they read, its axes,
// and its title, legend and data labels. Every change is one edit the grid's chart shows at once and one undo step;
// text fields apply on Enter or when they lose focus. A chart holding what the editor cannot change shows read-only.
// Series edits name their series by its id (c:idx), so a click sent before the panel read the chart again acts on the
// series it was meant for. Opened, the panel takes focus at its heading.

export type ChartPanelState =
	| { readonly status: "loading" }
	| { readonly status: "gone" }
	| { readonly status: "ready"; readonly info: ChartInfo; readonly readOnly: boolean }

export interface ChartPanelProps {
	readonly sheet: SheetId
	readonly part: string
	readonly state: ChartPanelState
	readonly canEdit: boolean
	// The grid's selected range (a new series' values).
	readonly selection: SheetRange | undefined
	readonly onEdit: (edit: SheetChartEdit) => void
	readonly onClose: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Collapsible
			defaultOpen
			className="border-b border-border"
		>
			<CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&[data-panel-open]>svg]:rotate-180">
				{title}
				<ChevronDownIcon className="size-4 transition-transform" />
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col gap-4 px-4 pb-4">{children}</CollapsibleContent>
		</Collapsible>
	)
}

function Choice<T extends string>({
	id,
	label,
	value,
	options,
	disabled,
	onChange
}: {
	id: string
	label: string
	value: T
	options: readonly { readonly value: T; readonly key: PreviewKey }[]
	disabled: boolean
	onChange: (value: T) => void
}) {
	const { t } = useTranslation("preview")
	const items = options.map(option => ({ value: option.value, label: t(option.key) }))

	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				items={items}
				value={value}
				disabled={disabled}
				onValueChange={(next: T | null) => {
					if (next !== null && next !== value) onChange(next)
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent data-preview-surface>
					<SelectGroup>
						{items.map(item => (
							<SelectItem
								key={item.value}
								value={item.value}
							>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	)
}

function Toggle({
	id,
	label,
	checked,
	disabled,
	onChange
}: {
	id: string
	label: string
	checked: boolean
	disabled: boolean
	onChange: (checked: boolean) => void
}) {
	return (
		<Field orientation="horizontal">
			<Switch
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onChange}
			/>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
		</Field>
	)
}

// A text field applied on Enter or blur; it starts again from `value` whenever the chart changes it.
function TextField({
	id,
	label,
	value,
	placeholder,
	hint,
	mono,
	disabled,
	onCommit
}: {
	id: string
	label: string
	value: string
	placeholder?: string
	hint?: string
	mono?: boolean
	disabled: boolean
	onCommit: (text: string) => void
}) {
	const [draft, setDraft] = useState(value)
	const [shown, setShown] = useState(value)
	// What was last sent and has not come back as the chart's value yet: Enter then blur sends it once.
	const [sent, setSent] = useState<string | null>(null)

	// The chart's value changed (this edit landed, an undo, another field): the field shows it.
	if (shown !== value) {
		setShown(value)
		setDraft(value)
		setSent(null)
	}

	const commit = (): void => {
		if (draft === value || draft === sent) return

		setSent(draft)
		onCommit(draft)
	}

	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				value={draft}
				disabled={disabled}
				placeholder={placeholder}
				spellCheck={false}
				autoComplete="off"
				className={mono === true ? "font-mono" : undefined}
				onChange={event => {
					setDraft(event.target.value)
				}}
				onBlur={commit}
				onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					} else if (event.key === "Escape" && draft !== value) {
						event.preventDefault()
						event.stopPropagation()
						setDraft(value)
					}
				}}
			/>
			{hint === undefined ? null : <FieldDescription>{hint}</FieldDescription>}
		</Field>
	)
}

function PlotFields({
	plot,
	combo,
	disabled,
	onEdit
}: {
	plot: ChartPlotInfo
	combo: boolean
	disabled: boolean
	onEdit: (edit: SheetChartEdit) => void
}) {
	const { t } = useTranslation("preview")
	const types = combo ? CHART_TYPES.filter(entry => COMBO_TYPES.has(entry.value)) : CHART_TYPES
	const groupings = groupingOptions(plot.type)
	const id = `chart-plot-${String(plot.index)}`

	if (!editableType(plot.type) || (combo && !COMBO_TYPES.has(plot.type)))
		return <p className="text-sm text-muted-foreground">{t("previewSheetChartTypeReadOnly", { type: t(typeKey(plot.type)) })}</p>

	return (
		<div className="flex flex-col gap-4">
			{combo ? (
				<p className="text-xs font-medium text-muted-foreground">{t("previewSheetChartPlot", { number: plot.index + 1 })}</p>
			) : null}
			<Choice
				id={`${id}-type`}
				label={t("previewSheetChartType")}
				value={plot.type}
				options={types}
				disabled={disabled}
				onChange={type => {
					onEdit({ kind: "type", plot: plot.index, type })
				}}
			/>
			{groupings.length === 0 || plot.grouping === null ? null : (
				<Choice
					id={`${id}-grouping`}
					label={t("previewSheetChartGrouping")}
					value={plot.grouping}
					options={groupings}
					disabled={disabled}
					onChange={grouping => {
						if (editableType(plot.type)) onEdit({ kind: "type", plot: plot.index, type: plot.type, grouping })
					}}
				/>
			)}
		</div>
	)
}

function SeriesFields({
	series,
	plot,
	position,
	count,
	disabled,
	onEdit,
	onRemove
}: {
	series: ChartSeriesInfo
	plot: ChartPlotInfo
	position: number
	count: number
	disabled: boolean
	onEdit: (edit: SheetChartEdit) => void
	onRemove: () => void
}) {
	const { t } = useTranslation("preview")
	const scatter = plot.type === "scatter"
	const id = `chart-series-${String(series.index)}`

	return (
		<div
			role="group"
			aria-labelledby={`${id}-title`}
			className="flex flex-col gap-3 rounded-xl border border-border p-3"
		>
			<div className="flex items-center justify-between gap-2">
				<span
					id={`${id}-title`}
					className="truncate text-sm font-medium"
				>
					{seriesLabel(series.name, series.index, number => t("previewSheetChartSeries", { number }))}
				</span>
				<div className="flex shrink-0 items-center">
					<TooltipIconButton
						label={t("previewSheetChartSeriesUp")}
						disabled={disabled || position === 0}
						onClick={() => {
							onEdit({ kind: "series.move", series: series.index, id: series.idx, to: position - 1 })
						}}
					>
						<ArrowUpIcon />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewSheetChartSeriesDown")}
						disabled={disabled || position === count - 1}
						onClick={() => {
							onEdit({ kind: "series.move", series: series.index, id: series.idx, to: position + 1 })
						}}
					>
						<ArrowDownIcon />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewSheetChartSeriesRemove")}
						disabled={disabled}
						onClick={onRemove}
					>
						<Trash2Icon />
					</TooltipIconButton>
				</div>
			</div>
			<TextField
				id={`${id}-name`}
				label={t("previewSheetChartSeriesName")}
				value={series.nameRef === null ? series.name : `=${series.nameRef}`}
				disabled={disabled}
				onCommit={text => {
					onEdit({ kind: "series.set", series: series.index, id: series.idx, name: text === "" ? null : text })
				}}
			/>
			<TextField
				id={`${id}-values`}
				label={t(scatter ? "previewSheetChartSeriesY" : "previewSheetChartSeriesValues")}
				value={series.values ?? ""}
				mono
				disabled={disabled}
				onCommit={text => {
					onEdit({ kind: "series.set", series: series.index, id: series.idx, values: text })
				}}
			/>
			<TextField
				id={`${id}-categories`}
				label={t(scatter ? "previewSheetChartSeriesX" : "previewSheetChartSeriesCategories")}
				value={series.categories ?? ""}
				hint={t("previewSheetChartRangeHint")}
				mono
				disabled={disabled}
				onCommit={text => {
					onEdit({ kind: "series.set", series: series.index, id: series.idx, categories: text.trim() === "" ? null : text })
				}}
			/>
		</div>
	)
}

function AxisFields({
	axis,
	axes,
	disabled,
	onEdit
}: {
	axis: ChartAxisInfo
	axes: readonly ChartAxisInfo[]
	disabled: boolean
	onEdit: (edit: SheetChartEdit) => void
}) {
	const { t } = useTranslation("preview")
	const id = `chart-axis-${String(axis.id)}`
	const scaled = axis.kind === "val" || axis.kind === "date"
	const patch = (value: ChartAxisPatch): void => {
		onEdit({ kind: "axis", axis: axis.id, patch: value })
	}
	const bound = (key: "min" | "max" | "major") => (text: string) => {
		const value = numberField(text)

		// Text that is no number is refused by the session, as Excel's own field refuses it.
		patch({ [key]: value === undefined ? Number.NaN : value })
	}

	return (
		<fieldset className="flex flex-col gap-3">
			<legend className="mb-1 text-xs font-medium text-muted-foreground">{t(axisKey(axis, axes))}</legend>
			<Toggle
				id={`${id}-show`}
				label={t("previewSheetChartAxisShow")}
				checked={axis.visible}
				disabled={disabled}
				onChange={visible => {
					patch({ visible })
				}}
			/>
			<TextField
				id={`${id}-title`}
				label={t("previewSheetChartAxisTitle")}
				value={axis.title ?? ""}
				disabled={disabled}
				onCommit={text => {
					patch({ title: text === "" ? null : text })
				}}
			/>
			{scaled ? (
				<div className="grid grid-cols-2 gap-3">
					<TextField
						id={`${id}-min`}
						label={t("previewSheetChartAxisMin")}
						value={numberText(axis.min)}
						placeholder={t("previewSheetChartAuto")}
						disabled={disabled}
						onCommit={bound("min")}
					/>
					<TextField
						id={`${id}-max`}
						label={t("previewSheetChartAxisMax")}
						value={numberText(axis.max)}
						placeholder={t("previewSheetChartAuto")}
						disabled={disabled}
						onCommit={bound("max")}
					/>
					<TextField
						id={`${id}-major`}
						label={t("previewSheetChartAxisMajor")}
						value={numberText(axis.major)}
						placeholder={t("previewSheetChartAuto")}
						disabled={disabled}
						onCommit={bound("major")}
					/>
				</div>
			) : null}
			<TextField
				id={`${id}-format`}
				label={t("previewSheetChartAxisFormat")}
				value={axis.format ?? ""}
				placeholder={t("previewSheetChartLinked")}
				mono
				disabled={disabled}
				onCommit={text => {
					patch({ format: text === "" ? null : text })
				}}
			/>
			<Toggle
				id={`${id}-grid`}
				label={t("previewSheetChartGridlines")}
				checked={axis.majorGridlines}
				disabled={disabled}
				onChange={gridlines => {
					patch({ gridlines })
				}}
			/>
		</fieldset>
	)
}

const NO_LABELS: ChartLabels = { value: false, category: false, series: false, percent: false, position: null }

function LabelFields({
	plots,
	disabled,
	onEdit
}: {
	plots: readonly ChartPlotInfo[]
	disabled: boolean
	onEdit: (edit: SheetChartEdit) => void
}) {
	const { t } = useTranslation("preview")
	const first = plots.flatMap(plot => plot.series.map(series => series.labels ?? plot.labels)).find(labels => labels !== null) ?? null
	const labels = first ?? NO_LABELS
	const pie = plots.some(plot => plot.type === "pie" || plot.type === "doughnut")
	const positions = labelPositionOptions(plots)
	const set = (next: ChartLabels): void => {
		const shown = next.value || next.category || next.series || next.percent

		onEdit({ kind: "labels", plot: null, labels: shown ? next : null })
	}
	const flags: readonly { readonly key: "value" | "category" | "series" | "percent"; readonly label: PreviewKey }[] = [
		{ key: "value", label: "previewSheetChartLabelValue" },
		{ key: "category", label: "previewSheetChartLabelCategory" },
		{ key: "series", label: "previewSheetChartLabelSeries" },
		...(pie ? [{ key: "percent" as const, label: "previewSheetChartLabelPercent" as const }] : [])
	]

	return (
		<fieldset className="flex flex-col gap-3">
			<legend className="mb-1 text-xs font-medium text-muted-foreground">{t("previewSheetChartLabels")}</legend>
			{flags.map(flag => (
				<Toggle
					key={flag.key}
					id={`chart-labels-${flag.key}`}
					label={t(flag.label)}
					checked={labels[flag.key]}
					disabled={disabled}
					onChange={checked => {
						set({ ...labels, [flag.key]: checked })
					}}
				/>
			))}
			{positions.length > 1 && first !== null ? (
				<Choice
					id="chart-labels-position"
					label={t("previewSheetChartLabelPosition")}
					value={
						labels.position !== null && positions.some(option => option.value === labels.position) ? labels.position : "default"
					}
					options={positions}
					disabled={disabled}
					onChange={position => {
						set({ ...labels, position: position === "default" ? null : position })
					}}
				/>
			) : null}
		</fieldset>
	)
}

export function ChartPanel(props: ChartPanelProps) {
	const { t } = useTranslation("preview")
	const { state, onEdit } = props
	const heading = useRef<HTMLHeadingElement>(null)
	// The control that last had focus: when an edit takes it away (a removed series' buttons), focus goes to the
	// heading rather than out of the panel.
	const lastFocused = useRef<HTMLElement | null>(null)
	// Series removed since the chart was last read: a second click on one, even in the same task, sends nothing.
	const removed = useRef<{ state: ChartPanelState; readonly ids: Set<number> } | null>(null)

	useEffect(() => {
		heading.current?.focus()
	}, [])

	useEffect(() => {
		const last = lastFocused.current

		if (last !== null && !last.isConnected && (document.activeElement === null || document.activeElement === document.body)) {
			lastFocused.current = null
			heading.current?.focus()
		}
	})

	const body = (() => {
		if (state.status === "loading") return <p className="p-4 text-sm text-muted-foreground">{t("previewSheetChartLoading")}</p>
		if (state.status === "gone") return <p className="p-4 text-sm text-muted-foreground">{t("previewSheetChartGone")}</p>

		const { info } = state
		const disabled = !props.canEdit || state.readOnly
		const combo = info.plots.length > 1
		// Keyed by id, so a removed series' fields go with it rather than showing the next one's.
		const ids = new Set<number>()
		const series = info.plots.flatMap(plot =>
			plot.series.map((entry, position) => {
				const key = ids.has(entry.idx) ? `${String(entry.idx)}@${String(entry.index)}` : String(entry.idx)

				ids.add(entry.idx)

				return { key, entry, plot, position, count: plot.series.length }
			})
		)
		const addTo = info.plots.findIndex(plot => editableType(plot.type) || plot.type === "radar")
		const values = selectionReference(props.selection)

		return (
			<>
				{state.readOnly ? <p className="m-4 rounded-xl bg-muted p-3 text-sm">{t("previewSheetChartReadOnly")}</p> : null}
				<Section title={t("previewSheetChartSectionType")}>
					{info.plots.map(plot => (
						<PlotFields
							key={plot.index}
							plot={plot}
							combo={combo}
							disabled={disabled}
							onEdit={onEdit}
						/>
					))}
					{combo ? <p className="text-xs text-muted-foreground">{t("previewSheetChartComboHint")}</p> : null}
				</Section>
				<Section title={t("previewSheetChartSectionData")}>
					{series.map(({ key, entry, plot, position, count }) => (
						<SeriesFields
							key={key}
							series={entry}
							plot={plot}
							position={position}
							count={count}
							disabled={disabled}
							onEdit={onEdit}
							onRemove={() => {
								if (removed.current?.state !== state) removed.current = { state, ids: new Set() }
								if (removed.current.ids.has(entry.idx)) return

								removed.current.ids.add(entry.idx)
								onEdit({ kind: "series.remove", series: entry.index, id: entry.idx })
							}}
						/>
					))}
					<Button
						variant="outline"
						disabled={disabled || addTo < 0 || values === null}
						onClick={() => {
							if (values !== null) onEdit({ kind: "series.add", plot: addTo, name: null, categories: null, values })
						}}
					>
						<PlusIcon data-icon="inline-start" />
						{t("previewSheetChartSeriesAdd")}
					</Button>
				</Section>
				{info.axes.length === 0 ? null : (
					<Section title={t("previewSheetChartSectionAxes")}>
						{info.axes.map(axis => (
							<AxisFields
								key={axis.id}
								axis={axis}
								axes={info.axes}
								disabled={disabled}
								onEdit={onEdit}
							/>
						))}
					</Section>
				)}
				<Section title={t("previewSheetChartSectionTitles")}>
					<Toggle
						id="chart-title-show"
						label={t("previewSheetChartTitleShow")}
						checked={info.title !== null}
						disabled={disabled}
						onChange={show => {
							onEdit({ kind: "title", text: show ? "" : null })
						}}
					/>
					{info.title === null ? null : (
						<TextField
							id="chart-title"
							label={t("previewSheetChartTitle")}
							value={info.title}
							placeholder={t("previewSheetChartTitleAuto")}
							disabled={disabled}
							onCommit={text => {
								onEdit({ kind: "title", text })
							}}
						/>
					)}
					<Choice
						id="chart-legend"
						label={t("previewSheetChartLegend")}
						value={info.legend ?? "none"}
						options={LEGEND_OPTIONS}
						disabled={disabled}
						onChange={position => {
							onEdit({ kind: "legend", position: position === "none" ? null : position })
						}}
					/>
					<LabelFields
						plots={info.plots}
						disabled={disabled}
						onEdit={onEdit}
					/>
				</Section>
			</>
		)
	})()

	return (
		<aside
			aria-label={t("previewSheetChartPanel")}
			data-preview-surface
			className="flex h-full min-h-0 w-full flex-col bg-background"
			onFocus={event => {
				lastFocused.current = event.target
			}}
			// Escape inside the panel closes it (a field reverting its draft takes Escape first). F6 is the view's, which
			// cycles its panes.
			onKeyDown={event => {
				if (event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault()
					props.onClose()
				}
			}}
		>
			<header className="flex items-center justify-between border-b border-border px-4 py-2">
				<h2
					ref={heading}
					tabIndex={-1}
					className="text-sm font-semibold outline-none"
				>
					{t("previewSheetChartPanel")}
				</h2>
				<TooltipIconButton
					label={t("previewSheetChartPanelClose")}
					onClick={props.onClose}
				>
					<XIcon />
				</TooltipIconButton>
			</header>
			<div className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto">{body}</div>
		</aside>
	)
}
