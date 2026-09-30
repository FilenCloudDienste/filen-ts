import queryClient from "@/queries/client"
import { createFixedKeyQuery } from "@/queries/createFixedKeyQuery"
import auth from "@/lib/auth"
import { type Chat } from "@/types"
import { wrapChat } from "@/features/chats/chatsWrap"
import { socketCoveredRefetchOnMount } from "@/queries/socketSession"
import { toSignalOpts } from "@/lib/signals"

export const BASE_QUERY_KEY = "useChatsQuery"

// Chat and message events patch the list, but another device's read state (lastFocus) and mute
// arrive on no socket event, so a remount reuses a current-session read only this long.
export const CHATS_LIST_REUSE_MS = 30 * 1000

export async function fetchData(params?: { signal?: AbortSignal }): Promise<Chat[]> {
	const { authedSdkClient } = await auth.getSdkClients()

	const chats = (
		await authedSdkClient.listChats(
			toSignalOpts(params?.signal)
		)
	).map(wrapChat)

	return chats
}

const chatsQuery = createFixedKeyQuery({
	baseKey: BASE_QUERY_KEY,
	fetchData,
	empty: () => [],
	defaultOptions: {
		refetchOnMount: socketCoveredRefetchOnMount(CHATS_LIST_REUSE_MS)
	}
})

export const useChatsQuery = chatsQuery.useQuery
export const chatsQueryUpdate = chatsQuery.update
export const chatsQueryGet = chatsQuery.get

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

export default useChatsQuery
