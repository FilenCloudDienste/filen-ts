import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { sortParams } from "@filen/utils"
import type { ChatMessageWithInflightId } from "@/stores/useChats.store"

export const BASE_QUERY_KEY = "useChatMessagesQuery"

export type UseChatMessagesQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseChatMessagesQueryParams & {
		signal?: AbortSignal
	}
) {
	const { authedSdkClient } = await auth.getSdkClients()
	const chat = cache.chatUuidToChat.get(params.uuid)

	if (!chat) {
		return []
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
		...m,
		inflightId: "" // Placeholder, actual inflightId is only needed for send sync
	})) satisfies ChatMessageWithInflightId[]
}

export function useChatMessagesQuery(
	params: UseChatMessagesQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const defaultParams = useDefaultQueryParams(options)
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...defaultParams,
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
