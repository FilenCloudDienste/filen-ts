import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import { type Note } from "@/types"

export const BASE_QUERY_KEY = "useNotesQuery"

// A secondary notes screen (tag drill-down, Manage Tags) mounting over a listing this device read from
// the server within the window shows it instead of re-reading. Past the window it re-reads as before:
// pins, favorites, trash state and tags changed on another device carry no socket event.
export const NOTES_REUSE_WINDOW_MS = 60 * 1000

// Stamped by server reads only. dataUpdatedAt cannot answer this: every optimistic or socket patch
// restamps it.
let lastServerReadAt = 0

export const reuseRecentNotesRead = {
	refetchOnMount: () => (Date.now() - lastServerReadAt < NOTES_REUSE_WINDOW_MS ? false : "always")
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

	lastServerReadAt = Date.now()

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
