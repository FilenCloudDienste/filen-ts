import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { SheetCommand, SheetFilterCriteria } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
	NUMBER_OPERATORS,
	TEXT_OPERATORS,
	dialogConditions,
	dialogCriteria,
	operatorKey,
	type DialogCondition,
	type DialogOperator,
	type FilterKind
} from "@/features/spreadsheet/data/sortFilter.logic"
import { setSortFilterOpen, type SortFilterOpen } from "@/features/spreadsheet/data/sortFilterState"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { regionalLanguage } from "@/features/office/lib/regionalFormat"

// The autofilter's condition dialogs: Excel's Custom AutoFilter (one or two conditions, both or either, with * and
// ? wildcards for text and date fields for dates) and its Top 10 AutoFilter (the largest or smallest items or
// percent).

const NONE = "none"

function operatorsFor(kind: FilterKind): readonly DialogOperator[] {
	return kind === "text" ? TEXT_OPERATORS : NUMBER_OPERATORS
}

type ConditionOpen = Extract<SortFilterOpen, { type: "condition" }>
type Top10Open = Extract<SortFilterOpen, { type: "top10" }>

export function FilterConditionDialog({
	model,
	open,
	date1904,
	run
}: {
	model: SheetGridModel
	open: ConditionOpen
	date1904: boolean
	run: (command: SheetCommand) => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	// Numbers are typed as in the cells: in the locale the session reads entries in.
	const [locale] = useState(() => sheetLocaleOf(regionalLanguage()))
	const kept = dialogConditions(open.criteria, open.kind, date1904, locale)
	const [first, setFirst] = useState<DialogCondition>(kept?.conditions[0] ?? { operator: open.first, value: "" })
	const [second, setSecond] = useState<DialogCondition | null>(
		kept === null ? (open.second === undefined ? null : { operator: open.second, value: "" }) : (kept.conditions[1] ?? null)
	)
	const [and, setAnd] = useState(kept?.and ?? open.second !== undefined)
	const conditions = second === null || second.value === "" ? [first] : [first, second]
	const criteria = first.value === "" ? null : dialogCriteria(conditions, and, open.kind, date1904, locale)
	const operators = operatorsFor(open.kind)

	function close(): void {
		setSortFilterOpen(model, null)
	}

	// A condition's operator and value; the second may be none.
	function field(condition: DialogCondition | null, index: number, onChange: (next: DialogCondition | null) => void, optional: boolean) {
		return (
			<div className="flex gap-2">
				<Select
					value={condition === null ? NONE : condition.operator}
					onValueChange={(value: string | null) => {
						const operator = operators.find(candidate => candidate === value)

						onChange(operator === undefined ? null : { operator, value: condition?.value ?? "" })
					}}
				>
					<SelectTrigger
						id={`${id}-operator-${String(index)}`}
						aria-label={t("previewSheetFilterCustom")}
						className="w-56 shrink-0"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent data-preview-surface>
						<SelectGroup>
							{optional ? <SelectItem value={NONE}>{t("previewSheetFilterOpNone")}</SelectItem> : null}
							{operators.map(operator => (
								<SelectItem
									key={operator}
									value={operator}
								>
									{t(operatorKey(operator, open.kind))}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<Input
					id={`${id}-value-${String(index)}`}
					aria-label={t("previewSheetFilterValue")}
					className="min-w-0 flex-1 leading-5"
					type={open.kind === "date" ? "date" : "text"}
					inputMode={open.kind === "number" ? "decimal" : undefined}
					disabled={condition === null}
					value={condition?.value ?? ""}
					onChange={event => {
						if (condition !== null) {
							onChange({ ...condition, value: event.target.value })
						}
					}}
				/>
			</div>
		)
	}

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewSheetFilterCustomTitle")}
			description={
				open.kind === "text" ? t("previewSheetFilterWildcards") : t("previewSheetFilterShowRowsWhere", { name: open.header })
			}
			submitLabel={t("previewSheetFilterApply")}
			cancelLabel={t("common:cancel")}
			canSubmit={criteria !== null}
			wide
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onSubmit={event => {
				event.preventDefault()

				if (criteria !== null) {
					run({ type: "filter.column", sheet: model.getSnapshot().sheet, row: open.row, col: open.col, criteria })
				}

				close()
			}}
		>
			<div className="flex flex-col gap-3">
				<p className="text-sm font-medium">{t("previewSheetFilterShowRowsWhere", { name: open.header })}</p>
				{field(
					first,
					0,
					next => {
						if (next !== null) {
							setFirst(next)
						}
					},
					false
				)}
				<RadioGroup
					aria-label={t("previewSheetFilterCustomTitle")}
					name={`${id}-join`}
					value={and ? "and" : "or"}
					className="flex gap-6"
					onValueChange={next => {
						setAnd(next === "and")
					}}
				>
					{(["and", "or"] as const).map(join => (
						<div
							key={join}
							className="flex items-center gap-2"
						>
							<RadioGroupItem
								id={`${id}-${join}`}
								value={join}
							/>
							<Label htmlFor={`${id}-${join}`}>{t(join === "and" ? "previewSheetFilterAnd" : "previewSheetFilterOr")}</Label>
						</div>
					))}
				</RadioGroup>
				{field(second, 1, setSecond, true)}
				{open.kind === "number" && first.value !== "" && criteria === null ? (
					<p
						role="alert"
						className="text-sm text-destructive"
					>
						{t("previewSheetFilterNotANumber")}
					</p>
				) : null}
			</div>
		</FormDialog>
	)
}

export function FilterTop10Dialog({ model, open, run }: { model: SheetGridModel; open: Top10Open; run: (command: SheetCommand) => void }) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const current = open.criteria?.kind === "top10" ? open.criteria : null
	const [top, setTop] = useState(current?.top ?? true)
	const [percent, setPercent] = useState(current?.percent ?? false)
	const [count, setCount] = useState(String(current?.value ?? 10))
	const value = Number(count)
	const valid = Number.isFinite(value) && value > 0 && value <= (percent ? 100 : 500)
	const criteria: SheetFilterCriteria | null = valid ? { kind: "top10", top, percent, value } : null

	function close(): void {
		setSortFilterOpen(model, null)
	}

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewSheetFilterTop10Title")}
			description={t("previewSheetFilterTop10Body", { name: open.header })}
			submitLabel={t("previewSheetFilterApply")}
			cancelLabel={t("common:cancel")}
			canSubmit={criteria !== null}
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onSubmit={event => {
				event.preventDefault()

				if (criteria !== null) {
					run({ type: "filter.column", sheet: model.getSnapshot().sheet, row: open.row, col: open.col, criteria })
				}

				close()
			}}
		>
			<div className="flex items-center gap-2">
				<Select
					value={top ? "top" : "bottom"}
					onValueChange={(next: string | null) => {
						setTop(next !== "bottom")
					}}
				>
					<SelectTrigger
						aria-label={t("previewSheetFilterTop10Title")}
						className="w-28"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent data-preview-surface>
						<SelectGroup>
							<SelectItem value="top">{t("previewSheetFilterTop")}</SelectItem>
							<SelectItem value="bottom">{t("previewSheetFilterBottom")}</SelectItem>
						</SelectGroup>
					</SelectContent>
				</Select>
				<Input
					id={`${id}-count`}
					aria-label={t("previewSheetFilterTopCount")}
					className="w-24 leading-5"
					type="number"
					min={1}
					max={percent ? 100 : 500}
					value={count}
					onChange={event => {
						setCount(event.target.value)
					}}
				/>
				<Select
					value={percent ? "percent" : "items"}
					onValueChange={(next: string | null) => {
						setPercent(next === "percent")
					}}
				>
					<SelectTrigger
						aria-label={t("previewSheetFilterTopCount")}
						className="w-32"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent data-preview-surface>
						<SelectGroup>
							<SelectItem value="items">{t("previewSheetFilterItems")}</SelectItem>
							<SelectItem value="percent">{t("previewSheetFilterPercent")}</SelectItem>
						</SelectGroup>
					</SelectContent>
				</Select>
			</div>
		</FormDialog>
	)
}
