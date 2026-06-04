import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { type FileSource, resolveFile } from "@/queries/fileSource"

export const BASE_QUERY_KEY = "useFileUriQuery"

export type UseFileUriQueryParams = FileSource

export async function fetchData(
	params: UseFileUriQueryParams & {
		signal?: AbortSignal
	}
): Promise<{
	uri: string
}> {
	const file = await resolveFile(params, params.signal)

	return {
		uri: file.uri
	}
}

export function useFileUriQuery(
	params: UseFileUriQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		// Evict immediately when the last subscriber unmounts. The underlying fileCache file may be evicted independently, so a fresh resolve on next mount is the correct behavior anyway.
		gcTime: 0,
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

export default useFileUriQuery
