import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { cachedQuery, patchQuery } from "@/queries/patch"
import type { Note } from "@filen/sdk-rs"

// One global list query, mirroring mobile's useNotesWithContent.query.ts — every variant (all
// notes / tags view / a single tag's notes) derives from this one cache slice client-side (see
// features/notes/lib/sort.ts), same rationale as CONTACTS_QUERY_KEY: exactly one notes list per
// session, no per-filter key.
export const NOTES_QUERY_KEY = ["notes", "list"] as const

// Plain, testable query function — same rationale as fetchContacts/fetchDirectoryListing: the hook
// wrapper below is a one-line pass-through no node-environment test can render (no DOM — see
// vitest.config.ts), so this is exported and unit-tested against a mocked sdkApi instead.
export async function fetchNotes(): Promise<Note[]> {
	return sdkApi.listNotes()
}

export function useNotes(): UseQueryResult<Note[]> {
	return useQuery({
		queryKey: NOTES_QUERY_KEY,
		queryFn: fetchNotes
	})
}

// Refetches only a mounted list: an unmounted one is stale anyway (staleTime 0) and reads on its next
// mount. A read in flight is replaced unless `cancelRefetch` is false, for a caller that knows it began
// late enough to join.
function refetchNotes(cancelRefetch = true): void {
	void queryClient.invalidateQueries({ queryKey: NOTES_QUERY_KEY, exact: true }, { cancelRefetch })
}

// A cache miss (nobody has mounted the notes list yet) defaults to [] so the patch still lands for
// whenever it first mounts. A read the patch cancels runs again after it (patchQuery): left at that, the
// list would sit on the patch until the next focus, missing whatever the aborted read was for (the mount
// read of a list a socket patch seeded, the row of a note created elsewhere).
export function notesQueryUpdate(updater: (prev: Note[]) => Note[]): void {
	patchQuery<Note[]>(NOTES_QUERY_KEY, prev => updater(prev ?? []))
}

// A list read that starts after a change the cache cannot be patched with: the row of a note created
// elsewhere (its event carries no Note), or a write this tab applies no patch for (an echo of its own
// account's edit). `onlyIfFetching` limits it to replacing a read already in flight, which may have
// been snapshotted before the change. A list never read needs nothing: its first mount reads fresher.
// An initial fetch in flight would only be joined by a refetch, so the read follows it instead, and
// every change queued meanwhile shares that one read.
export function notesQueryRefetch(options?: { onlyIfFetching?: boolean }): void {
	const query = cachedQuery<Note[]>(NOTES_QUERY_KEY)

	if (query === undefined) {
		return
	}

	const fetching = query.state.fetchStatus !== "idle"

	if (options?.onlyIfFetching === true && !fetching) {
		return
	}

	if (query.state.data !== undefined) {
		refetchNotes()

		return
	}

	if (fetching) {
		// A rejection is a failed fetch (the query retries on its own triggers) or one replaced by a read
		// that began after this call.
		query.promise?.then(
			() => {
				refetchNotes(false)
			},
			() => undefined
		)
	}
}

// Replaces (or inserts) a single note by uuid, preserving every other row's position — the common
// shape for a mutation that returns the one Note it touched (pin/favorite/archive/trash/restore/
// rename/setType), plus create/duplicate's append case.
export function notesQueryUpsert(note: Note): void {
	notesQueryUpdate(prev => {
		const index = prev.findIndex(n => n.uuid === note.uuid)

		if (index === -1) {
			return [...prev, note]
		}

		const next = prev.slice()
		next[index] = note
		return next
	})
}

export function notesQueryRemove(uuid: string): void {
	notesQueryUpdate(prev => prev.filter(n => n.uuid !== uuid))
}

// Synchronous cache read for a caller that needs the current note list without subscribing via the
// hook — mirrors contactsQueryGet's own rationale (a menu/action call site resolving a note's live
// row, e.g. after a socket event, without mounting a new observer).
export function notesQueryGet(): Note[] | undefined {
	return queryClient.getQueryData<Note[]>(NOTES_QUERY_KEY)
}
