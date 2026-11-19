import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import {
	MAX_VALIDATION_ERROR,
	MAX_VALIDATION_PROMPT,
	MAX_VALIDATION_TITLE,
	type SheetFileKind,
	type SheetRefusal,
	type SheetValidationRule
} from "@filen/office/core/sheet"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { FIELD_CONTROL_CLASS, INVALID_RING_CLASS } from "@/components/ui/surface"
import { cn } from "@filen/shared"
import type { PreviewKey } from "@/lib/i18n"
import { refusalKey } from "@/features/spreadsheet/lib/sheetMessages.logic"
import {
	ERROR_STYLES,
	VALIDATION_OPERATORS,
	VALIDATION_TYPES,
	validationComplete,
	validationFields,
	validationRefusalKey
} from "@/features/spreadsheet/data/dvDialog.logic"

// Excel's Data validation dialog in one column (as Format cells): what the cells allow, the input message they show
// when selected, and the alert an invalid entry shows. Apply sends the rule; the session refuses what the file
// cannot hold, and the refusal shows here.

export interface ValidationDialogProps {
	// The rule to start from (the active cell's, or a new one); null while closed.
	rule: SheetValidationRule | null
	// The file's kind, which a view-only refusal's words name.
	kind: SheetFileKind
	onClose: () => void
	// Resolves with why the rule was refused, null once applied.
	onApply: (rule: SheetValidationRule) => Promise<SheetRefusal | null>
	onClear: () => void
}

