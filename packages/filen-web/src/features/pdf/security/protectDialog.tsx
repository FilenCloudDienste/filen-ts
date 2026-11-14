import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { PdfAllowed, PdfSecurityChoice, PdfSecuritySummary } from "@filen/office/core/pdfedit/security"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SecretInput } from "@/components/ui/secretInput"
import type { PreviewKey } from "@/lib/i18n"
import {
	changesSomething,
	currentMode,
	initialForm,
	isLocked,
	protectChoice,
	type PasswordIssue,
	type ProtectForm,
	type ProtectMode
} from "@/features/pdf/security/security.logic"

const MODES: readonly { readonly value: ProtectMode; readonly key: PreviewKey }[] = [
	{ value: "none", key: "previewPdfSecurityModeNone" },
	{ value: "open", key: "previewPdfSecurityModeOpen" },
	{ value: "restrict", key: "previewPdfSecurityModeRestrict" }
]

const ALLOWS: readonly { readonly value: keyof PdfAllowed; readonly key: PreviewKey }[] = [
	{ value: "print", key: "previewPdfSecurityAllowPrint" },
	{ value: "copy", key: "previewPdfSecurityAllowCopy" },
	{ value: "change", key: "previewPdfSecurityAllowChange" }
]

const ISSUE_KEYS: Readonly<Record<PasswordIssue, PreviewKey>> = {
	mismatch: "previewPdfSecurityMismatch",
	refused: "previewPdfSecurityRefused"
}

export interface PdfProtectDialogProps {
	open: boolean
	// The caller is applying a choice; the dialog is held.
	pending: boolean
	current: PdfSecuritySummary
	onOpenChange: (open: boolean) => void
	// A choice that changes something (never "keep"); the caller plans it in the engine for the next save.
	onApply: (choice: PdfSecurityChoice) => void
	// Opens the owner password prompt (shown when the document's restrictions lock its security).
	onUnlock: () => void
}

// A password typed twice. `issue` shows under the confirmation (a refused password under the password itself).
function PasswordPair({
	id,
	label,
	confirmLabel,
	password,
	confirm,
	issue,
	disabled,
	onPassword,
	onConfirm
}: {
	id: string
	label: string
	confirmLabel: string
	password: string
	confirm: string
	issue: PasswordIssue | null
	disabled: boolean
	onPassword: (value: string) => void
	onConfirm: (value: string) => void
}) {
	const { t } = useTranslation("preview")
	const refused = issue === "refused"
	const mismatch = issue === "mismatch" && confirm !== ""

	return (
		<>
			<Field data-invalid={refused ? true : undefined}>
				<FieldLabel htmlFor={`${id}-password`}>{label}</FieldLabel>
				<SecretInput
					id={`${id}-password`}
					value={password}
					disabled={disabled}
					aria-invalid={refused}
					onChange={event => {
						onPassword(event.target.value)
					}}
				/>
				{refused ? <FieldError>{t(ISSUE_KEYS.refused)}</FieldError> : null}
			</Field>
			<Field data-invalid={mismatch ? true : undefined}>
				<FieldLabel htmlFor={`${id}-confirm`}>{confirmLabel}</FieldLabel>
				<SecretInput
					id={`${id}-confirm`}
					value={confirm}
					disabled={disabled || password === ""}
					aria-invalid={mismatch}
					onChange={event => {
						onConfirm(event.target.value)
					}}
				/>
				{mismatch ? <FieldError>{t(ISSUE_KEYS.mismatch)}</FieldError> : null}
			</Field>
		</>
	)
}

