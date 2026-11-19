import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { formatValue, numFmtProblem, type NumFmtCategory, type NumFmtOptions, type NumFmtProblem } from "@filen/office/core/sheet"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { PreviewKey } from "@/lib/i18n"
import {
	MAX_DECIMALS,
	NEGATIVE_STYLES,
	SYMBOLS,
	TYPES,
	codeOf,
	offers,
	optionsOf,
	type FormatOptions
} from "@/features/spreadsheet/dialogs/formatCells.logic"
import { CATEGORIES, CATEGORY_LABELS } from "@/features/spreadsheet/toolbar/toolbar.logic"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { useRegionalLanguage } from "@/features/office/lib/regionalFormat"

// The Format Cells dialog's Number tab: a category, its options, the code they make (editable: an edited code is a
// custom one), and the active cell's value shown in it. Apply sends the code; the session refuses what
// numFmtProblem refuses, so the two agree.

const PROBLEM_KEYS: Readonly<Record<NumFmtProblem, PreviewKey>> = {
	empty: "previewSheetFormatCodeEmpty",
	tooLong: "previewSheetFormatCodeTooLong",
	sections: "previewSheetFormatCodeSections",
	unclosed: "previewSheetFormatCodeUnclosed",
	characters: "previewSheetFormatCodeCharacters"
}

// Shown when the cell holds no number: a value every category shows something for.
const DEFAULT_SAMPLE = 1234.5
// What the negative styles show (Excel's list: -1,234.10 and its variants).
const SAMPLE_NEGATIVE = 1234.1

export interface FormatCellsDialogProps {
	open: boolean
	// The active cell's code and number (null when it holds none).
	numFmt: string
	sample: number | null
	date1904: boolean
	onOpenChange: (open: boolean) => void
	onApply: (code: string) => void
}

export function FormatCellsDialog(props: FormatCellsDialogProps) {
	return (
		<Dialog
			open={props.open}
			onOpenChange={props.onOpenChange}
		>
			<DialogContent className="sm:max-w-lg">{props.open ? <FormatCellsForm {...props} /> : null}</DialogContent>
		</Dialog>
	)
}

