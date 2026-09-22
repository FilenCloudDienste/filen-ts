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

export default useNotesInflightStore
