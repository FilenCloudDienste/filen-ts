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
}

export const useNotesInflightStore = create<NotesInflightStore>(set => ({
	inflightContent: {},
	setInflightContent(fn) {
		set(state => ({
			inflightContent: typeof fn === "function" ? fn(state.inflightContent) : fn
		}))
	},
	outboxHydrated: false,
	setOutboxHydrated(hydrated) {
		set({ outboxHydrated: hydrated })
	}
}))

// Reactive subscription for the editor — the header spinner + menu suppression + the content
// query's `enabled` gate all rerun off whether a note has pending outbox entries. Boolean-collapsed
// so a subscriber re-renders only on the has/has-not EDGE, never on every keystroke that grows the
// entry list.
export function useNoteInflight(uuid: string): boolean {
	return useNotesInflightStore(state => (state.inflightContent[uuid] ?? []).length > 0)
}

// Non-reactive read off the store singleton for sync-internal callers that must not subscribe.
export function hasInflight(uuid: string): boolean {
	return (useNotesInflightStore.getState().inflightContent[uuid] ?? []).length > 0
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
