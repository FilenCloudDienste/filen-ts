import { useQueries } from "@tanstack/react-query"
import { useShallow } from "zustand/shallow"
import type { Note } from "@filen/sdk-rs"
import { fetchTrackedNoteContent, noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { useNotesInflightStore, noteIsEditing } from "@/features/notes/store/useNotesInflight"
import { noteSearchBodyCandidates, buildNoteBodiesMap } from "@/features/notes/hooks/useNoteSearchBodies.logic"

// Module-level so the select reference is stable: react-query then memoizes it per observer, lowering
// each body once per search instead of on every filter pass. The editor's own observer has no select, so
// the cache keeps the raw content.
function lowerCaseBody(content: string): string {
	return content.toLowerCase()
}

// Eager, OPT-IN full-body fetch for notes search: title-matching notes never need their body
// fetched at all (noteSearchBodyCandidates' own doc comment), and the whole set stays empty — no
// queries, no fetches — the instant the search box is blank, so this never runs a single extra request
// outside an active search. Reuses the EXACT SAME query key/fetcher the note editor's own
// useNoteContentQuery (noteContent.ts) reads, tracked the same way, so a note opened right after a
// search that matched its body is a cache hit, not a second fetch — and, going the other way, a note
// already open in the editor (its content already cached) never re-fetches here either.
//
// Excludes any note the user is EDITING — a pending outbox entry or an open editor session: firing a
// fresh read into that SAME cache key mid-edit would advance `dataUpdatedAt` behind the editor's back
// and violate useNoteContentQuery's own documented invariant (its usage note: `dataUpdatedAt` must not
// advance mid-edit, or the editor remounts and blows away in-progress keystrokes). The outbox entry
// alone is not that test — a push empties it while the user keeps typing. An edited note simply falls
// back to its `preview` snippet for the duration — see filterNotesBySearch's own fallback.
//
// Bodies come back LOWERCASED (lowerCaseBody), the form filterNotesBySearch expects.
export function useNoteSearchBodies(notes: readonly Note[], search: string): ReadonlyMap<string, string | undefined> {
	// Shallow-compared slice, not the whole store: `inflightContent` changes identity on every keystroke,
	// but this only changes when a candidate's editing edge flips (and is a stable [] with no search).
	const searchCandidates = noteSearchBodyCandidates(notes, search)
	const candidates = useNotesInflightStore(useShallow(state => searchCandidates.filter(note => !noteIsEditing(state, note.uuid))))

	const bodies = useQueries({
		queries: candidates.map(note => ({
			queryKey: noteContentQueryKey(note.uuid),
			queryFn: () => fetchTrackedNoteContent(note),
			staleTime: Infinity,
			select: lowerCaseBody
		})),
		combine: results => results.map(result => result.data)
	})

	return buildNoteBodiesMap(candidates, bodies)
}
