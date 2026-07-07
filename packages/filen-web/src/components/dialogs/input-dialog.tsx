import { useState, type ComponentProps, type SubmitEvent } from "react"
import { type DialogRoot } from "@base-ui/react/dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { seededValueOnOpen } from "@/components/dialogs/input-dialog.logic"

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
	// Optional input-attribute passthroughs (e.g. type="password" + autoComplete="current-password",
	// or inputMode="numeric" + maxLength for a one-time code). The DOM attribute types already carry
	// `| undefined`, so possibly-undefined caller state passes through directly under
	// exactOptionalPropertyTypes. Omitted = the plain-text default.
	type?: ComponentProps<"input">["type"]
	inputMode?: ComponentProps<"input">["inputMode"]
	autoComplete?: ComponentProps<"input">["autoComplete"]
	maxLength?: ComponentProps<"input">["maxLength"]
	submitLabel: string
	validate: (value: string) => boolean
	onOpenChange: (open: boolean) => void
	onSubmit: (value: string) => void
}

// Generic single-field prompt built on the dialog primitive — the shared base for "type a value and
// submit" flows (the pre-primitive forgot-password dialog's shape, generalized). Namespace-agnostic
// like every dialog primitive in this directory: every label is caller-resolved. The typed value
// starts at initialValue (blank when omitted) and resets on every open transition (adjusting state
// during render, same "reset state when a prop changes" pattern the forgot-password dialog and
// TypedConfirmDialog use — see input-dialog.logic.ts) so a dismissed prompt never resurfaces a stale
// value the next time it opens. Dismissal is BLOCKED while `pending` — Escape, outside-press and the
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
	type,
	inputMode,
	autoComplete,
	maxLength,
	submitLabel,
	validate,
	onOpenChange,
	onSubmit
}: InputDialogProps) {
	const [wasOpen, setWasOpen] = useState(open)
	const [value, setValue] = useState(initialValue ?? "")
	if (open !== wasOpen) {
		setWasOpen(open)
		const seeded = seededValueOnOpen(open, wasOpen, initialValue ?? "")
		if (seeded !== null) {
			setValue(seeded)
		}
	}
	const valid = validate(value)

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			// Also stops Base UI's own store from flipping (it closes itself after this callback
			// unless the event is canceled) — see dismissal.logic.ts.
			details.cancel()
			return
		}
		onOpenChange(next)
	}

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()
		if (pending || !valid) {
			return
		}
		onSubmit(value)
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
					<Field>
						<FieldLabel htmlFor="input-dialog-value">{label}</FieldLabel>
						<Input
							id="input-dialog-value"
							type={type}
							inputMode={inputMode}
							autoComplete={autoComplete}
							maxLength={maxLength}
							value={value}
							autoFocus
							placeholder={placeholder}
							disabled={pending}
							onChange={e => {
								setValue(e.target.value)
							}}
							onFocus={e => {
								// Base UI's Dialog re-focuses the popup's initial-focus target (this input, via
								// FloatingFocusManager) on every open, not just first mount — so this reliably
								// selects the pre-filled value each time, not only once.
								e.target.select()
							}}
						/>
					</Field>
					<DialogFooter>
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
