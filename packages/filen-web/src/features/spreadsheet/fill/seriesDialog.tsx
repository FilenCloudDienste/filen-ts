import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { SheetCommand } from "@filen/office/core/sheet"
import type { SheetGridState } from "@filen/office/react/sheet"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import type { PreviewKey } from "@/lib/i18n"
import {
	seriesCommand,
	seriesDefaults,
	seriesStep,
	seriesStopValid,
	seriesTrendOffered,
	type SeriesForm
} from "@/features/spreadsheet/fill/seriesDialog.logic"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { useRegionalLanguage } from "@/features/office/lib/regionalFormat"

const ORIENTATIONS: readonly { readonly value: SeriesForm["orientation"]; readonly key: PreviewKey }[] = [
	{ value: "rows", key: "previewSheetSeriesRows" },
	{ value: "cols", key: "previewSheetSeriesColumns" }
]

const TYPES: readonly { readonly value: SeriesForm["type"]; readonly key: PreviewKey }[] = [
	{ value: "linear", key: "previewSheetSeriesLinear" },
	{ value: "growth", key: "previewSheetSeriesGrowth" },
	{ value: "date", key: "previewSheetSeriesDate" },
	{ value: "autoFill", key: "previewSheetSeriesAutoFill" }
]

const UNITS: readonly { readonly value: SeriesForm["dateUnit"]; readonly key: PreviewKey }[] = [
	{ value: "day", key: "previewSheetSeriesDay" },
	{ value: "weekday", key: "previewSheetSeriesWeekday" },
	{ value: "month", key: "previewSheetSeriesMonth" },
	{ value: "year", key: "previewSheetSeriesYear" }
]

function Choices<T extends string>({
	id,
	label,
	options,
	value,
	disabled,
	onChange
}: {
	id: string
	label: string
	options: readonly { readonly value: T; readonly key: PreviewKey }[]
	value: T
	disabled?: boolean
	onChange: (value: T) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<Field>
			<FieldLabel id={`${id}-label`}>{label}</FieldLabel>
			<RadioGroup
				aria-labelledby={`${id}-label`}
				name={id}
				value={value}
				disabled={disabled === true}
				className="flex flex-wrap gap-x-5 gap-y-2"
				onValueChange={next => {
					const found = options.find(option => option.value === next)

					if (found !== undefined) {
						onChange(found.value)
					}
				}}
			>
				{options.map(option => (
					<div
						key={option.value}
						className="flex items-center gap-2"
					>
						<RadioGroupItem
							id={`${id}-${option.value}`}
							value={option.value}
						/>
						<Label htmlFor={`${id}-${option.value}`}>{t(option.key)}</Label>
					</div>
				))}
			</RadioGroup>
		</Field>
	)
}

// Excel's Series dialog (Home > Fill > Series): each row or column of the selection filled from its first cell (or
// its first cells, as a trend or as the fill handle extends them). Each opening starts from the selection's defaults.
export function SheetSeriesDialog({
	open,
	grid,
	run,
	onClose
}: {
	open: boolean
	grid: SheetGridState
	run: (command: SheetCommand) => void
	onClose: () => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const range = grid.selection.ranges[grid.selection.ranges.length - 1]
	const [edited, setEdited] = useState<SeriesForm | null>(null)
	const form = edited ?? (range === undefined ? null : seriesDefaults(range))
	const change = (patch: Partial<SeriesForm>): void => {
		if (form !== null) {
			setEdited({ ...form, ...patch })
		}
	}
	const close = (): void => {
		setEdited(null)
		onClose()
	}
	// The locale the session reads entries in (useSheetFormula configures it from the same language).
	const locale = sheetLocaleOf(useRegionalLanguage())
	const stepInvalid = form !== null && seriesStep(form.step, locale) === null
	const stopInvalid = form !== null && !seriesStopValid(form.stop, locale)
	const command = form === null || range === undefined ? null : seriesCommand(form, grid.sheet, range, locale)

	return (
		<FormDialog
			open={open && form !== null}
			pending={false}
			title={t("previewSheetSeriesTitle")}
			description={t("previewSheetSeriesDescription")}
			submitLabel={t("previewSheetSeriesFill")}
			cancelLabel={t("common:cancel")}
			canSubmit={command !== null}
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onSubmit={event => {
				event.preventDefault()

				if (command !== null) {
					run(command)
				}

				close()
			}}
		>
			{form === null ? null : (
				<div className="flex flex-col gap-5">
					<Choices
						id={`${id}-in`}
						label={t("previewSheetSeriesIn")}
						options={ORIENTATIONS}
						value={form.orientation}
						onChange={orientation => {
							change({ orientation })
						}}
					/>
					<Choices
						id={`${id}-type`}
						label={t("previewSheetSeriesType")}
						options={TYPES}
						value={form.type}
						onChange={type => {
							change({ type })
						}}
					/>
					<Choices
						id={`${id}-unit`}
						label={t("previewSheetSeriesDateUnit")}
						options={UNITS}
						value={form.dateUnit}
						disabled={form.type !== "date"}
						onChange={dateUnit => {
							change({ dateUnit })
						}}
					/>
					<Field data-invalid={stepInvalid}>
						<FieldLabel htmlFor={`${id}-step`}>{t("previewSheetSeriesStep")}</FieldLabel>
						<Input
							id={`${id}-step`}
							inputMode="decimal"
							autoComplete="off"
							value={form.step}
							disabled={form.type === "autoFill" || (form.trend && seriesTrendOffered(form))}
							aria-invalid={stepInvalid}
							onChange={event => {
								change({ step: event.target.value })
							}}
						/>
						{stepInvalid ? <FieldError>{t("previewSheetSeriesStepInvalid")}</FieldError> : null}
					</Field>
					<Field data-invalid={stopInvalid}>
						<FieldLabel htmlFor={`${id}-stop`}>{t("previewSheetSeriesStop")}</FieldLabel>
						<Input
							id={`${id}-stop`}
							autoComplete="off"
							placeholder={t("previewSheetSeriesStopPlaceholder")}
							value={form.stop}
							disabled={form.type === "autoFill"}
							aria-invalid={stopInvalid}
							onChange={event => {
								change({ stop: event.target.value })
							}}
						/>
						{stopInvalid ? <FieldError>{t("previewSheetSeriesStopInvalid")}</FieldError> : null}
					</Field>
					<Field orientation="horizontal">
						<Switch
							id={`${id}-trend`}
							checked={form.trend && seriesTrendOffered(form)}
							disabled={!seriesTrendOffered(form)}
							onCheckedChange={trend => {
								change({ trend })
							}}
						/>
						<FieldLabel htmlFor={`${id}-trend`}>{t("previewSheetSeriesTrend")}</FieldLabel>
					</Field>
				</div>
			)}
		</FormDialog>
	)
}
