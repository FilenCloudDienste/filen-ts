import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import { NOTES_REUSE_WINDOW_MS } from "@/features/notes/queries/useNotesQuery"

export const BASE_QUERY_KEY = "useNotesTagsQuery"

// Stamped by server reads only (see NOTES_REUSE_WINDOW_MS); tag changes have no socket event at all.
let lastServerReadAt = 0

export const reuseRecentNotesTagsRead = {
	refetchOnMount: () => (Date.now() - lastServerReadAt < NOTES_REUSE_WINDOW_MS ? false : "always")
} satisfies Omit<UseQueryOptions, "queryKey" | "queryFn">

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const tags = await authedSdkClient.listNoteTags(
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)

	lastServerReadAt = Date.now()

	return tags.map(tag => ({
		...tag,
		undecryptable: tag.name === undefined
	}))
}

export function useNotesTagsQuery(
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

export function notesTagsQueryUpdate({
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

export function notesTagsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useNotesTagsQuery
