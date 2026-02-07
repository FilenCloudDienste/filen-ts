import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams } from "@/queries/client"
import auth from "@/lib/auth"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import { AnyDirEnumWithShareInfo_Tags } from "@filen/sdk-rs"
import offline from "@/lib/offline"
import { unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/utils"

export const BASE_QUERY_KEY = "useDirectorySizeQuery"

export type UseDirectorySizeQueryParams = {
	uuid: string
	offline: boolean
}

export async function fetchData(
	params: UseDirectorySizeQueryParams & {
		signal?: AbortSignal
	}
) {
	const dir = cache.directoryUuidToAnyDirWithShareInfo.get(params.uuid)

	if (!dir) {
		throw new Error("Directory not found in cache")
	}

	if (params.offline) {
		if (dir.tag === AnyDirEnumWithShareInfo_Tags.Root) {
			return BigInt(0)
		}

		return await offline.itemSize(unwrappedDirIntoDriveItem(unwrapDirMeta(dir.inner[0])))
	}

	const sdkClient = await auth.getSdkClient()

	const { size } = await sdkClient.getDirSize(
		dir,
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)

	return Number(size)
}

export function useDirectorySizeQuery(
	params: UseDirectorySizeQueryParams,
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

export default useDirectorySizeQuery
