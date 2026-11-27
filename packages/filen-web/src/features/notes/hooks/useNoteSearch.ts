import { useEffect, useState, useSyncExternalStore } from "react"
import type { Note } from "@filen/sdk-rs"
import { normalizeSearch } from "@/features/notes/lib/sort"
import { useIsOnline } from "@/lib/useIsOnline"
import { NoteSearchSession, noteSearchIndex, type NoteSearchState } from "@/features/notes/lib/searchIndex"

// Full-text search over the notes' bodies through the on-device index (searchIndex.ts). A blank search reads
// nothing; a search reads only the title misses whose indexed text is missing or older than the list, and results
// stream in as those land. Offline, the stale ones count as unsearched instead of waiting on a read.
export function useNoteSearch(notes: readonly Note[], search: string): NoteSearchState {
	const [session] = useState(() => new NoteSearchSession(noteSearchIndex))
	const key = normalizeSearch(search)
	const online = useIsOnline()

	useEffect(() => {
		session.update(notes, key, online)
	}, [session, notes, key, online])

	useEffect(
		() => () => {
			session.stop()
		},
		[session]
	)

	return useSyncExternalStore(session.subscribe, session.getState)
}
