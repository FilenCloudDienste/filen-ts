import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams } from "@/queries/client"
import auth from "@/lib/auth"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import { sortParams, parseFilenPublicLink } from "@filen/utils"

export const BASE_QUERY_KEY = "useChatPublicLinkQuery"

export type UseChatPublicLinkQueryParams = {
	link: string
}

export async function fetchData(
	params: UseChatPublicLinkQueryParams & {
		signal?: AbortSignal
	}
) {
	const parsed = parseFilenPublicLink(params.link)

	if (!parsed) {
		return []
	}

	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.listChats(
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)
}

export function useChatPublicLinkQuery(
	params: UseChatPublicLinkQueryParams,
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

	useRefreshOnFocus({
		isEnabled: query.isEnabled,
		refetch: query.refetch
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useChatPublicLinkQuery
