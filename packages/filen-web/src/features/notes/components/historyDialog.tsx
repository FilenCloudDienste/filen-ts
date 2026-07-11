import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ArrowLeftIcon, HistoryIcon, RotateCcwIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { Note, NoteHistory } from "@filen/sdk-rs"
import { useNotes } from "@/features/notes/queries/notes"
import { useNoteHistoryQuery } from "@/features/notes/queries/noteHistory"
import { sortNoteHistory } from "@/features/notes/lib/sort"
import { restoreNoteFromHistory } from "@/features/notes/lib/history"
import { noteTypeIcon } from "@/features/notes/lib/icon.logic"
import { NoteReaderByType } from "@/features/notes/components/reader/noteReaderByType"
import { formatVersionTimestamp } from "@/features/drive/lib/format"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface HistoryDialogProps {
	note: Note
	onClose: () => void
}

// Version-history panel — mounted-when-active by the surface's dialog host, open to every participant:
// history is view-open, restore is not further gated by this dialog — the SDK itself
// is the authority on write access. List view first; selecting a row swaps to a read-only preview of
// that version (NoteReaderByType, the same dispatch the live editor's own trashed/non-writable branch
// uses) rather than a second nested dialog — one panel, two "pages", mirrors versionsDialog.tsx's own
// list+nested-confirm shape but adds this extra preview page since a note version, unlike a file
// version, has meaningfully previewable rich content.
export function HistoryDialog({ note: initialNote, onClose }: HistoryDialogProps) {
	const { t } = useTranslation(["notes", "common"])
	const notesQuery = useNotes()
	const note = notesQuery.data?.find(n => n.uuid === initialNote.uuid) ?? initialNote
	const historyQuery = useNoteHistoryQuery(note)

	const [previewing, setPreviewing] = useState<NoteHistory | null>(null)
	const [confirmingRestore, setConfirmingRestore] = useState<NoteHistory | null>(null)
	const [pending, setPending] = useState(false)

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleRestoreConfirmed(history: NoteHistory): Promise<void> {
		setPending(true)
		const outcome = await restoreNoteFromHistory(note, history)
		setPending(false)
		setConfirmingRestore(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		// The restore already reseeds the (possibly mounted) editor via its own cache-write/invalidate —
		// nothing left for this panel to show once it has landed.
		onClose()
	}

	function renderPreview(history: NoteHistory) {
		return (
			<div className="flex h-80 flex-col gap-3">
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={pending}
						onClick={() => {
							setPreviewing(null)
						}}
					>
						<ArrowLeftIcon aria-hidden="true" />
						{t("noteHistoryBackToList")}
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden rounded-xl ring-1 ring-foreground/5 dark:ring-foreground/10">
					{history.content !== undefined ? (
						<NoteReaderByType
							note={{ ...note, noteType: history.noteType }}
							content={history.content}
						/>
					) : (
						<div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
							{t("noteHistoryPreviewUnavailable")}
						</div>
					)}
				</div>
			</div>
		)
	}

	function renderList() {
		if (historyQuery.status === "pending") {
			return (
				<div className="flex justify-center py-8">
					<Spinner />
				</div>
			)
		}

		if (historyQuery.status === "error") {
			return (
				<Empty className="p-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HistoryIcon />
						</EmptyMedia>
						<EmptyTitle>{t("noteHistoryLoadError")}</EmptyTitle>
					</EmptyHeader>
					<p className="text-center text-sm text-muted-foreground">{errorLabel(asErrorDTO(historyQuery.error))}</p>
				</Empty>
			)
		}

		const sorted = sortNoteHistory(historyQuery.data)

		if (sorted.length === 0) {
			return (
				<Empty className="p-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HistoryIcon />
						</EmptyMedia>
						<EmptyTitle>{t("noteHistoryEmpty")}</EmptyTitle>
					</EmptyHeader>
				</Empty>
			)
		}

		return (
			<ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
				{sorted.map(history => {
					const { icon: Icon, colorClass } = noteTypeIcon(history.noteType)

					return (
						<li
							key={history.id.toString()}
							className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm"
						>
							<Icon className={`size-4 shrink-0 ${colorClass}`} />
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium">{formatVersionTimestamp(history.editedTimestamp)}</p>
								<p className="truncate text-xs text-muted-foreground">{history.preview ?? t("noteHistoryNoPreview")}</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								disabled={pending}
								onClick={() => {
									setPreviewing(history)
								}}
							>
								{t("noteHistoryViewAction")}
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={pending}
								aria-label={t("noteHistoryRestoreAction")}
								onClick={() => {
									setConfirmingRestore(history)
								}}
							>
								<RotateCcwIcon aria-hidden="true" />
							</Button>
						</li>
					)
				})}
			</ul>
		)
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={pending}
				className="sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>{t("noteHistoryDialogTitle")}</DialogTitle>
				</DialogHeader>
				{previewing ? renderPreview(previewing) : renderList()}
			</DialogContent>
			{/* Nested confirmation — same "must stay a child of the outer Dialog" rule as versionsDialog.tsx. */}
			<ConfirmDialog
				open={confirmingRestore !== null}
				pending={pending}
				title={t("noteHistoryRestoreDialogTitle")}
				body={t("noteHistoryRestoreDialogBody")}
				confirmLabel={t("noteHistoryRestoreAction")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setConfirmingRestore(null)
					}
				}}
				onConfirm={() => {
					if (confirmingRestore) {
						void handleRestoreConfirmed(confirmingRestore)
					}
				}}
			/>
		</Dialog>
	)
}
