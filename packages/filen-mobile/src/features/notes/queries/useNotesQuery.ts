import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { type Note } from "@/types"

export const BASE_QUERY_KEY = "useNotesQuery"

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

	for (const note of notes) {
		cache.noteUuidToNote.set(note.uuid, note)
	}

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

export function notesQueryUpdate({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY], prev => {
		return typeof updater === "function" ? updater(prev ?? []) : updater
	})
}

export function notesQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useNotesQuery
