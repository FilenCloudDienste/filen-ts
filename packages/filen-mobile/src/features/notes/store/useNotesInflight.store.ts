import { create } from "zustand"
import { type InflightContent as SharedInflightContent } from "@filen/shared"
import { type Note } from "@/types"

/**
 * SQLite kv row the inflight queue is persisted under. Declared here rather than on the Sync class so
 * a headless reader can consult the queue without importing components/sync (which never starts in a
 * background run, and drags the whole notes lib in with it).
 */
export const INFLIGHT_CONTENT_SQLITE_KV_KEY = "inflightNoteContent"

// The per-entry shape (timestamp/content/note/baseContentHash?) lives in @filen/shared, generic over
// this app's own generated Note type.
export type InflightContent = SharedInflightContent<Note>

export type NotesInflightStore = {
	inflightContent: InflightContent
	setInflightContent: (fn: InflightContent | ((prev: InflightContent) => InflightContent)) => void
}

export const useNotesInflightStore = create<NotesInflightStore>(set => ({
	inflightContent: {},
	setInflightContent(fn) {
		set(state => ({
			inflightContent: typeof fn === "function" ? fn(state.inflightContent) : fn
		}))
	}
}))

// Whether the note has unsynced edits.
export function hasInflightEntries(inflight: InflightContent, uuid: string): boolean {
	return (inflight[uuid] ?? []).length > 0
}

// The entry with the greatest timestamp, first of ties.
export function newestInflightEntry(entries: InflightContent[string] | undefined): InflightContent[string][number] | undefined {
	return (entries ?? []).reduce<InflightContent[string][number] | undefined>(
		(latest, entry) => (latest === undefined || entry.timestamp > latest.timestamp ? entry : latest),
		undefined
	)
}

export function useNoteHasInflight(uuid: string): boolean {
	return useNotesInflightStore(state => hasInflightEntries(state.inflightContent, uuid))
}

export default useNotesInflightStore
