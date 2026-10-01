import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { selectedNoteUuidFromPath } from "@/features/notes/lib/route"
import { toast } from "sonner"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { useDialogHost } from "@/lib/useDialogHost"
import { setNoteTitle, deleteNote, leaveNote } from "@/features/notes/lib/actions"
import { createNoteTag, renameNoteTag, deleteNoteTag } from "@/features/notes/lib/tags"
import { createTagForNote, type CreatedTag } from "@/features/notes/lib/createTagForNote"
import { trashNotes, deleteNotesPermanently, leaveNotes } from "@/features/notes/lib/bulk"
import { NOTES_DELETE_PERMANENTLY, NOTES_LEAVE, NOTES_TRASH, notesActivity } from "@/features/notes/lib/activity"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { type NoteActionDialogKind, type NoteTagDialogKind } from "@/features/notes/components/noteMenu.logic"
import { type NoteBulkDialogActionKind } from "@/features/notes/components/notesBulkActionBar.logic"
import { ParticipantsDialog } from "@/features/notes/components/participantsDialog"
import { HistoryDialog } from "@/features/notes/components/historyDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// Discriminates on `kind` alone — NoteActionDialogKind/NoteTagDialogKind/NoteBulkDialogActionKind are
// three disjoint string unions (noteMenu.logic.ts / notesBulkActionBar.logic.ts), so each arm carries
// exactly the payload its own kinds need without a separate discriminant field. "createStandaloneTag"
// is its own fourth kind, disjoint from the note-scoped "createTag" above: it carries no note at all —
// a user with zero notes can still reach it (the sidebar header's "..." menu and the tags empty-state
// button, neither of which has a note to tag along the way). `createdTag` is createTag's retry memory:
// the tag an attempt created before tagging the note failed, gone with the dialog.
type ActiveNoteDialog =
	| { kind: NoteActionDialogKind; note: Note; createdTag?: CreatedTag }
	| { kind: NoteTagDialogKind; tag: NoteTag }
	| { kind: NoteBulkDialogActionKind; notes: Note[] }
	| { kind: "createStandaloneTag" }

export interface NoteDialogHost {
	isDialogOpen: boolean
	openNoteDialog: (kind: NoteActionDialogKind, note: Note) => void
	openTagDialog: (kind: NoteTagDialogKind, tag: NoteTag) => void
	openBulkDialog: (kind: NoteBulkDialogActionKind, notes: Note[]) => void
	openCreateTagDialog: () => void
	renderActiveDialog: () => ReactNode
}

