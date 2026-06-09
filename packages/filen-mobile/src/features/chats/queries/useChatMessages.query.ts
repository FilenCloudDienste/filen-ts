import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { sortParams } from "@filen/utils"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { wrapMessage } from "@/features/chats/chatsWrap"
import { chatsQueryGet } from "@/features/chats/queries/useChats.query"

export const BASE_QUERY_KEY = "useChatMessagesQuery"

export type UseChatMessagesQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseChatMessagesQueryParams & {
		signal?: AbortSignal
	}
): Promise<ChatMessageWithInflightId[]> {
	const { authedSdkClient } = await auth.getSdkClients()

	// The cache map is only populated by listChats. A chat introduced via socket
	// (ConversationsNew/ConversationParticipantNew) or chats.create won't be there yet,
	// so fall back to the chats query before giving up.
	const chat = cache.chatUuidToChat.get(params.uuid) ?? chatsQueryGet()?.find(c => c.uuid === params.uuid)

	if (!chat) {
		// True miss: return the already-cached messages rather than [] so a remount/focus/reconnect
		// re-run does NOT clobber socket-delivered or optimistic messages with an empty success result.
		return chatMessagesQueryGet(params) ?? []
	}

	// Seed the cache so subsequent runs resolve directly and stay coherent with the chats query.
	cache.chatUuidToChat.set(chat.uuid, chat)

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

export function useChatMessagesQuery(
	params: UseChatMessagesQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
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
	const sortedParams = sortParams(params)

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams], prev => {
		return typeof updater === "function" ? updater(prev ?? []) : updater
	})
}

export function chatMessagesQueryGet(params: UseChatMessagesQueryParams) {
	const sortedParams = sortParams(params)

	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams])
}

export default useChatMessagesQuery