// Mounted per opening, so it starts from the cell's code each time.
function FormatCellsForm({ numFmt, sample, date1904, onOpenChange, onApply }: FormatCellsDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const [options, setOptions] = useState<FormatOptions>(() => optionsOf(numFmt))
	const code = codeOf(options)
	const problem = numFmtProblem(code)
	const offered = offers(options.category)
	const value = sample ?? DEFAULT_SAMPLE
	// Shown in the regional format the grid shows cells in (separators, month and day names, date patterns), so the
	// preview reads as the cell will; followed live.
	const locale = sheetLocaleOf(useRegionalLanguage()).numFmt
	const sampleOptions: NumFmtOptions = locale === undefined ? { date1904 } : { date1904, locale }
	// A value through a code, or nothing for a code Excel would refuse.
	const shown = (candidate: string, of = value): string =>
		numFmtProblem(candidate) === null ? formatValue(of, candidate, sampleOptions).text : ""
	const change = (next: Partial<FormatOptions>): void => {
		setOptions(current => {
			const merged = { ...current, ...next }

			// The code field follows the options until it is edited itself.
			return next.code === undefined ? { ...merged, code: codeOf(merged) } : merged
		})
	}
	const categoryItems = CATEGORIES.map(category => ({ value: category, label: t(CATEGORY_LABELS[category]) }))

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault()

		if (problem !== null) {
			return
		}

		onApply(code)
		onOpenChange(false)
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="flex flex-col gap-5"
		>
			<DialogHeader>
				<DialogTitle>{t("previewSheetFormatCellsTitle")}</DialogTitle>
				<DialogDescription>{t("previewSheetFormatCellsBody")}</DialogDescription>
			</DialogHeader>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field>
					<FieldLabel htmlFor="format-cells-category">{t("previewSheetFormatCategory")}</FieldLabel>
					<Select
						items={categoryItems}
						value={options.category}
						onValueChange={(next: NumFmtCategory | null) => {
							if (next !== null) {
								change({ category: next, type: 0 })
							}
						}}
					>
						<SelectTrigger id="format-cells-category">
							<SelectValue />
						</SelectTrigger>
						<SelectContent data-preview-surface>
							<SelectGroup>
								{categoryItems.map(item => (
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
				<Field>
					<FieldLabel htmlFor="format-cells-sample">{t("previewSheetFormatSample")}</FieldLabel>
					<output
						id="format-cells-sample"
						aria-live="polite"
						className="flex h-9 items-center truncate rounded-md border border-border px-3 text-sm tabular-nums"
					>
						{problem === null ? shown(code) : ""}
					</output>
				</Field>
				{offered.decimals ? (
					<Field>
						<FieldLabel htmlFor="format-cells-decimals">{t("previewSheetFormatDecimals")}</FieldLabel>
						<Input
							id="format-cells-decimals"
							type="number"
							inputMode="numeric"
							min={0}
							max={MAX_DECIMALS}
							value={options.decimals}
							onChange={event => {
								const next = Number.parseInt(event.target.value, 10)

								change({ decimals: Number.isFinite(next) ? Math.max(0, Math.min(MAX_DECIMALS, next)) : 0 })
							}}
						/>
					</Field>
				) : null}
				{offered.symbol ? (
					<Field>
						<FieldLabel htmlFor="format-cells-symbol">{t("previewSheetFormatSymbol")}</FieldLabel>
						<Select
							items={SYMBOLS.map(symbol => ({
								value: symbol,
								label: symbol === "" ? t("previewSheetFormatSymbolNone") : symbol
							}))}
							value={options.symbol}
							onValueChange={(next: string | null) => {
								if (next !== null) {
									change({ symbol: next })
								}
							}}
						>
							<SelectTrigger id="format-cells-symbol">
								<SelectValue />
							</SelectTrigger>
							<SelectContent data-preview-surface>
								<SelectGroup>
									{SYMBOLS.map(symbol => (
										<SelectItem
											key={symbol}
											value={symbol}
										>
											{symbol === "" ? t("previewSheetFormatSymbolNone") : symbol}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
				) : null}
				{offered.thousands ? (
					<Field orientation="horizontal">
						<Switch
							id="format-cells-thousands"
							checked={options.thousands}
							onCheckedChange={checked => {
								change({ thousands: checked })
							}}
						/>
						<FieldLabel htmlFor="format-cells-thousands">{t("previewSheetFormatThousands")}</FieldLabel>
					</Field>
				) : null}
				{offered.negative ? (
					<NegativePicker
						options={options}
						shown={shown}
						onNegative={negative => {
							change({ negative })
						}}
					/>
				) : null}
				{offered.types ? (
					<TypePicker
						options={options}
						shown={shown}
						onType={type => {
							change({ type })
						}}
					/>
				) : null}
			</div>
			{options.category === "general" ? <FieldDescription>{t("previewSheetFormatGeneralNote")}</FieldDescription> : null}
			{options.category === "text" ? <FieldDescription>{t("previewSheetFormatTextNote")}</FieldDescription> : null}
			<Field data-invalid={problem === null ? undefined : true}>
				<FieldLabel htmlFor="format-cells-code">{t("previewSheetFormatCode")}</FieldLabel>
				<Input
					id="format-cells-code"
					value={code}
					spellCheck={false}
					autoComplete="off"
					className="font-mono"
					aria-invalid={problem === null ? undefined : true}
					aria-describedby={problem === null ? undefined : "format-cells-code-error"}
					onChange={event => {
						change({ category: "custom", code: event.target.value })
					}}
				/>
				{problem === null ? null : <FieldError id="format-cells-code-error">{t(PROBLEM_KEYS[problem])}</FieldError>}
			</Field>
			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						onOpenChange(false)
					}}
				>
					{t("common:cancel")}
				</Button>
				<Button
					type="submit"
					disabled={problem !== null}
				>
					{t("previewSheetFormatApply")}
				</Button>
			</DialogFooter>
		</form>
	)
}

function NegativePicker({
	options,
	shown,
	onNegative
}: {
	options: FormatOptions
	shown: (code: string, of?: number) => string
	onNegative: (negative: number) => void
}) {
	const { t } = useTranslation("preview")
	// Each style showing the sample as a negative, as Excel's list does.
	const styles = Array.from({ length: NEGATIVE_STYLES }, (_, negative) => ({
		value: String(negative),
		label: shown(codeOf({ ...options, negative }), -Math.abs(SAMPLE_NEGATIVE)),
		red: negative === 1 || negative === 3
	}))

	return (
		<Field>
			<FieldLabel htmlFor="format-cells-negative">{t("previewSheetFormatNegative")}</FieldLabel>
			<Select
				items={styles}
				value={String(options.negative)}
				onValueChange={(next: string | null) => {
					if (next !== null) {
						onNegative(Number(next))
					}
				}}
			>
				<SelectTrigger id="format-cells-negative">
					<SelectValue />
				</SelectTrigger>
				<SelectContent data-preview-surface>
					<SelectGroup>
						{styles.map(style => (
							<SelectItem
								key={style.value}
								value={style.value}
								className={style.red ? "text-red-600 dark:text-red-400" : undefined}
							>
								{style.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	)
}

function TypePicker({
	options,
	shown,
	onType
}: {
	options: FormatOptions
	shown: (code: string) => string
	onType: (type: number) => void
}) {
	const { t } = useTranslation("preview")
	const types = (TYPES[options.category] ?? []).map((code, index) => ({ value: String(index), label: shown(code) || code }))

	return (
		<Field>
			<FieldLabel htmlFor="format-cells-type">{t("previewSheetFormatType")}</FieldLabel>
			<Select
				items={types}
				value={String(options.type)}
				onValueChange={(next: string | null) => {
					if (next !== null) {
						onType(Number(next))
					}
				}}
			>
				<SelectTrigger id="format-cells-type">
					<SelectValue />
				</SelectTrigger>
				<SelectContent
					data-preview-surface
					className="max-h-80"
				>
					<SelectGroup>
						{types.map(type => (
							<SelectItem
								key={type.value}
								value={type.value}
							>
								{type.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	)
}
