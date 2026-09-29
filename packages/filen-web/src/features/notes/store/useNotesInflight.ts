import { create } from "zustand"
import type { Note } from "@filen/sdk-rs"
import type { InflightEntry as SharedInflightEntry } from "@filen/shared"

// The sync outbox's per-entry shape and in-memory shape live in @filen/shared (mobile's InflightContent
// is the identical generic type instantiated with its own Note), generic over each app's own generated
// Note type: per-note, a time-ordered list of the content the user has typed but not yet confirmed
// synced. Kept as a list (not a single latest value) so the push loop can prune by LOCAL author-time —
// only entries typed DURING a round trip survive a successful push, the ones it actually sent die
// (see sync.ts). `origin` is the id of the tab that queued the entry (Sync's tabId): which push is a tab's
// own. `orphan`: that tab is gone (an earlier page load, a closed leader), so any tab may show and continue
// it. An entry of an older build has no origin and is an orphan too. `carriedFrom`: typed on top of the
// previous entry (this tab's own, or the orphan draft its editor showed), whose base it carries, and that
// entry's origin ("" for none); only such an entry is rebased onto that entry's push when it lands.
export type InflightEntry = SharedInflightEntry<Note> & { origin?: string; orphan?: true; carriedFrom?: string }

// This tab's id, the origin of every entry it queues.
export const TAB_ID: string = crypto.randomUUID()

// Whether this tab's editor may show the entry: its own typing, or an orphan's. Never another live tab's:
// that tab may be throwing it away (a history restore, Load theirs), and a tab that showed it would type on
// text that is no version at all.
export function entryIsShowable(entry: InflightEntry): boolean {
	return entry.origin === undefined || entry.origin === TAB_ID || entry.orphan === true
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
	// The notes a mounted editor has been typed into during this session. Deliberately NOT derivable
	// from inflightContent: the first successful push empties a note's queue, so between a debounce
	// flush and the next keystroke a note the user is still typing into reads as clean — and anything
	// that treats "clean" as "safe to reseed" then tears the live surface down under the caret.
	editingSessions: Record<string, true>
	// Per note, how often the editor on screen was told to seed again (from an outbox entry it may now
	// show), part of its remount key: the content cache may hold nothing to advance.
	editorReseeds: Record<string, number>
}

export const useNotesInflightStore = create<NotesInflightStore>(set => ({
	inflightContent: {},
	setInflightContent(fn) {
		set(state => ({
			inflightContent: typeof fn === "function" ? fn(state.inflightContent) : fn
		}))
	},
	outboxHydrated: false,
	editingSessions: {},
	editorReseeds: {}
}))

// THE "is the user editing this note right now" test, the one that keeps the content query (and so the
// editor's remount key) still — a pending outbox entry OR a live editor session. The queue alone answers a
// narrower question ("is something queued"), which stops being true at every push. Whether an edit made
// elsewhere may reseed the editor is a different question: whether it holds unsynced changes
// (socketHandlers.ts). Only the entries this tab may show count: another live tab's typing is not this
// tab's editing, and must not keep this tab's content from loading. Exported in state form too, for a
// caller that already holds a store snapshot (useNoteSearchBodies).
export function noteIsEditing(state: NotesInflightStore, uuid: string): boolean {
	return (state.inflightContent[uuid] ?? []).some(entryIsShowable) || state.editingSessions[uuid] === true
}

// Reactive subscription to the QUEUE alone — the header spinner and menu suppression, which mean "a
// push is in flight", not "the user is editing" (that is noteIsEditing above). Boolean-collapsed so a
// subscriber re-renders only on the has/has-not EDGE, never on every keystroke that grows the entry
// list.
export function useNoteInflight(uuid: string): boolean {
	return useNotesInflightStore(state => (state.inflightContent[uuid] ?? []).length > 0)
}

// Reactive form of the editing test above. Boolean-collapsed like useNoteInflight, so a subscriber
// re-renders only on the edge.
export function useNoteEditing(uuid: string): boolean {
	return useNotesInflightStore(state => noteIsEditing(state, uuid))
}

// The editor's own markers: the session opens on the first local change and closes when the editor
// unmounts. A deliberate reseed (the remote-edit banner's Reload, a history restore) closes it too —
// those WANT the content query re-enabled so their invalidation lands. begin returns the OPENING edge:
// true only on the call that actually opened the session, false while one is already open — the
// caller's signal for once-per-session work (useNoteEditor's in-flight cancel).
export function beginEditingSession(uuid: string): boolean {
	const { editingSessions } = useNotesInflightStore.getState()

	if (editingSessions[uuid] === true) {
		return false
	}

	useNotesInflightStore.setState({ editingSessions: { ...editingSessions, [uuid]: true } })

	return true
}

export function endEditingSession(uuid: string): void {
	useNotesInflightStore.setState(state => {
		if (state.editingSessions[uuid] !== true) {
			return state
		}

		const next = { ...state.editingSessions }

		Reflect.deleteProperty(next, uuid)

		return { editingSessions: next }
	})
}

export function reseedEditor(uuid: string): void {
	useNotesInflightStore.setState(state => ({
		editorReseeds: { ...state.editorReseeds, [uuid]: (state.editorReseeds[uuid] ?? 0) + 1 }
	}))
}

// The editor left the note: its count goes with it.
export function forgetEditorReseeds(uuid: string): void {
	useNotesInflightStore.setState(state => {
		if (state.editorReseeds[uuid] === undefined) {
			return state
		}

		const next = { ...state.editorReseeds }

		Reflect.deleteProperty(next, uuid)

		return { editorReseeds: next }
	})
}

export function useEditorReseeds(uuid: string): number {
	return useNotesInflightStore(state => state.editorReseeds[uuid] ?? 0)
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
	useNotesInflightStore.setState({ outboxHydrated: hydrated })
}

export default useNotesInflightStore
