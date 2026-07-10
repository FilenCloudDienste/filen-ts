import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import type { NoteTag } from "@filen/sdk-rs"

// One global tag list, mirroring NOTES_QUERY_KEY — exactly one tags cache per session, same
// rationale as CONTACTS_QUERY_KEY.
export const NOTE_TAGS_QUERY_KEY = ["notes", "tags"] as const

export async function fetchNoteTags(): Promise<NoteTag[]> {
	return sdkApi.listNoteTags()
}

export function useNoteTags(): UseQueryResult<NoteTag[]> {
	return useQuery({
		queryKey: NOTE_TAGS_QUERY_KEY,
		queryFn: fetchNoteTags
	})
}

// Cancel-before-patch WITH the initial-fetch carve-out, same rule as notes.ts's
// cancelInFlightIfCached.
function cancelInFlightIfCached(): void {
	if (queryClient.getQueryData(NOTE_TAGS_QUERY_KEY) !== undefined) {
		void queryClient.cancelQueries({ queryKey: NOTE_TAGS_QUERY_KEY })
	}
}

export function noteTagsQueryUpdate(updater: (prev: NoteTag[]) => NoteTag[]): void {
	cancelInFlightIfCached()
	queryClient.setQueryData<NoteTag[]>(NOTE_TAGS_QUERY_KEY, prev => updater(prev ?? []))
}

export function noteTagsQueryUpsert(tag: NoteTag): void {
	noteTagsQueryUpdate(prev => {
		const index = prev.findIndex(t => t.uuid === tag.uuid)

		if (index === -1) {
			return [...prev, tag]
		}

		const next = prev.slice()
		next[index] = tag
		return next
	})
}

export function noteTagsQueryRemove(uuid: string): void {
	noteTagsQueryUpdate(prev => prev.filter(t => t.uuid !== uuid))
}

export function noteTagsQueryGet(): NoteTag[] | undefined {
	return queryClient.getQueryData<NoteTag[]>(NOTE_TAGS_QUERY_KEY)
}