// Protect document: no password, a password to open, or restricted editing and printing (an owner password, the
// allowed actions, an optional password to open). New encryption is AES-256; an RC4 file is offered the upgrade.
// Without owner access to an encrypted document only the upgrade is possible, with the owner restriction text and an
// Unlock action. Each opening starts from `current`.
export function PdfProtectDialog({ open, pending, current, onOpenChange, onApply, onUnlock }: PdfProtectDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [form, setForm] = useState<ProtectForm>(() => initialForm(current))
	const [seen, setSeen] = useState({ open, current })

	if (seen.open !== open || seen.current !== current) {
		setSeen({ open, current })

		if (open) setForm(initialForm(current))
	}

	const locked = isLocked(current)
	const mode = currentMode(current)
	const { choice, errors } = protectChoice(current, form)
	const busy = pending || locked
	const keepHint = form.mode === mode && mode !== "none"

	function update(next: Partial<ProtectForm>): void {
		setForm({ ...form, ...next })
	}

	return (
		<FormDialog
			open={open}
			pending={pending}
			title={t("previewPdfSecurityTitle")}
			description={t("previewPdfSecurityBody")}
			submitLabel={t("previewPdfSecurityApply")}
			cancelLabel={t("common:cancel")}
			canSubmit={changesSomething(choice)}
			onOpenChange={onOpenChange}
			onSubmit={event => {
				event.preventDefault()

				if (pending || !changesSomething(choice)) return

				onApply(choice)
			}}
		>
			<FieldGroup>
				{locked ? (
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
						<span>{t("previewPdfSecurityOwnerRestricted")}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							onClick={onUnlock}
						>
							{t("previewPdfSecurityUnlockAction")}
						</Button>
					</div>
				) : null}
				<Field>
					<FieldLabel id={`${id}-mode-label`}>{t("previewPdfSecurityModeLabel")}</FieldLabel>
					<RadioGroup
						aria-labelledby={`${id}-mode-label`}
						name={`${id}-mode`}
						value={form.mode}
						disabled={busy}
						className="flex flex-col gap-2"
						onValueChange={next => {
							const found = MODES.find(item => item.value === next)

							if (found !== undefined) update({ mode: found.value })
						}}
					>
						{MODES.map(item => (
							<div
								key={item.value}
								className="flex items-center gap-2"
							>
								<RadioGroupItem
									id={`${id}-mode-${item.value}`}
									value={item.value}
								/>
								<Label htmlFor={`${id}-mode-${item.value}`}>{t(item.key)}</Label>
							</div>
						))}
					</RadioGroup>
				</Field>
				{form.mode === "none" && mode !== "none" && !locked ? (
					<FieldDescription>{t("previewPdfSecurityRemoveNote")}</FieldDescription>
				) : null}
				{form.mode === "open" && !locked ? (
					<PasswordPair
						id={`${id}-open`}
						label={t("previewPdfSecurityPassword")}
						confirmLabel={t("previewPdfSecurityConfirm")}
						password={form.password}
						confirm={form.confirm}
						issue={errors.password}
						disabled={pending}
						onPassword={value => {
							update({ password: value, confirm: value === "" ? "" : form.confirm })
						}}
						onConfirm={value => {
							update({ confirm: value })
						}}
					/>
				) : null}
				{form.mode === "restrict" ? (
					<>
						<fieldset className="flex flex-col gap-1.5">
							<legend className="mb-1.5 text-sm font-medium">{t("previewPdfSecurityAllowed")}</legend>
							<div className="flex flex-wrap gap-x-5 gap-y-1.5">
								{ALLOWS.map(item => (
									<label
										key={item.value}
										className="flex items-center gap-2 text-sm"
									>
										<input
											type="checkbox"
											className="size-4 accent-primary"
											checked={form.allowed[item.value]}
											disabled={busy}
											onChange={event => {
												update({ allowed: { ...form.allowed, [item.value]: event.target.checked } })
											}}
										/>
										{t(item.key)}
									</label>
								))}
							</div>
						</fieldset>
						{locked ? null : (
							<>
								<PasswordPair
									id={`${id}-owner`}
									label={t("previewPdfSecurityOwnerPassword")}
									confirmLabel={t("previewPdfSecurityOwnerConfirm")}
									password={form.ownerPassword}
									confirm={form.ownerConfirm}
									issue={errors.owner}
									disabled={pending}
									onPassword={value => {
										update({ ownerPassword: value, ownerConfirm: value === "" ? "" : form.ownerConfirm })
									}}
									onConfirm={value => {
										update({ ownerConfirm: value })
									}}
								/>
								<PasswordPair
									id={`${id}-user`}
									label={t("previewPdfSecurityOpenPassword")}
									confirmLabel={t("previewPdfSecurityOpenConfirm")}
									password={form.openPassword}
									confirm={form.openConfirm}
									issue={errors.open}
									disabled={pending}
									onPassword={value => {
										update({ openPassword: value, openConfirm: value === "" ? "" : form.openConfirm })
									}}
									onConfirm={value => {
										update({ openConfirm: value })
									}}
								/>
								{errors.same ? <FieldError>{t("previewPdfSecuritySame")}</FieldError> : null}
							</>
						)}
						<FieldDescription>{t("previewPdfSecurityAdvisory")}</FieldDescription>
					</>
				) : null}
				{keepHint && !locked ? <FieldDescription>{t("previewPdfSecurityKeepHint")}</FieldDescription> : null}
				{current.rc4 ? (
					<Field>
						<label className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								className="mt-0.5 size-4 shrink-0 accent-primary"
								checked={form.upgrade}
								disabled={pending || current.upgrade !== null}
								onChange={event => {
									update({ upgrade: event.target.checked })
								}}
							/>
							{t("previewPdfSecurityUpgrade")}
						</label>
						{current.upgrade === null ? null : <FieldDescription>{t("previewPdfSecurityUpgradeUnavailable")}</FieldDescription>}
					</Field>
				) : null}
				{form.mode === "none" ? null : <FieldDescription>{t("previewPdfSecurityAes")}</FieldDescription>}
			</FieldGroup>
		</FormDialog>
	)
}
