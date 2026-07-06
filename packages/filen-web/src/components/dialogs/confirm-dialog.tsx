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
import { Spinner } from "@/components/ui/spinner"

interface ConfirmDialogProps {
	open: boolean
	pending: boolean
	title: string
	body: string
	confirmLabel: string
	cancelLabel: string
	destructive?: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}

// Generic confirm/cancel prompt built on the alert-dialog primitive — the shared base for every "are
// you sure" surface (sign-out, delete, etc.). Namespace-agnostic like every dialog primitive in this
// directory: every label arrives pre-resolved from the caller, so this file never imports
// `useTranslation`. `onConfirm` is fire-and-forget from this component's point of view — the same
// contract as the existing two-factor dialog's `onSubmit` — the caller owns the async lifecycle (sets
// `pending`, closes via `onOpenChange` on success, keeps the dialog open and surfaces an error on
// failure) rather than this primitive awaiting or closing on its behalf. No text input here, so
// (unlike its siblings) there is no `<form>`: the confirm button is a plain, auto-focused, native
// button — Enter activates it, and `disabled` while pending blocks both the click and the Enter key
// natively, no bespoke listener needed.
function ConfirmDialog({
	open,
	pending,
	title,
	body,
	confirmLabel,
	cancelLabel,
	destructive = false,
	onOpenChange,
	onConfirm
}: ConfirmDialogProps) {
	return (
		<AlertDialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{body}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
					<AlertDialogAction
						autoFocus
						variant={destructive ? "destructive" : "default"}
						disabled={pending}
						onClick={() => {
							if (pending) {
								return
							}
							onConfirm()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export { ConfirmDialog }
export type { ConfirmDialogProps }