export function ValidationDialog(props: ValidationDialogProps) {
	return (
		<Dialog
			open={props.rule !== null}
			onOpenChange={open => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
				{props.rule === null ? null : (
					<ValidationForm
						{...props}
						initial={props.rule}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

function Choice<T extends string>({
	id,
	label,
	value,
	options,
	onChange
}: {
	id: string
	label: string
	value: T
	options: readonly { readonly value: T; readonly key: PreviewKey }[]
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
				onValueChange={(next: T | null) => {
					if (next !== null) onChange(next)
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

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<Field orientation="horizontal">
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onChange}
			/>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
		</Field>
	)
}

function Text({
	id,
	label,
	value,
	maxLength,
	mono,
	lines,
	className,
	onChange
}: {
	id: string
	label: string
	value: string
	maxLength?: number
	mono?: boolean
	// A box of several lines (a message, as Excel's dialog has it).
	lines?: number
	className?: string
	onChange: (value: string) => void
}) {
	if (lines !== undefined)
		return (
			<Field className={className}>
				<FieldLabel htmlFor={id}>{label}</FieldLabel>
				<textarea
					id={id}
					value={value}
					maxLength={maxLength}
					rows={lines}
					className={cn("w-full resize-y px-2.5 py-1.5 text-base leading-5 md:text-sm", FIELD_CONTROL_CLASS, INVALID_RING_CLASS)}
					onChange={event => {
						onChange(event.target.value)
					}}
				/>
			</Field>
		)

	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				value={value}
				maxLength={maxLength}
				spellCheck={false}
				autoComplete="off"
				className={mono === true ? "font-mono" : undefined}
				onChange={event => {
					onChange(event.target.value)
				}}
			/>
		</Field>
	)
}

// Mounted per opening, so it starts from the cell's rule each time.
function ValidationForm({ initial, kind, onClose, onApply, onClear }: ValidationDialogProps & { initial: SheetValidationRule }) {
	const { t } = useTranslation(["preview", "common"])
	const [rule, setRule] = useState(initial)
	const [refused, setRefused] = useState<PreviewKey | null>(null)
	const [pending, setPending] = useState(false)
	const fields = validationFields(rule)
	const change = (next: Partial<SheetValidationRule>): void => {
		setRefused(null)
		setRule(current => ({ ...current, ...next }))
	}

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault()

		if (!validationComplete(rule) || pending) return

		setPending(true)

		const refusal = await onApply(rule)

		setPending(false)

		if (refusal === null) {
			onClose()

			return
		}

		// A refusal of the rule itself in the dialog's words, any other (a view-only file, a protected sheet) in the app's.
		setRefused(validationRefusalKey(refusal.reason, rule) ?? refusalKey(refusal, kind))
	}

	const valueLabel = (field: "minimum" | "maximum" | "value"): string =>
		t(
			field === "minimum"
				? "previewSheetValidationMinimum"
				: field === "maximum"
					? "previewSheetValidationMaximum"
					: "previewSheetValidationValue"
		)

	return (
		<form
			onSubmit={event => {
				void handleSubmit(event)
			}}
			className="flex flex-col gap-5"
		>
			<DialogHeader>
				<DialogTitle>{t("previewSheetDataValidationTitle")}</DialogTitle>
				<DialogDescription>{t("previewSheetDataValidationBody")}</DialogDescription>
			</DialogHeader>
			<div className="grid gap-4 sm:grid-cols-2">
				<Choice
					id="validation-type"
					label={t("previewSheetValidationAllow")}
					value={rule.type}
					options={VALIDATION_TYPES}
					onChange={type => {
						change({ type })
					}}
				/>
				{fields.includes("operator") ? (
					<Choice
						id="validation-operator"
						label={t("previewSheetValidationData")}
						value={rule.operator}
						options={VALIDATION_OPERATORS}
						onChange={operator => {
							change({ operator })
						}}
					/>
				) : null}
				{(["minimum", "value"] as const)
					.filter(field => fields.includes(field))
					.map(field => (
						<Text
							key={field}
							id={`validation-${field}`}
							label={valueLabel(field)}
							value={rule.value1}
							onChange={value1 => {
								change({ value1 })
							}}
						/>
					))}
				{fields.includes("maximum") ? (
					<Text
						id="validation-maximum"
						label={valueLabel("maximum")}
						value={rule.value2}
						onChange={value2 => {
							change({ value2 })
						}}
					/>
				) : null}
			</div>
			{fields.includes("source") || fields.includes("formula") ? (
				<Field data-invalid={refused === null ? undefined : true}>
					<FieldLabel htmlFor="validation-source">
						{t(fields.includes("source") ? "previewSheetValidationSource" : "previewSheetValidationFormula")}
					</FieldLabel>
					<Input
						id="validation-source"
						value={rule.value1}
						spellCheck={false}
						autoComplete="off"
						className="font-mono"
						onChange={event => {
							change({ value1: event.target.value })
						}}
					/>
					{fields.includes("source") ? <FieldDescription>{t("previewSheetValidationSourceHint")}</FieldDescription> : null}
				</Field>
			) : null}
			{fields.includes("value") || fields.includes("minimum") ? (
				<FieldDescription>{t("previewSheetValidationValueHint")}</FieldDescription>
			) : null}
			{rule.type === "none" ? null : (
				<div className="flex flex-wrap gap-x-6 gap-y-3">
					<Toggle
						id="validation-blank"
						label={t("previewSheetValidationIgnoreBlank")}
						checked={rule.allowBlank}
						onChange={allowBlank => {
							change({ allowBlank })
						}}
					/>
					{rule.type === "list" ? (
						<Toggle
							id="validation-dropdown"
							label={t("previewSheetValidationInCellDropdown")}
							checked={rule.inCellDropdown}
							onChange={inCellDropdown => {
								change({ inCellDropdown })
							}}
						/>
					) : null}
				</div>
			)}
			<Separator />
			<Toggle
				id="validation-input"
				label={t("previewSheetValidationInputMessage")}
				checked={rule.showInputMessage}
				onChange={showInputMessage => {
					change({ showInputMessage })
				}}
			/>
			{rule.showInputMessage ? (
				<div className="grid gap-4">
					<Text
						id="validation-prompt-title"
						label={t("previewSheetValidationMessageTitle")}
						value={rule.promptTitle}
						maxLength={MAX_VALIDATION_TITLE}
						onChange={promptTitle => {
							change({ promptTitle })
						}}
					/>
					<Text
						id="validation-prompt"
						label={t("previewSheetValidationMessageText")}
						value={rule.prompt}
						maxLength={MAX_VALIDATION_PROMPT}
						lines={3}
						onChange={prompt => {
							change({ prompt })
						}}
					/>
				</div>
			) : null}
			<Separator />
			<Toggle
				id="validation-error"
				label={t("previewSheetValidationErrorAlert")}
				checked={rule.showErrorMessage}
				onChange={showErrorMessage => {
					change({ showErrorMessage })
				}}
			/>
			{rule.showErrorMessage ? (
				<div className="grid gap-4 sm:grid-cols-2">
					<Choice
						id="validation-style"
						label={t("previewSheetValidationStyle")}
						value={rule.errorStyle}
						options={ERROR_STYLES}
						onChange={errorStyle => {
							change({ errorStyle })
						}}
					/>
					<Text
						id="validation-error-title"
						label={t("previewSheetValidationMessageTitle")}
						value={rule.errorTitle}
						maxLength={MAX_VALIDATION_TITLE}
						onChange={errorTitle => {
							change({ errorTitle })
						}}
					/>
					<Text
						id="validation-error-text"
						label={t("previewSheetValidationMessageText")}
						value={rule.error}
						maxLength={MAX_VALIDATION_ERROR}
						lines={3}
						className="sm:col-span-2"
						onChange={error => {
							change({ error })
						}}
					/>
				</div>
			) : null}
			{refused === null ? null : <FieldError>{t(refused)}</FieldError>}
			<DialogFooter className="sm:justify-between">
				<Button
					type="button"
					variant="ghost"
					onClick={() => {
						onClear()
						onClose()
					}}
				>
					{t("previewSheetValidationClearAll")}
				</Button>
				<div className="flex flex-col-reverse gap-2 sm:flex-row">
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
					>
						{t("common:cancel")}
					</Button>
					<Button
						type="submit"
						disabled={!validationComplete(rule) || pending}
					>
						{t("previewSheetValidationOk")}
					</Button>
				</div>
			</DialogFooter>
		</form>
	)
}
