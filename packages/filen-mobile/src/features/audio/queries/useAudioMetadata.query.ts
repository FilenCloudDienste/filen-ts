import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { sortParams } from "@filen/shared"
import { type FileSource, fileSourceKey, resolveDriveFileItem } from "@/queries/fileSource"
import audioCache from "@/features/audio/audioCache"

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

export function useAudioMetadataQuery(
	params: FileSource,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...options,
		// Key off identity only (fileSourceKey strips the by-value item).
		queryKey: [BASE_QUERY_KEY, sortParams(fileSourceKey(params))],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useAudioMetadataQuery
