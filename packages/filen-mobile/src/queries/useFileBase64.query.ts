import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { Buffer } from "react-native-quick-crypto"
import { type FileSource, resolveFile, fileSourceKey } from "@/queries/fileSource"

export const BASE_QUERY_KEY = "useFileBase64Query"

export type UseFileBase64QueryParams = FileSource

export async function fetchData(
	params: UseFileBase64QueryParams & {
		signal?: AbortSignal
	}
) {
	const file = await resolveFile(params, params.signal)

	return Buffer.from(await file.bytes()).toString("base64")
}

export function useFileBase64Query(
	params: UseFileBase64QueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		// Base64 strings are ~4/3 the original file size; evict immediately when the last subscriber unmounts. fileCache backs us on disk, so refetch is cheap.
		gcTime: 0,
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

export default useFileBase64Query
