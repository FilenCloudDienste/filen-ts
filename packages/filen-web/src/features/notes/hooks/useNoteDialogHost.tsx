import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { useDialogHost } from "@/lib/useDialogHost"
import { setNoteTitle, deleteNote, leaveNote } from "@/features/notes/lib/actions"
import { createNoteTag, addTagToNote, renameNoteTag, deleteNoteTag } from "@/features/notes/lib/tags"
import { trashNotes, deleteNotesPermanently, leaveNotes } from "@/features/notes/lib/bulk"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { toastNotesBulkOutcome } from "@/features/notes/lib/bulkToast"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"
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
// button, neither of which has a note to tag along the way).
type ActiveNoteDialog =
	| { kind: NoteActionDialogKind; note: Note }
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

export interface UseNoteDialogHostParams {
	// The uuid currently shown in this surface's editor route ("" when none) — delete/leave navigate
	// away from THIS uuid before removing the note from cache, so the route never briefly resolves to a
	// gone note (the router-native equivalent of mobile's deferred-cache-removal nav-race guard). Both
	// the sidebar and the editor header instantiate their own host with this
	// param, so a row-triggered delete of the currently-open note still navigates correctly.
	currentUuid: string
}

// One instance of whichever dialog is active at a time — the note-menu counterpart to drive's
// useDriveDialogHost, covering the single-note kinds noteMenu.tsx dispatches (rename/delete/leave),
// the tags submenu's inline "new tag" entry (createTag), the tag-row menu's own kinds, and the notes
// bulk-action bar's confirm dialogs (trashSelected/deleteSelected/leaveSelected).
export function useNoteDialogHost({ currentUuid }: UseNoteDialogHostParams): NoteDialogHost {
	const { t } = useTranslation(["notes", "common"])
	const navigate = useNavigate()
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, isDialogOpen, closeActiveDialog } =
		useDialogHost<ActiveNoteDialog>()

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

	function navigateAwayIfCurrent(note: Note): void {
		if (note.uuid === currentUuid) {
			void navigate({ to: "/notes" })
		}
	}

	async function handleRenameSubmit(note: Note, value: string): Promise<void> {
		setDialogPending(true)
		const outcome = await setNoteTitle(note, value)
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleDeleteConfirm(note: Note): Promise<void> {
		setDialogPending(true)
		const outcome = await deleteNote(note, {
			beforeCacheRemoval: () => {
				navigateAwayIfCurrent(note)
			}
		})
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleLeaveConfirm(note: Note): Promise<void> {
		setDialogPending(true)
		const outcome = await leaveNote(note, {
			beforeCacheRemoval: () => {
				navigateAwayIfCurrent(note)
			}
		})
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	// Shared tail for every bulk-dialog confirm (trashSelected/deleteSelected/leaveSelected): runs
	// `op` against `notes`, tracks the shared dialogPending flag, closes the dialog, toasts the
	// outcome, and prunes succeeded notes from the selection — a failed one stays selected so the
	// user can retry without re-selecting. Mirrors useDriveDialogHost's own runBulkDialogAction.
	async function runBulkDialogAction(notes: Note[], op: (notes: Note[]) => Promise<BulkOutcome<Note>>): Promise<void> {
		setDialogPending(true)
		const outcome = await op(notes)
		setDialogPending(false)
		closeActiveDialog()
		toastNotesBulkOutcome(outcome)
		useNotesSelectionStore.getState().removeFromSelection(outcome.succeeded.map(note => note.uuid))
	}

	async function handleTrashSelectedConfirm(notes: Note[]): Promise<void> {
		await runBulkDialogAction(notes, trashNotes)
	}

	async function handleDeleteSelectedConfirm(notes: Note[]): Promise<void> {
		await runBulkDialogAction(notes, targetNotes => deleteNotesPermanently(targetNotes, { beforeCacheRemoval: navigateAwayIfCurrent }))
	}

	async function handleLeaveSelectedConfirm(notes: Note[]): Promise<void> {
		await runBulkDialogAction(notes, targetNotes => leaveNotes(targetNotes, { beforeCacheRemoval: navigateAwayIfCurrent }))
	}

	async function handleRenameTagSubmit(tag: NoteTag, value: string): Promise<void> {
		setDialogPending(true)
		const outcome = await renameNoteTag(tag, value)
		setDialogPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a reserved name) so the user can fix the name and retry —
			// same convention as the note rename above.
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleDeleteTagConfirm(tag: NoteTag): Promise<void> {
		setDialogPending(true)
		const outcome = await deleteNoteTag(tag)
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleCreateTagSubmit(note: Note, name: string): Promise<void> {
		setDialogPending(true)
		const tagOutcome = await createNoteTag(name)

		if (tagOutcome.status === "error") {
			setDialogPending(false)
			toast.error(errorLabel(tagOutcome.dto))
			return
		}

		// old-web parity: creating a tag from a note's own menu immediately tags that
		// note too, saving the user a second interaction.
		const tagged = await addTagToNote(note, tagOutcome.item)
		setDialogPending(false)

		if (tagged.status === "error") {
			toast.error(errorLabel(tagged.dto))
			return
		}

		closeActiveDialog()
	}

	// Standalone tag creation: unlike handleCreateTagSubmit above, there is no note to attach the
	// new tag to (the whole point — this is reachable with zero notes in the account).
	async function handleCreateStandaloneTagSubmit(name: string): Promise<void> {
		setDialogPending(true)
		const outcome = await createNoteTag(name)
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
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
							void handleCreateTagSubmit(activeDialog.note, value)
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
