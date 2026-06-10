import { create } from "zustand"

export type InflightContent = Record<
	string,
	{
		timestamp: number
		content: string
		note: import("@/types").Note
		// D3: hash (sync.tsx `hashNoteContent`) of the synced/loaded content this editing
		// session was BASED on — NOT the typed text. The push loop compares it against the
		// note's current cloud content to detect (never prevent — local edits always win)
		// that a push buried newer remote work. OPTIONAL because the queue is persisted to
		// SQLite: entries written by older app versions have no hash and push WITHOUT the
		// conflict check (a one-time grace instead of migration machinery).
		baseContentHash?: string
	}[]
>

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
