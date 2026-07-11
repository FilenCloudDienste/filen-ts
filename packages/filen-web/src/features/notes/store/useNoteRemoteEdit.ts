import { create } from "zustand"

// Per-note "the server's content moved while you have unsynced local edits" flag, set by the realtime
// ContentEdited handler ONLY when the note is dirty (has an outbox entry) — a clean note refetches
// silently instead. Surfaced as the editor's non-blocking reload-vs-keep banner. A plain presence set:
// the value carries no payload, only whether a prompt is pending for that uuid.
export interface NotesRemoteEditStore {
	remoteEdited: Record<string, true>
	setRemoteEdited: (uuid: string) => void
	clearRemoteEdited: (uuid: string) => void
}

export const useNotesRemoteEditStore = create<NotesRemoteEditStore>(set => ({
	remoteEdited: {},
	setRemoteEdited(uuid) {
		set(state => (state.remoteEdited[uuid] === true ? state : { remoteEdited: { ...state.remoteEdited, [uuid]: true } }))
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
	}
}))

// Reactive per-note subscription for the editor banner — re-renders only on this uuid's has/has-not edge.
export function useNoteRemoteEdited(uuid: string): boolean {
	return useNotesRemoteEditStore(state => state.remoteEdited[uuid] === true)
}

export default useNotesRemoteEditStore
