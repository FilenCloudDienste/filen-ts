import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import audioCache from "@/lib/audioCache"

export const BASE_QUERY_KEY = "useAudioMetadataQuery"

export type UseAudioMetadataQueryParams =
	| {
			type: "drive"
			data: {
				uuid: string
			}
	  }
	| {
			type: "external"
			data: {
				url: string
				name: string
			}
	  }

export async function fetchData(
	params: UseAudioMetadataQueryParams & {
		signal?: AbortSignal
	}
) {
	if (params.type === "drive") {
		const item = cache.uuidToAnyDriveItem.get(params.data.uuid)

		if (!item || (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")) {
			throw new Error("Drive item not found or is not a file")
		}

		return await audioCache.getMetadata({
			item: {
				type: "drive",
				data: item
			},
			signal: params.signal
		})
	}

	return await audioCache.getMetadata({
		item: {
			type: "external",
			data: params.data
		},
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
