import { create } from "zustand"

/**
 * Reactive projection of the durable offline-notes ledger (`features/notes/notesOffline`).
 *
 * The ledger itself lives in the SQLite kv so a headless background run can read it without any
 * component having mounted; this store exists purely so rows and menus can subscribe to a single
 * note's marked state without an async read per render. `notesOffline` is its ONLY writer and keeps
 * the two in step — never write here from UI.
 */
export type NotesOfflineStore = {
	// uuid → true for every note the user marked available offline. A plain record (not a Set) so
	// per-row selectors compare a boolean and re-render only when THAT note's state flips.
	marked: Record<string, true>
	setMarked: (fn: Record<string, true> | ((prev: Record<string, true>) => Record<string, true>)) => void
	/**
	 * uuid → number of mounted note-content views for that note.
	 *
	 * A COUNT, not a boolean: opening a note's history pushes a second content view for the same
	 * note on top of the first, and the editor underneath stays mounted throughout.
	 *
	 * This is the authoritative "is there a live editor for this note" signal. The route pathname is
	 * not: pushing /noteHistory or /noteParticipants from the note's own header leaves the editor
	 * mounted (react-freeze freezes it, it does not unmount), so a pathname test would report the
	 * editor closed while it is very much alive and about to be repainted.
	 */
	openContentViews: Record<string, number>
	openContentView: (uuid: string) => void
	closeContentView: (uuid: string) => void
}

export const useNotesOfflineStore = create<NotesOfflineStore>(set => ({
	marked: {},
	setMarked(fn) {
		set(state => ({
			marked: typeof fn === "function" ? fn(state.marked) : fn
		}))
	},
	openContentViews: {},
	openContentView(uuid) {
		set(state => ({
			openContentViews: {
				...state.openContentViews,
				[uuid]: (state.openContentViews[uuid] ?? 0) + 1
			}
		}))
	},
	closeContentView(uuid) {
		set(state => {
			const next = (state.openContentViews[uuid] ?? 0) - 1
			const openContentViews = {
				...state.openContentViews
			}

			if (next > 0) {
				openContentViews[uuid] = next
			} else {
				delete openContentViews[uuid]
			}

			return {
				openContentViews
			}
		})
	}
}))

export default useNotesOfflineStore
