import { create } from "zustand"
import type { Note } from "@filen/sdk-rs"

// The sync outbox's in-memory shape, identical to filen-mobile's InflightContent: per-note, a
// time-ordered list of the content the user has typed but not yet confirmed synced. Kept as a list
// (not a single latest value) so the push loop can prune by LOCAL author-time — only entries typed
// DURING a round trip survive a successful push, the ones it actually sent die (see sync.ts).
export interface InflightEntry {
	// LOCAL author-time (Date.now()), made per-note MONOTONIC by buildInflightEntries so an NTP
	// backstep can never leave a stale entry outranking freshly typed text. Never compared against
	// the server's editedTimestamp — different clocks in the same unit.
	timestamp: number
	content: string
	// A full Note SNAPSHOT captured at edit time. Round-trips through the $bigint envelope on the
	// durable outbox; the push loop prefers the LIVE note from the list cache and only falls back to
	// this snapshot when the note has left the cache (concurrently deleted).
	note: Note
	// Hash (hashNoteContent) of the synced/loaded content this editing session was BASED on — NOT
	// the typed text. Compared against the note's current cloud content to DETECT (never prevent —
	// local edits always win) that a push buried newer remote work. OPTIONAL because the queue is
	// persisted: entries written by an older app version carry no hash and push WITHOUT the conflict
	// check (a one-time grace, not migration machinery).
	baseContentHash?: string
}

export type InflightContent = Record<string, InflightEntry[]>

export interface NotesInflightStore {
	inflightContent: InflightContent
	setInflightContent: (fn: InflightContent | ((prev: InflightContent) => InflightContent)) => void
	// False until this tab's outbox has loaded whatever pending edits it owns — the leader from disk,
	// a follower from the leader's first state broadcast (sync.ts). Until it flips, an EMPTY store means
	// "not known yet", not "clean": an editor that froze its seed here would paint the server's pre-edit
	// content over a queued local edit, and the next keystroke would push that stale text back over it.
	outboxHydrated: boolean
	setOutboxHydrated: (hydrated: boolean) => void
	// The notes a mounted editor has been typed into during this session. Deliberately NOT derivable
	// from inflightContent: the first successful push empties a note's queue, so between a debounce
	// flush and the next keystroke a note the user is still typing into reads as clean — and anything
	// that treats "clean" as "safe to reseed" then tears the live surface down under the caret.
	editingSessions: Record<string, true>
	// Returns the OPENING edge: true only on the call that actually opened the session, false while one
	// is already open — the caller's signal for once-per-session work (useNoteEditor's in-flight cancel).
	beginEditingSession: (uuid: string) => boolean
	endEditingSession: (uuid: string) => void
}

export const useNotesInflightStore = create<NotesInflightStore>((set, get) => ({
	inflightContent: {},
	setInflightContent(fn) {
		set(state => ({
			inflightContent: typeof fn === "function" ? fn(state.inflightContent) : fn
		}))
	},
	outboxHydrated: false,
	setOutboxHydrated(hydrated) {
		set({ outboxHydrated: hydrated })
	},
	editingSessions: {},
	beginEditingSession(uuid) {
		const { editingSessions } = get()

		if (editingSessions[uuid] === true) {
			return false
		}

		set({
			editingSessions: {
				...editingSessions,
				[uuid]: true
			}
		})

		return true
	},
	endEditingSession(uuid) {
		set(state => {
			if (state.editingSessions[uuid] !== true) {
				return state
			}

			const next = {
				...state.editingSessions
			}

			Reflect.deleteProperty(next, uuid)

			return {
				editingSessions: next
			}
		})
	}
}))

// THE "is the user editing this note right now" test, and the one every reseed decision must ask —
// a pending outbox entry OR a live editor session. The queue alone answers a narrower question ("is
// something queued"), which stops being true at every push. Exported in state form too, for a
// caller that already holds a store snapshot (useNoteSearchBodies).
export function noteIsEditing(state: NotesInflightStore, uuid: string): boolean {
	return (state.inflightContent[uuid] ?? []).length > 0 || state.editingSessions[uuid] === true
}

// Reactive subscription to the QUEUE alone — the header spinner and menu suppression, which mean "a
// push is in flight", not "the user is editing" (that is noteIsEditing above). Boolean-collapsed so a
// subscriber re-renders only on the has/has-not EDGE, never on every keystroke that grows the entry
// list.
export function useNoteInflight(uuid: string): boolean {
	return useNotesInflightStore(state => (state.inflightContent[uuid] ?? []).length > 0)
}

// Reactive/non-reactive halves of the editing test above. Boolean-collapsed like useNoteInflight, so a
// subscriber re-renders only on the edge.
export function useNoteEditing(uuid: string): boolean {
	return useNotesInflightStore(state => noteIsEditing(state, uuid))
}

export function isNoteEditing(uuid: string): boolean {
	return noteIsEditing(useNotesInflightStore.getState(), uuid)
}

// The editor's own markers: the session opens on the first local change and closes when the editor
// unmounts. A deliberate reseed (the remote-edit banner's Reload, a history restore) closes it too —
// those WANT the content query re-enabled so their invalidation lands. begin returns the opening edge.
export function beginEditingSession(uuid: string): boolean {
	return useNotesInflightStore.getState().beginEditingSession(uuid)
}

export function endEditingSession(uuid: string): void {
	useNotesInflightStore.getState().endEditingSession(uuid)
}

// Teardown counterpart to setOutboxHydrated(false) (sync.cancel, before the logout wipe): no note
// belongs to an editing session any more, and a session left behind would keep its content query
// gated for the NEXT account.
export function clearEditingSessions(): void {
	useNotesInflightStore.setState({ editingSessions: {} })
}

// Reactive subscription to the hydration edge — the editor holds its loading state until it flips, so
// no seed is ever frozen from an outbox that has not spoken yet (useNoteEditor).
export function useOutboxHydrated(): boolean {
	return useNotesInflightStore(state => state.outboxHydrated)
}

// The outbox's own marker (sync.ts, outboxCoordinator.ts). Idempotent.
export function setOutboxHydrated(hydrated: boolean): void {
	useNotesInflightStore.getState().setOutboxHydrated(hydrated)
}

export default useNotesInflightStore
