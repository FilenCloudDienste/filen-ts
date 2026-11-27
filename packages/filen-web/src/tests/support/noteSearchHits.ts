import type { NoteSearchHits } from "@/features/notes/lib/searchIndex.logic"

// A search's index view for the filter tests: `matched` in rank order (all indexed), plus `indexed` notes the index
// holds text for that did not match.
export function noteSearchHits(matched: readonly string[], indexed: readonly string[] = []): NoteSearchHits {
	return {
		body: new Map(matched.map((uuid, rank) => [uuid, { rank, snippet: "" }])),
		indexed: new Set([...matched, ...indexed])
	}
}
