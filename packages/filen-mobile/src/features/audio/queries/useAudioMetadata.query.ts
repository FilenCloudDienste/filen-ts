import { useQuery, type Query, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { sortParams } from "@filen/shared"
import { type FileSource, fileSourceKey, resolveDriveFileItem } from "@/queries/fileSource"
import audioCache, { isMetadataServable, type Metadata } from "@/features/audio/audioCache"

export const BASE_QUERY_KEY = "useAudioMetadataQuery"

export async function fetchData(
	params: FileSource & {
		signal?: AbortSignal
	}
) {
	if (params.type === "drive") {
		const item = resolveDriveFileItem(params.data)

		if (!item) {
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

// Mounts and reconnects otherwise re-read the sidecar, or re-download the whole track once it expired.
function refetchUnlessServable(query: Query<Metadata, Error>): boolean | "always" {
	return query.state.status === "success" && isMetadataServable(query.state.data) ? false : "always"
}

export function useAudioMetadataQuery(
	params: FileSource,
	options?: Omit<UseQueryOptions<Metadata, Error>, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		refetchOnMount: refetchUnlessServable,
		refetchOnReconnect: refetchUnlessServable,
		...options,
		// Key off identity only (fileSourceKey strips the by-value item).
		queryKey: [BASE_QUERY_KEY, sortParams(fileSourceKey(params))],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query
}

export default useAudioMetadataQuery
