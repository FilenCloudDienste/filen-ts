import { useQueries, type QueryObserverResult } from "@tanstack/react-query"
import { useShallow } from "zustand/shallow"
import type { Note } from "@filen/sdk-rs"
import { nameSearchKey } from "@filen/shared"
import { fetchTrackedNoteContent, noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { useNotesInflightStore, noteIsEditing } from "@/features/notes/store/useNotesInflight"
import { noteSearchBodyCandidates, buildNoteBodiesMap } from "@/features/notes/hooks/useNoteSearchBodies.logic"

// A stable module-level select (nameSearchKey): react-query then memoizes it per observer, folding each
// body once per search instead of on every filter pass. The fold is the search key's own (lowercased, NFC
// when non-ASCII), so a decomposed body matches a composed query. The editor's own observer has no select,
// so the cache keeps the raw content.

export interface NoteSearchBodies {
	// Bodies folded by nameSearchKey, keyed by note uuid, the form filterNotesBySearch expects; undefined = not read.
	bodies: ReadonlyMap<string, string | undefined>
	// Candidate bodies still being read: a search with no rows may yet match one of them.
	pending: number
	// Candidate bodies that were not searched: the read failed, or it is paused (offline) and would never
	// land on its own, so it must not count as loading.
	failed: number
}

// What a search with no rows tells the user: still reading bodies, some bodies could not be searched,
// or a real "no results".
export type NoteSearchEmptyState = "searching" | "unsearched" | "empty"

export function noteSearchEmptyState({ pending, failed }: Pick<NoteSearchBodies, "pending" | "failed">): NoteSearchEmptyState {
	if (pending > 0) {
		return "searching"
	}

	return failed > 0 ? "unsearched" : "empty"
}

// A result with data was searched (a later failed refetch keeps its data); one without data is either
// fetching or, when errored or paused, unsearched.
function combineBodies(results: QueryObserverResult<string>[]): { data: (string | undefined)[]; pending: number; failed: number } {
	const data: (string | undefined)[] = []
	let pending = 0
	let failed = 0

	for (const result of results) {
		data.push(result.data)

		if (result.data !== undefined) {
			continue
		}

		if (result.fetchStatus === "fetching") {
			pending++
		} else {
			failed++
		}
	}

	return { data, pending, failed }
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
// Bodies come back FOLDED by nameSearchKey, the form filterNotesBySearch expects.
export function useNoteSearchBodies(notes: readonly Note[], search: string): NoteSearchBodies {
	// Shallow-compared slice, not the whole store: `inflightContent` changes identity on every keystroke,
	// but this only changes when a candidate's editing edge flips (and is a stable [] with no search).
	const searchCandidates = noteSearchBodyCandidates(notes, search)
	const candidates = useNotesInflightStore(useShallow(state => searchCandidates.filter(note => !noteIsEditing(state, note.uuid))))

	const { data, pending, failed } = useQueries({
		queries: candidates.map(note => ({
			queryKey: noteContentQueryKey(note.uuid),
			queryFn: () => fetchTrackedNoteContent(note),
			staleTime: Infinity,
			select: nameSearchKey
		})),
		combine: combineBodies
	})

	return { bodies: buildNoteBodiesMap(candidates, data), pending, failed }
}
