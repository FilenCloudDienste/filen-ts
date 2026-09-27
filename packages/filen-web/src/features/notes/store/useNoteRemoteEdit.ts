import { create } from "zustand"
import { holdNoteForRemoteEdit, releaseNoteHold } from "@/features/notes/lib/remoteEditHolds"
import { tabEditorDirty } from "@/features/notes/lib/tabEditors"

// Per note, "the server's content moved while you have unsynced changes", set by the realtime ContentEdited
// handler ONLY while the note has them — a note without reloads instead. Surfaced as the
// editor's remote-change dialog, and the note's pushes wait for the answer (remoteEditHolds.ts). `theirs` is the content that arrived (undefined when it could not be
// decrypted), what the dialog's comparison shows against the local edits.
export interface NoteRemoteEdit {
	theirs: string | undefined
}

export interface NotesRemoteEditStore {
	remoteEdited: Record<string, NoteRemoteEdit>
	// The note the editor pane shows, so a reload of it, and of no other, is announced.
	openNote: string | null
	setRemoteEdited: (uuid: string, edit: NoteRemoteEdit) => void
	// The question was answered in this tab: the other tabs are told.
	clearRemoteEdited: (uuid: string) => void
	// The question was answered in another tab, or has nothing left to ask. Kept while this tab's editor
	// holds typing of its own the cloud does not: its question, on screen here, is still open.
	dropRemoteEdited: (uuid: string) => void
	setOpenNote: (uuid: string | null) => void
}

// The outbox channel's "answered" post, wired by outboxCoordinator.ts (none in a single-tab install).
let broadcastAnswered: ((uuid: string) => void) | null = null

export function setNoteAnswerBroadcast(fn: ((uuid: string) => void) | null): void {
	broadcastAnswered = fn
}

export const useNotesRemoteEditStore = create<NotesRemoteEditStore>((set, get) => {
	function drop(uuid: string): void {
		releaseNoteHold(uuid)
		set(state => {
			if (state.remoteEdited[uuid] === undefined) {
				return state
			}

			const next = {
				...state.remoteEdited
			}

			Reflect.deleteProperty(next, uuid)

			return { remoteEdited: next }
		})
	}

	return {
		remoteEdited: {},
		openNote: null,
		setRemoteEdited(uuid, edit) {
			// Held at once for the note on screen, whose dialog is about to show (a push pass may start
			// before it mounts); the dialog holds it from then on, and only while it shows (NoteRemoteEditDialog).
			// A note edited but not on screen is not held: nothing there could answer, and its edits would
			// wait unsent until it was opened again.
			if (get().openNote === uuid) {
				holdNoteForRemoteEdit(uuid)
			}

			set(state => ({ remoteEdited: { ...state.remoteEdited, [uuid]: edit } }))
		},
		clearRemoteEdited(uuid) {
			drop(uuid)
			broadcastAnswered?.(uuid)
		},
		dropRemoteEdited(uuid) {
			if (!tabEditorDirty(uuid)) {
				drop(uuid)
			}
		},
		setOpenNote(uuid) {
			set({ openNote: uuid })
		}
	}
})

// Reactive per-note subscription for the editor's dialog.
export function useNoteRemoteEdit(uuid: string): NoteRemoteEdit | undefined {
	return useNotesRemoteEditStore(state => state.remoteEdited[uuid])
}

export default useNotesRemoteEditStore
