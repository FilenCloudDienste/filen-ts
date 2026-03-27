import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import audioCache from "@/lib/audioCache"

export const BASE_QUERY_KEY = "useAudioMetadataQuery"

export type UseAudioMetadataQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseAudioMetadataQueryParams & {
		signal?: AbortSignal
	}
) {
	const item = cache.uuidToDriveItem.get(params.uuid)

	if (!item || (item.type !== "file" && item.type !== "sharedFile")) {
		throw new Error("Drive item not found or is not a file")
	}

	return await audioCache.getMetadata({
		item,
		signal: params.signal
	})
}

export function useAudioMetadataQuery(
	params: UseAudioMetadataQueryParams,
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

export default useAudioMetadataQuery
