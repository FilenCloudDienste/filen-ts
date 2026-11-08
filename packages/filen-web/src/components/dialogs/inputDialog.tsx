import { type ComponentProps, type SubmitEvent } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SecretInput } from "@/components/ui/secretInput"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { useSeededOnOpen } from "@/lib/useSeededOnOpen"

interface InputDialogProps {
	open: boolean
	pending: boolean
	title: string
	body: string
	label: string
	placeholder?: string | undefined
	// Pre-fills the field on every closed-to-open transition (rename's existing item name) instead of
	// the always-blank default; the field is also re-selected on open (see the Input's onFocus below)
	// so typing immediately overwrites it. Omitted keeps the original always-blank behavior.
	initialValue?: string | undefined
	// The selection on open stops before the last extension ("Untitled document" of "Untitled
	// document.docx"), so typing renames the file and keeps its type. Omitted selects the whole value.
	selectBaseName?: boolean | undefined
	// A secret that is not the user's Filen login (a PDF's password): masked, and never offered to or
	// saved by a password manager (SecretInput). type/autoComplete do not apply to it. A secret pre-filled
	// is one being typed (carried over a remount), so focus leaves it to be typed on, not selected.
	secret?: boolean
	// Optional input-attribute passthroughs (e.g. type="password" + autoComplete="current-password",
	// or inputMode="numeric" + maxLength for a one-time code). The DOM attribute types already carry
	// `| undefined`, so possibly-undefined caller state passes through directly under
	// exactOptionalPropertyTypes. Omitted = the plain-text default.
	type?: ComponentProps<"input">["type"]
	inputMode?: ComponentProps<"input">["inputMode"]
	autoComplete?: ComponentProps<"input">["autoComplete"]
	maxLength?: ComponentProps<"input">["maxLength"]
	submitLabel: string
	// A second way out beside submitting (another choice than giving the value), in the footer before the
	// submit button. Disabled while `pending`.
	secondaryAction?: { label: string; onClick: () => void } | undefined
	validate: (value: string) => boolean
	// Why the value can't be submitted, shown under the field; null while there is nothing to say (an
	// empty field only disables the submit). Omitted shows nothing.
	errorFor?: ((value: string) => string | null) | undefined
	onOpenChange: (open: boolean) => void
	onSubmit: (value: string) => void
	// Every edit of the value, for a caller that keeps what was typed.
	onValueChange?: ((value: string) => void) | undefined
}

// Generic single-field prompt built on the dialog primitive — the shared base for "type a value and
// submit" flows (the pre-primitive forgot-password dialog's shape, generalized). Namespace-agnostic
// like every dialog primitive in this directory: every label is caller-resolved. The typed value
// starts at initialValue (blank when omitted) and resets on every open transition (useSeededOnOpen)
// so a dismissed prompt never resurfaces a stale value the next time it opens. Dismissal is BLOCKED while `pending` — Escape, outside-press and the
// X close button (also visually disabled) all funnel through onOpenChange, and a `false` while the
// operation runs is a no-op, so the dialog stays open until it settles — rationale in
// dismissal.logic.ts.
function InputDialog({
	open,
	pending,
	title,
	body,
	label,
	placeholder,
	initialValue,
	selectBaseName,
	secret,
	type,
	inputMode,
	autoComplete,
	maxLength,
	submitLabel,
	secondaryAction,
	validate,
	errorFor,
	onOpenChange,
	onSubmit,
	onValueChange
}: InputDialogProps) {
	const [value, setValue] = useSeededOnOpen(open, initialValue ?? "")
	const valid = validate(value)
	const error = errorFor?.(value) ?? null

	const handleOpenChange = pendingGuardedOpenChange(pending, onOpenChange)

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()
		if (pending || !valid) {
			return
		}
		onSubmit(value)
	}

	const fieldProps: ComponentProps<"input"> = {
		id: "input-dialog-value",
		inputMode,
		maxLength,
		value,
		autoFocus: true,
		placeholder,
		disabled: pending,
		"aria-invalid": error !== null ? true : undefined,
		"aria-describedby": error !== null ? "input-dialog-error" : undefined,
		onChange: e => {
			setValue(e.target.value)
			onValueChange?.(e.target.value)
		},
		onFocus: e => {
			if (secret === true) {
				return
			}

			// Base UI's Dialog re-focuses the popup's initial-focus target (this input, via
			// FloatingFocusManager) on every open, not just first mount — so this reliably
			// selects the pre-filled value each time, not only once.
			const dot = e.target.value.lastIndexOf(".")

			if (selectBaseName === true && dot > 0) {
				e.target.setSelectionRange(0, dot)
			} else {
				e.target.select()
			}
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={pending}>
				<form
					onSubmit={handleSubmit}
					className="flex flex-col gap-6"
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{body}</DialogDescription>
					</DialogHeader>
					<Field data-invalid={error !== null ? true : undefined}>
						<FieldLabel htmlFor="input-dialog-value">{label}</FieldLabel>
						{secret === true ? (
							<SecretInput {...fieldProps} />
						) : (
							<Input
								type={type}
								autoComplete={autoComplete}
								{...fieldProps}
							/>
						)}
						{error !== null ? <FieldError id="input-dialog-error">{error}</FieldError> : null}
					</Field>
					<DialogFooter>
						{secondaryAction === undefined ? null : (
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={secondaryAction.onClick}
							>
								{secondaryAction.label}
							</Button>
						)}
						<Button
							type="submit"
							disabled={pending || !valid}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export { InputDialog }
export type { InputDialogProps }
