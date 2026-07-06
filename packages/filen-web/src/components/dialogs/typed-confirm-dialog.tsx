import { useState, type SubmitEvent } from "react"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { isArmed, shouldResetOnOpen } from "@/components/dialogs/typed-confirm-dialog.logic"

interface TypedConfirmDialogProps {
	open: boolean
	pending: boolean
	title: string
	body: string
	matchLabel: string
	// Live value the typed input must equal exactly — an email, a directory name, etc., that the
	// caller already holds. Never a translated string: i18n copy can reword at any time, which would
	// make the required input silently unreproducible (or trivially wrong) the moment a translation
	// changes — the whole point of typed confirmation is reproducing a value the user already sees
	// elsewhere verbatim.
	matchValue: string
	confirmLabel: string
	cancelLabel: string
	destructive?: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}

// TypedConfirmDialog: `ConfirmDialog`'s confirm/cancel shape plus a match-input that must be typed
// exactly before Confirm arms — the escalation for actions a plain confirm is too easy to trigger by
// accident (e.g. account deletion). Namespace-agnostic like every dialog primitive in this directory:
// every label arrives pre-resolved from the caller. Built directly on ui/alert-dialog.tsx rather than
// composing `ConfirmDialog` — mirrors how the two pre-existing dialog consumers (two-factor,
// forgot-password) each own their full scaffold rather than sharing a base, since the disabled/armed
// condition here differs from ConfirmDialog's plain `pending` gate.
function TypedConfirmDialog({
	open,
	pending,
	title,
	body,
	matchLabel,
	matchValue,
	confirmLabel,
	cancelLabel,
	destructive = false,
	onOpenChange,
	onConfirm
}: TypedConfirmDialogProps) {
	// Re-armed dialogs must never resurrect a previous attempt's typed value — adjusting state during
	// render (React's documented "reset state when a prop changes" pattern) rather than an effect,
	// which would commit an extra render pass. Mirrors the forgot-password dialog's re-seed pattern.
	const [wasOpen, setWasOpen] = useState(open)
	const [typed, setTyped] = useState("")
	if (open !== wasOpen) {
		setWasOpen(open)
		if (shouldResetOnOpen(open, wasOpen)) {
			setTyped("")
		}
	}
	const armed = isArmed(typed, matchValue)

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()
		// Guards a disabled-but-still-submittable form (Enter fires onSubmit regardless of the
		// button's own `disabled` state) — the button's `disabled` is a visual/AT affordance, this is
		// the actual gate.
		if (pending || !armed) {
			return
		}
		onConfirm()
	}

	return (
		<AlertDialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<AlertDialogContent>
				<form
					onSubmit={handleSubmit}
					className="flex flex-col gap-6"
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{title}</AlertDialogTitle>
						<AlertDialogDescription>{body}</AlertDialogDescription>
					</AlertDialogHeader>
					<Field>
						<FieldLabel htmlFor="typed-confirm-value">{matchLabel}</FieldLabel>
						<Input
							id="typed-confirm-value"
							value={typed}
							autoFocus
							autoComplete="off"
							disabled={pending}
							onChange={e => {
								setTyped(e.target.value)
							}}
						/>
					</Field>
					<AlertDialogFooter>
						<AlertDialogCancel
							type="button"
							disabled={pending}
						>
							{cancelLabel}
						</AlertDialogCancel>
						<AlertDialogAction
							type="submit"
							variant={destructive ? "destructive" : "default"}
							disabled={pending || !armed}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{confirmLabel}
						</AlertDialogAction>
					</AlertDialogFooter>
				</form>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export { TypedConfirmDialog }
export type { TypedConfirmDialogProps }