// One instance of whichever dialog is active at a time — the note-menu counterpart to drive's
// useDriveDialogHost, covering the single-note kinds noteMenu.tsx dispatches (rename/delete/leave),
// the tags submenu's inline "new tag" entry (createTag), the tag-row menu's own kinds, and the notes
// bulk-action bar's confirm dialogs (trashSelected/deleteSelected/leaveSelected).
export function useNoteDialogHost(): NoteDialogHost {
	const { t } = useTranslation(["notes", "common"])
	const navigate = useNavigate()
	const router = useRouter()
	const {
		activeDialog,
		setActiveDialog,
		dialogPending,
		isDialogOpen,
		closeActiveDialog,
		runDialogPending,
		runDialogOutcome,
		runBulkDialogActivity
	} = useDialogHost<ActiveNoteDialog>()

	function openNoteDialog(kind: NoteActionDialogKind, note: Note): void {
		setActiveDialog({ kind, note })
	}

	function openTagDialog(kind: NoteTagDialogKind, tag: NoteTag): void {
		setActiveDialog({ kind, tag })
	}

	function openBulkDialog(kind: NoteBulkDialogActionKind, notes: Note[]): void {
		setActiveDialog({ kind, notes })
	}

	function openCreateTagDialog(): void {
		setActiveDialog({ kind: "createStandaloneTag" })
	}

	// Delete/leave navigate away from the note on screen before removing it from cache, so the route never
	// briefly resolves to a gone note. The route is read as each note settles: a handed-off bulk run (or
	// its Try again) can end after the user opened another note.
	function navigateAwayIfCurrent(note: Note): void {
		if (note.uuid === selectedNoteUuidFromPath(router.state.location.pathname)) {
			void navigate({ to: "/notes" })
		}
	}

	async function handleRenameSubmit(note: Note, value: string): Promise<void> {
		await runDialogOutcome(() => setNoteTitle(note, value))
	}

	async function handleDeleteConfirm(note: Note): Promise<void> {
		await runDialogOutcome(() =>
			deleteNote(note, {
				beforeCacheRemoval: () => {
					navigateAwayIfCurrent(note)
				}
			})
		)
	}

	async function handleLeaveConfirm(note: Note): Promise<void> {
		await runDialogOutcome(() =>
			leaveNote(note, {
				beforeCacheRemoval: () => {
					navigateAwayIfCurrent(note)
				}
			})
		)
	}

	// Every bulk-dialog confirm (trashSelected/deleteSelected/leaveSelected) runs as an activity
	// (useDialogHost's runBulkDialogActivity) and prunes the succeeded notes from the selection.
	async function handleTrashSelectedConfirm(notes: Note[]): Promise<void> {
		await runBulkDialogActivity(notesActivity(notes, NOTES_TRASH, trashNotes))
	}

	async function handleDeleteSelectedConfirm(notes: Note[]): Promise<void> {
		await runBulkDialogActivity(
			notesActivity(notes, NOTES_DELETE_PERMANENTLY, (targets, onSettled) =>
				deleteNotesPermanently(targets, { beforeCacheRemoval: navigateAwayIfCurrent }, onSettled)
			)
		)
	}

	async function handleLeaveSelectedConfirm(notes: Note[]): Promise<void> {
		await runBulkDialogActivity(
			notesActivity(notes, NOTES_LEAVE, (targets, onSettled) =>
				leaveNotes(targets, { beforeCacheRemoval: navigateAwayIfCurrent }, onSettled)
			)
		)
	}

	async function handleRenameTagSubmit(tag: NoteTag, value: string): Promise<void> {
		await runDialogOutcome(() => renameNoteTag(tag, value))
	}

	async function handleDeleteTagConfirm(tag: NoteTag): Promise<void> {
		await runDialogOutcome(() => deleteNoteTag(tag))
	}

	// old-web parity: creating a tag from a note's own menu immediately tags that note too, saving the
	// user a second interaction.
	async function handleCreateTagSubmit(dialog: { note: Note; createdTag?: CreatedTag }, name: string): Promise<void> {
		const outcome = await runDialogPending(() => createTagForNote(dialog.note, name, dialog.createdTag))

		if (outcome.status === "error") {
			const { created } = outcome

			if (created !== undefined) {
				// Only onto this same dialog: one closed meanwhile must not reopen.
				setActiveDialog(prev => (prev === dialog ? { ...dialog, kind: "createTag", createdTag: created } : prev))
			}

			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	// Standalone tag creation: unlike handleCreateTagSubmit above, there is no note to attach the
	// new tag to (the whole point — this is reachable with zero notes in the account).
	async function handleCreateStandaloneTagSubmit(name: string): Promise<void> {
		await runDialogOutcome(() => createNoteTag(name))
	}

	function renderActiveDialog(): ReactNode {
		if (!activeDialog) {
			return null
		}

		switch (activeDialog.kind) {
			case "rename":
				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("noteRenameDialogTitle")}
						body={t("noteRenameDialogBody")}
						label={t("noteRenameDialogLabel")}
						initialValue={activeDialog.note.title ?? ""}
						submitLabel={t("noteRenameDialogSubmit")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleRenameSubmit(activeDialog.note, value)
						}}
					/>
				)
			case "delete":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("noteDeleteDialogTitle")}
						body={t("noteDeleteDialogBody")}
						confirmLabel={t("noteActionDeletePermanently")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteConfirm(activeDialog.note)
						}}
					/>
				)
			case "leave":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("noteLeaveDialogTitle")}
						body={t("noteLeaveDialogBody")}
						confirmLabel={t("noteActionLeave")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleLeaveConfirm(activeDialog.note)
						}}
					/>
				)
			case "createTag":
				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("noteCreateTagDialogTitle")}
						body={t("noteCreateTagDialogBody")}
						label={t("noteCreateTagDialogLabel")}
						placeholder={t("noteCreateTagDialogPlaceholder")}
						submitLabel={t("noteCreateTagDialogSubmit")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleCreateTagSubmit(activeDialog, value)
						}}
					/>
				)
			case "createStandaloneTag":
				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("noteCreateTagDialogTitle")}
						body={t("noteCreateTagDialogBody")}
						label={t("noteCreateTagDialogLabel")}
						placeholder={t("noteCreateTagDialogPlaceholder")}
						submitLabel={t("noteCreateTagDialogSubmit")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleCreateStandaloneTagSubmit(value)
						}}
					/>
				)
			case "renameTag":
				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("noteTagRenameDialogTitle")}
						body={t("noteTagRenameDialogBody")}
						label={t("noteTagRenameDialogLabel")}
						initialValue={activeDialog.tag.name ?? ""}
						submitLabel={t("noteTagRenameDialogSubmit")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleRenameTagSubmit(activeDialog.tag, value)
						}}
					/>
				)
			case "deleteTag":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("noteTagDeleteDialogTitle")}
						body={t("noteTagDeleteDialogBody")}
						confirmLabel={t("noteTagActionDelete")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteTagConfirm(activeDialog.tag)
						}}
					/>
				)
			case "participants":
				return (
					<ParticipantsDialog
						note={activeDialog.note}
						onClose={closeActiveDialog}
					/>
				)
			case "history":
				return (
					<HistoryDialog
						note={activeDialog.note}
						onClose={closeActiveDialog}
					/>
				)
			case "trashSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("notesTrashSelectedConfirmTitle")}
						body={t("notesTrashSelectedConfirmBody", { count: activeDialog.notes.length })}
						confirmLabel={t("noteActionTrash")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleTrashSelectedConfirm(activeDialog.notes)
						}}
					/>
				)
			case "deleteSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("notesDeleteSelectedConfirmTitle")}
						body={t("notesDeleteSelectedConfirmBody", { count: activeDialog.notes.length })}
						confirmLabel={t("noteActionDeletePermanently")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteSelectedConfirm(activeDialog.notes)
						}}
					/>
				)
			case "leaveSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("notesLeaveSelectedConfirmTitle")}
						body={t("notesLeaveSelectedConfirmBody", { count: activeDialog.notes.length })}
						confirmLabel={t("noteActionLeave")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleLeaveSelectedConfirm(activeDialog.notes)
						}}
					/>
				)
		}
	}

	return { isDialogOpen, openNoteDialog, openTagDialog, openBulkDialog, openCreateTagDialog, renderActiveDialog }
}
