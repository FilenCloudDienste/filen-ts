import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import { type DriveItemFileExtracted } from "@/types"
import audioCache from "@/features/audio/audioCache"

export const BASE_QUERY_KEY = "useAudioMetadataQuery"

export type UseAudioMetadataQueryParams =
	| {
			type: "drive"
			data: {
				uuid: string
				// Optional by-value file item — threaded by callers holding a cross-directory
				// search result not in the global uuid cache. Preferred over the cache lookup;
				// stripped from the query key (see the queryKey below).
				item?: DriveItemFileExtracted
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
		// Prefer the by-value item (cross-directory search hit); fall back to the cache.
		const item = params.data.item ?? cache.uuidToAnyDriveItem.get(params.data.uuid)

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
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		// Key off identity only — strip the optional by-value item so the object instance
		// that carried it here can't destabilize the key (metadata is the same per uuid).
		// `params` is referenced inline so the query exhaustive-deps lint sees it.
		queryKey: [
			BASE_QUERY_KEY,
			sortParams(params.type === "drive" ? { type: "drive" as const, data: { uuid: params.data.uuid } } : params)
		],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useAudioMetadataQuery
