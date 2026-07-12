import { noteTitleMatchesSearch } from "@/features/notes/lib/sort"
import type { Note } from "@filen/sdk-rs"

// Pure bits pulled out of useNoteSearchBodies.ts so the fetch-scoping decision is table-testable
// without React Query or a worker.

// Which notes actually need their body fetched for full-text search: a title hit already
// qualifies the note (filterNotesBySearch checks title first), so fetching its body too would be pure
// waste — this is the whole point of keeping the full-body fetch efficient and opt-in, not just gating on `searching`.
// Returns every note, unfiltered, for a blank query (the hook itself is what skips fetching then, by
// passing an empty candidate list into useQueries).
export function noteSearchBodyCandidates(notes: readonly Note[], search: string): Note[] {
	const normalized = search.trim().toLowerCase()

	if (normalized.length === 0) {
		return []
	}

	return notes.filter(note => !noteTitleMatchesSearch(note, normalized))
}

// Zips the candidate notes back up with their fetched bodies (react-query's useQueries result array is
// positionally parallel to the queries it was given) into the uuid-keyed map filterNotesBySearch reads.
export function buildNoteBodiesMap(candidates: readonly Note[], bodies: readonly (string | undefined)[]): Map<string, string | undefined> {
	const map = new Map<string, string | undefined>()

	candidates.forEach((note, index) => {
		map.set(note.uuid, bodies[index])
	})

	return map
}
