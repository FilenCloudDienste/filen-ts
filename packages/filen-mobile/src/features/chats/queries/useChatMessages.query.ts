import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import { sortParams } from "@filen/utils"
import { type Chat } from "@/types"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { wrapMessage } from "@/features/chats/chatsWrap"
import { chatsQueryGet } from "@/features/chats/queries/useChats.query"

export const BASE_QUERY_KEY = "useChatMessagesQuery"

export type UseChatMessagesQueryParams = {
	uuid: string
	// Optional by-value chat, preferred over the chats-list lookup so a caller that already holds a
	// fresh chat (refetchChatsAndMessages' per-chat fan-out) resolves even before the list query has
	// committed it. NEVER part of the query key — see the key helper — so one uuid shares a single
	// cache entry regardless of resolution source.
	chat?: Chat
}

export async function fetchData(
	params: UseChatMessagesQueryParams & {
		signal?: AbortSignal
	}
): Promise<ChatMessageWithInflightId[]> {
	const { authedSdkClient } = await auth.getSdkClients()

	// Prefer the by-value chat; otherwise resolve from the chats-list query, which is the sole
	// substrate for chat identity (every mutation/socket writer commits to it synchronously).
	const chat = params.chat ?? chatsQueryGet()?.find(c => c.uuid === params.uuid)

	if (!chat) {
		// True miss: return the already-cached messages rather than [] so a remount/focus/reconnect
		// re-run does NOT clobber socket-delivered or optimistic messages with an empty success result.
		return chatMessagesQueryGet(params) ?? []
	}

	const messages = await authedSdkClient.listMessagesBefore(
		chat,
		BigInt(Date.now() + 3600000),
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)

	return messages.map(m => ({
		...wrapMessage(m),
		inflightId: "" // Placeholder, actual inflightId is only needed for send sync
	})) satisfies ChatMessageWithInflightId[]
}

// Stable query key: identity (uuid) only, with the optional by-value chat stripped so its object
// identity can't destabilize the key and both resolution sources for one uuid share a cache entry.
export function chatMessagesQueryKey(params: UseChatMessagesQueryParams): { uuid: string } {
	return { uuid: params.uuid }
}

export function useChatMessagesQuery(
	params: UseChatMessagesQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY, sortParams(chatMessagesQueryKey(params))],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function chatMessagesQueryUpdate({
	params,
	updater
}: {
	params: UseChatMessagesQueryParams
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	const sortedParams = sortParams(chatMessagesQueryKey(params))

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams], prev => {
		return typeof updater === "function" ? updater(prev ?? []) : updater
	})
}

export function chatMessagesQueryGet(params: UseChatMessagesQueryParams) {
	const sortedParams = sortParams(chatMessagesQueryKey(params))

	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams])
}

export default useChatMessagesQuery
