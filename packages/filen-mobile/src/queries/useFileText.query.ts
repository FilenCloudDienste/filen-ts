import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { type FileSource, resolveFile } from "@/queries/fileSource"

export const BASE_QUERY_KEY = "useFileTextQuery"

export type UseFileTextQueryParams = FileSource

export async function fetchData(
	params: UseFileTextQueryParams & {
		signal?: AbortSignal
	}
) {
	const file = await resolveFile(params, params.signal)

	return await file.text()
}

export function useFileTextQuery(
	params: UseFileTextQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		// File contents can be MB-sized; evict immediately when the last subscriber unmounts. fileCache backs us on disk, so refetch is cheap.
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

export default useFileTextQuery
