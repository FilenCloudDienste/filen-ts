import { create } from "zustand"
import type { AnswerChoice } from "@/lib/storage/outboxChannel"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight"
import { newestEntry } from "@/features/notes/lib/sync.logic"
import { holdNoteForRemoteEdit, releaseNoteHold } from "@/features/notes/lib/remoteEditHolds"
import { tabEditorDirty } from "@/features/notes/lib/tabEditors"
import { takeRemoteContent } from "@/features/notes/lib/remoteContent"

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
	clearRemoteEdited: (uuid: string, choice: AnswerChoice) => void
	// The question was answered in another tab. Kept while this tab's editor holds typing of its own the
	// cloud does not: its question, on screen here, is still open. Otherwise, for their version (loaded, or
	// kept beside a copy), this tab takes it as for any save elsewhere: the answer may send nothing (theirs
	// already in the cloud), so no echo would bring it. For mine kept, the push of mine brings it. A choice
	// not told (an older tab) is read off the queue: another version queued over theirs is mine kept.
	dropRemoteEdited: (uuid: string, choice?: AnswerChoice) => void
	// The question has nothing left to ask.
	retireRemoteEdited: (uuid: string) => void
	setOpenNote: (uuid: string | null) => void
}

// The outbox channel's "answered" post, wired by outboxCoordinator.ts (none in a single-tab install).
let broadcastAnswered: ((uuid: string, choice: AnswerChoice) => void) | null = null

export function setNoteAnswerBroadcast(fn: ((uuid: string, choice: AnswerChoice) => void) | null): void {
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
		clearRemoteEdited(uuid, choice) {
			drop(uuid)
			broadcastAnswered?.(uuid, choice)
		},
		dropRemoteEdited(uuid, choice) {
			const edit = get().remoteEdited[uuid]

			if (edit === undefined || tabEditorDirty(uuid)) {
				return
			}

			drop(uuid)

			const queued = newestEntry(useNotesInflightStore.getState().inflightContent[uuid] ?? [])
			const mineKept = choice === undefined ? queued !== undefined && queued.content !== edit.theirs : choice === "mine"

			if (!mineKept) {
				takeRemoteContent(uuid, edit.theirs, get().openNote === uuid)
			}
		},
		retireRemoteEdited: drop,
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
