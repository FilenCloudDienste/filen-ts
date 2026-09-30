import { type UseQueryOptions } from "@tanstack/react-query"
import { type QueryUpdater } from "@/queries/client"
import { createFixedKeyQuery } from "@/queries/createFixedKeyQuery"
import { socketCoveredRefetchOnMount } from "@/queries/socketSession"
import auth from "@/lib/auth"
import { type Note } from "@/types"
import { toSignalOpts } from "@/lib/signals"
import { wrapSdkNote } from "@/features/notes/utils"

export const BASE_QUERY_KEY = "useNotesQuery"

// A secondary notes screen (tag drill-down, Manage Tags) mounting over a listing this device read from
// the server within the window shows it instead of re-reading. Past the window it re-reads as before:
// pins, favorites, trash state and tags changed on another device carry no socket event.
export const NOTES_REUSE_WINDOW_MS = 60 * 1000

// Only a read of this query counts, not a bare fetchData whose listing never reaches the cache (the
// offline pass, the boot reconcile), and only one from the current socket session: events missed while
// backgrounded or disconnected are not in it.
export const reuseRecentNotesRead = {
	refetchOnMount: socketCoveredRefetchOnMount(NOTES_REUSE_WINDOW_MS)
} satisfies Omit<UseQueryOptions, "queryKey" | "queryFn">

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const all = await authedSdkClient.listNotes(
		toSignalOpts(params?.signal)
	)

	return all.map(wrapSdkNote)
}

const notesQuery = createFixedKeyQuery({
	baseKey: BASE_QUERY_KEY,
	fetchData,
	empty: () => []
})

export const useNotesQuery = notesQuery.useQuery
export const notesQueryGet = notesQuery.get

// A failed refetch keeps the data and only flips `status` (#103) — resolve from the cached list so an
// offline note still opens.
export function useCachedNote(uuid: string | undefined): Note | null {
	const query = useNotesQuery({
		enabled: false
	})

	return uuid ? (query.data?.find(n => n.uuid === uuid) ?? null) : null
}

// Bumped on every list write. Snapshot-replacers (the socket New handler's fetched list) compare
// it around their network round-trip: a write landing mid-fetch means the snapshot is stale and
// blindly applying it would revert that optimistic write.
let notesListGeneration = 0

export function getNotesListGeneration(): number {
	return notesListGeneration
}

export function notesQueryUpdate(params: { updater: QueryUpdater<Awaited<ReturnType<typeof fetchData>>> }) {
	notesListGeneration++

	notesQuery.update(params)
}

export function notesQueryReplace(note: Note) {
	notesQueryUpdate({
		updater: prev => prev.map(n => (n.uuid === note.uuid ? note : n))
	})
}

// Patches onto the LIVE cache entry rather than a closure-captured copy: concurrent writers (bulk
// Promise.all, socket events) would otherwise each rebuild from the same stale base and the last
// write would revert the others until the next refetch.
export function notesQueryPatch(uuid: string, patch: (live: Note) => Partial<Note>) {
	notesQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === uuid
					? {
							...n,
							...patch(n)
						}
					: n
			)
	})
}

export default useNotesQuery
