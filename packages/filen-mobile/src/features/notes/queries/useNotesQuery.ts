import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { socketCoveredRefetchOnMount } from "@/queries/socketSession"
import auth from "@/lib/auth"
import { type Note } from "@/types"

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
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)

	const notes: Note[] = all.map(n => ({
		...n,
		undecryptable: n.encryptionKey === undefined
	}))

	return notes
}

export function useNotesQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) =>
			fetchData({
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

// Bumped on every list write. Snapshot-replacers (the socket New handler's fetched list) compare
// it around their network round-trip: a write landing mid-fetch means the snapshot is stale and
// blindly applying it would revert that optimistic write.
let notesListGeneration = 0

export function getNotesListGeneration(): number {
	return notesListGeneration
}

export function notesQueryUpdate({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	notesListGeneration++

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY], prev => {
		return typeof updater === "function" ? updater(prev ?? []) : updater
	})
}

export function notesQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useNotesQuery
