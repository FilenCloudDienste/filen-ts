import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { type AlertDialogRoot } from "@base-ui/react/alert-dialog"
import { ArrowLeftIcon, GitCompareArrowsIcon } from "lucide-react"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@filen/shared"

interface RemoteChangeDialogProps {
	// "revised": a newer version was saved elsewhere. "deleted": the item was trashed or deleted.
	kind: "revised" | "deleted"
	title: string
	body: string
	// Renders the comparison of the newer version with `mine`, the unsaved edits as they were when it
	// opened. Omitted where no line diff can show the difference (anything but text, code, markdown).
	renderCompare?: ((mine: string) => ReactNode) | undefined
	readMine: () => string | undefined
	pending: boolean
	onKeepMine: () => void
	onLoadTheirs: () => void
	// Omitted where the edits have no save source (a read-only viewer): the dialog says why instead.
	onSaveMineAsNew?: (() => void) | undefined
	onDiscardMine?: (() => void) | undefined
}

// Asks what happens to unsaved edits when what they edit changed elsewhere — shared by the file editors
// and notes. A newer version was saved: keep mine, load theirs, or save mine as a copy, after an optional
// side-by-side comparison; Keep mine is the default and what Escape means, as it loses nothing. It was
// deleted: save mine as a new file, the default, or discard; Escape does nothing there, as both answers
// matter; without a save, keeping the edits on screen replaces it as the default. Mount it keyed by what
// it asks about, so a new question starts outside the comparison.
export function RemoteChangeDialog({
	kind,
	title,
	body,
	renderCompare,
	readMine,
	pending,
	onKeepMine,
	onLoadTheirs,
	onSaveMineAsNew,
	onDiscardMine
}: RemoteChangeDialogProps) {
	const { t } = useTranslation("preview")
	// The edits as they were when the comparison opened; editing is blocked while the dialog is up.
	const [comparing, setComparing] = useState<string | null>(null)

	function handleOpenChange(next: boolean, details: AlertDialogRoot.ChangeEventDetails): void {
		if (next) {
			return
		}

		details.cancel()

		if (!pending && kind === "revised") {
			onKeepMine()
		}
	}

	return (
		<AlertDialog
			open
			onOpenChange={handleOpenChange}
		>
			<AlertDialogContent
				className={cn(
					comparing === null
						? "data-[size=default]:sm:max-w-xl"
						: "h-[min(85vh,52rem)] grid-rows-[auto_minmax(0,1fr)_auto] data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-6xl"
				)}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					{/* A file name is one long word as far as line breaking goes. */}
					<AlertDialogDescription className="wrap-anywhere">{body}</AlertDialogDescription>
					{onSaveMineAsNew === undefined ? (
						<AlertDialogDescription>{t("previewRemoteSaveUnavailable")}</AlertDialogDescription>
					) : null}
				</AlertDialogHeader>
				{comparing !== null && renderCompare !== undefined ? renderCompare(comparing) : null}
				{/* Wraps rather than overflowing the card when the labels run long (translations). */}
				<AlertDialogFooter className="sm:flex-wrap sm:items-center">
					{kind === "revised" && renderCompare !== undefined ? (
						<Button
							variant="ghost"
							className="sm:mr-auto"
							disabled={pending}
							onClick={() => {
								setComparing(prev => (prev === null ? (readMine() ?? "") : null))
							}}
						>
							{comparing === null ? (
								<GitCompareArrowsIcon data-icon="inline-start" />
							) : (
								<ArrowLeftIcon data-icon="inline-start" />
							)}
							{t(comparing === null ? "previewRemoteCompare" : "previewRemoteCompareBack")}
						</Button>
					) : null}
					{kind === "deleted" ? (
						<>
							<Button
								variant="destructive"
								disabled={pending}
								onClick={onDiscardMine}
							>
								{t("previewRemoteDiscardMine")}
							</Button>
							{onSaveMineAsNew === undefined ? (
								<Button
									autoFocus
									onClick={onKeepMine}
								>
									{t("previewRemoteKeepOpen")}
								</Button>
							) : (
								<Button
									autoFocus
									disabled={pending}
									onClick={onSaveMineAsNew}
								>
									{pending ? <Spinner data-icon="inline-start" /> : null}
									{t("previewRemoteSaveAsNew")}
								</Button>
							)}
						</>
					) : (
						<>
							{onSaveMineAsNew === undefined ? null : (
								<Button
									variant="outline"
									disabled={pending}
									onClick={onSaveMineAsNew}
								>
									{pending ? <Spinner data-icon="inline-start" /> : null}
									{t("previewRemoteSaveCopy")}
								</Button>
							)}
							<Button
								variant="outline"
								disabled={pending}
								onClick={onLoadTheirs}
							>
								{t("previewRemoteLoadTheirs")}
							</Button>
							<Button
								autoFocus
								disabled={pending}
								onClick={onKeepMine}
							>
								{t("previewRemoteKeepMine")}
							</Button>
						</>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
