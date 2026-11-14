import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@filen/shared"

export interface PrintDialogFrameProps {
	title: string
	description: string
	// The print's choices (what prints, paper, quality).
	children: ReactNode
	// Beside the choices: the pages as they print, notes on the job.
	aside?: ReactNode
	// The Print button's label, its progress while the pages are prepared.
	printLabel: string
	// Pages are being prepared: every choice and the close button are disabled, the button shows a spinner.
	busy: boolean
	canPrint: boolean
	onPrint: () => void
	// Buttons before Print (Save as PDF).
	actions?: ReactNode
	// Stops the preparation (Cancel stays enabled while busy); unset: Cancel waits like the close button.
	onCancelBusy?: (() => void) | undefined
	onClose: () => void
	className?: string
}

// The print dialog's frame, shared by the office editors and the PDF viewer: title, the choices beside an optional
// aside, then Cancel, the host's actions and Print, which shows the progress while the pages are prepared. Mounted
// anew for each opening.
export function PrintDialogFrame({
	title,
	description,
	children,
	aside,
	printLabel,
	busy,
	canPrint,
	onPrint,
	actions,
	onCancelBusy,
	onClose,
	className
}: PrintDialogFrameProps) {
	const { t } = useTranslation("common")
	const cancel = (): void => {
		if (!busy) onClose()
		else onCancelBusy?.()
	}

	return (
		<Dialog
			open
			onOpenChange={next => {
				if (!next && !busy) {
					onClose()
				}
			}}
		>
			<DialogContent
				closeButtonDisabled={busy}
				data-preview-surface
				className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", className)}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{aside === undefined ? (
					<div className="flex min-w-0 flex-col gap-5">{children}</div>
				) : (
					<div className="flex flex-col gap-6 sm:flex-row">
						<div className="flex min-w-0 flex-1 flex-col gap-5">{children}</div>
						{aside}
					</div>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={busy && onCancelBusy === undefined}
						onClick={cancel}
					>
						{t("cancel")}
					</Button>
					{actions}
					<Button
						type="button"
						disabled={busy || !canPrint}
						onClick={onPrint}
					>
						{busy ? <Spinner data-icon="inline-start" /> : null}
						{printLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
