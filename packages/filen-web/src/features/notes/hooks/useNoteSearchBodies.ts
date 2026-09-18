import { useQueries } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"
import { fetchNoteContentOrThrow, noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { noteIsEditing } from "@/features/notes/store/useNotesInflight"
import { noteSearchBodyCandidates, buildNoteBodiesMap } from "@/features/notes/hooks/useNoteSearchBodies.logic"

// Eager, OPT-IN full-body fetch for notes search: title-matching notes never need their body
// fetched at all (noteSearchBodyCandidates' own doc comment), and the whole set stays empty — no
// queries, no fetches — the instant the search box is blank, so this never runs a single extra request
// outside an active search. Reuses the EXACT SAME query key/fetcher the note editor's own
// useNoteContentQuery (noteContent.ts) reads, so a note opened right after a search that matched its
// body is a cache hit, not a second fetch — and, going the other way, a note already open in the editor
// (its content already cached) never re-fetches here either.
//
// Excludes any note the user is EDITING — a pending outbox entry or an open editor session: firing a
// fresh read into that SAME cache key mid-edit would advance `dataUpdatedAt` behind the editor's back
// and violate useNoteContentQuery's own documented invariant (its usage note: `dataUpdatedAt` must not
// advance mid-edit, or the editor remounts and blows away in-progress keystrokes). The outbox entry
// alone is not that test — a push empties it while the user keeps typing. An edited note simply falls
// back to its `preview` snippet for the duration — see filterNotesBySearch's own fallback.
export function useNoteSearchBodies(notes: readonly Note[], search: string): ReadonlyMap<string, string | undefined> {
	// The whole store, not one slice: the editing test spans both `inflightContent` and `editingSessions`,
	// and the former already changes identity on every keystroke.
	const editState = useNotesInflightStore()
	const candidates = noteSearchBodyCandidates(notes, search).filter(note => !noteIsEditing(editState, note.uuid))

	const bodies = useQueries({
		queries: candidates.map(note => ({
			queryKey: noteContentQueryKey(note.uuid),
			queryFn: () => fetchNoteContentOrThrow(note),
			staleTime: Infinity
		})),
		combine: results => results.map(result => result.data)
	})

	return buildNoteBodiesMap(candidates, bodies)
}
