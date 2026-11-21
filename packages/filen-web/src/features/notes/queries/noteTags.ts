import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { patchQuery, replaceOrAppend } from "@/queries/patch"
import type { NoteTag } from "@filen/sdk-rs"
import { compareTagsByName } from "@/features/notes/lib/sort"

// One global tag list, mirroring NOTES_QUERY_KEY — exactly one tags cache per session, same
// rationale as CONTACTS_QUERY_KEY. Held in compareTagsByName order (every read and patch sorts it), so the
// tag submenus render it as is and never follow the server's order.
export const NOTE_TAGS_QUERY_KEY = ["notes", "tags"] as const

export async function fetchNoteTags(): Promise<NoteTag[]> {
	return (await sdkApi.listNoteTags()).sort(compareTagsByName)
}

export function useNoteTags(): UseQueryResult<NoteTag[]> {
	return useQuery({
		queryKey: NOTE_TAGS_QUERY_KEY,
		queryFn: fetchNoteTags
	})
}

export function noteTagsQueryUpdate(updater: (prev: NoteTag[]) => NoteTag[]): void {
	patchQuery<NoteTag[]>(NOTE_TAGS_QUERY_KEY, prev => {
		const base = prev ?? []
		const next = updater(base)

		// An updater that changed nothing hands back the cached array, already in order: never sort it in place.
		return next === base ? next : next.sort(compareTagsByName)
	})
}

export function noteTagsQueryUpsert(tag: NoteTag): void {
	noteTagsQueryUpdate(prev => replaceOrAppend(prev, tag, t => t.uuid === tag.uuid))
}

export function noteTagsQueryRemove(uuid: string): void {
	noteTagsQueryUpdate(prev => prev.filter(t => t.uuid !== uuid))
}

export function noteTagsQueryGet(): NoteTag[] | undefined {
	return queryClient.getQueryData<NoteTag[]>(NOTE_TAGS_QUERY_KEY)
}
