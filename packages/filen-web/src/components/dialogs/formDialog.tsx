import type { ReactNode, SubmitEvent } from "react"
import { type DialogRoot } from "@base-ui/react/dialog"
import { cn } from "@filen/shared"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"

interface FormDialogProps {
	open: boolean
	pending: boolean
	title: string
	description: string
	submitLabel: string
	cancelLabel: string
	// The caller's whole submit gate (validity AND online); the button is also held disabled while pending.
	canSubmit: boolean
	// Native tooltip on the disabled submit, e.g. the offline reason.
	submitTitle?: string | undefined
	wide?: boolean
	onOpenChange: (open: boolean) => void
	onSubmit: (e: SubmitEvent) => void
	children: ReactNode
}

// A multi-field form in a dialog (settings' email, password and personal information). Same contract as
// the other dialogs here: labels arrive resolved, the caller owns the async lifecycle and closes on
// success, and dismissal is blocked while `pending` (dismissal.logic.ts). Only the submit carries an
// offline gate: filling a form in is harmless.
function FormDialog({
	open,
	pending,
	title,
	description,
	submitLabel,
	cancelLabel,
	canSubmit,
	submitTitle,
	wide,
	onOpenChange,
	onSubmit,
	children
}: FormDialogProps) {
	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			details.cancel()
			return
		}
		onOpenChange(next)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={pending}
				// Scrolls rather than spilling past a short viewport: a tall form stacked to one column.
				className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", wide === true && "sm:max-w-lg")}
			>
				<form
					onSubmit={onSubmit}
					className="flex flex-col gap-6"
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => {
								onOpenChange(false)
							}}
						>
							{cancelLabel}
						</Button>
						<Button
							type="submit"
							disabled={!canSubmit || pending}
							title={submitTitle}
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

export { FormDialog }
