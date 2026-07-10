import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
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

// Cancel-before-patch WITH the initial-fetch carve-out (driveListingQueryUpdate's own rule, queries/
// drive.ts): a refetch snapshotted on the server BEFORE this write would land after the patch and
// silently overwrite it — abort anything in flight first, but only when cached data already exists.
// Cancelling a query's INITIAL fetch would strand it on its loading state with nothing to show until
// the next mount/focus trigger, and the overwrite hazard only applies to data a patch can lose.
function cancelInFlightIfCached(): void {
	if (queryClient.getQueryData(NOTES_QUERY_KEY) !== undefined) {
		void queryClient.cancelQueries({ queryKey: NOTES_QUERY_KEY })
	}
}

// Confirm-then-patch (queries/client.ts's zero-useMutation convention). A cache miss (nobody has
// mounted the notes list yet) defaults to [] so the patch still lands for whenever it first mounts,
// same rule as driveListingQueryUpdate.
export function notesQueryUpdate(updater: (prev: Note[]) => Note[]): void {
	cancelInFlightIfCached()
	queryClient.setQueryData<Note[]>(NOTES_QUERY_KEY, prev => updater(prev ?? []))
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

export function notesQueryReplaceAll(notes: Note[]): void {
	notesQueryUpdate(() => notes)
}

// Synchronous cache read for a caller that needs the current note list without subscribing via the
// hook — mirrors contactsQueryGet's own rationale (a menu/action call site resolving a note's live
// row, e.g. after a socket event, without mounting a new observer).
export function notesQueryGet(): Note[] | undefined {
	return queryClient.getQueryData<Note[]>(NOTES_QUERY_KEY)
}
