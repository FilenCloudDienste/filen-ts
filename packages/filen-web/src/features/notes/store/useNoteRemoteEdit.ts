import { create } from "zustand"

// Per note, "the server's content moved while you are editing it", set by the realtime ContentEdited
// handler ONLY while the note is being edited — a note not being edited reloads instead. Surfaced as the
// editor's remote-change dialog. `theirs` is the content that arrived (undefined when it could not be
// decrypted), what the dialog's comparison shows against the local edits.
export interface NoteRemoteEdit {
	theirs: string | undefined
}

export interface NotesRemoteEditStore {
	remoteEdited: Record<string, NoteRemoteEdit>
	// The note the editor pane shows, so a reload of it, and of no other, is announced.
	openNote: string | null
	setRemoteEdited: (uuid: string, edit: NoteRemoteEdit) => void
	clearRemoteEdited: (uuid: string) => void
	setOpenNote: (uuid: string | null) => void
}

export const useNotesRemoteEditStore = create<NotesRemoteEditStore>(set => ({
	remoteEdited: {},
	openNote: null,
	setRemoteEdited(uuid, edit) {
		set(state => ({ remoteEdited: { ...state.remoteEdited, [uuid]: edit } }))
	},
	clearRemoteEdited(uuid) {
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
	},
	setOpenNote(uuid) {
		set({ openNote: uuid })
	}
}))

// Reactive per-note subscription for the editor's dialog.
export function useNoteRemoteEdit(uuid: string): NoteRemoteEdit | undefined {
	return useNotesRemoteEditStore(state => state.remoteEdited[uuid])
}

export default useNotesRemoteEditStore
