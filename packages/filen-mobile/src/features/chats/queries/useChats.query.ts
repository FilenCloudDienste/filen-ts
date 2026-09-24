import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import queryClient, { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import { type Chat } from "@/types"
import { wrapChat } from "@/features/chats/chatsWrap"
import { socketCoveredRefetchOnMount } from "@/queries/socketSession"

export const BASE_QUERY_KEY = "useChatsQuery"

// Chat and message events patch the list, but another device's read state (lastFocus) and mute
// arrive on no socket event, so a remount reuses a current-session read only this long.
export const CHATS_LIST_REUSE_MS = 30 * 1000

export async function fetchData(params?: { signal?: AbortSignal }): Promise<Chat[]> {
	const { authedSdkClient } = await auth.getSdkClients()

	const chats = (
		await authedSdkClient.listChats(
			params?.signal
				? {
						signal: params.signal
					}
				: undefined
		)
	).map(wrapChat)

	return chats
}

export function useChatsQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		refetchOnMount: socketCoveredRefetchOnMount(CHATS_LIST_REUSE_MS),
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) =>
			fetchData({
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function chatsQueryUpdate({
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

// Through the query registry rather than the bare fetchData, so a mounted observer's in-flight read is shared.
export function chatsQueryFetch(): Promise<Awaited<ReturnType<typeof fetchData>>> {
	return queryClient.fetchQuery({
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) =>
			fetchData({
				signal
			})
	})
}

export function chatsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useChatsQuery
