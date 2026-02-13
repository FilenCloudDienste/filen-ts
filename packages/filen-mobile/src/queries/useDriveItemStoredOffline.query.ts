import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams, queryUpdater } from "@/queries/client"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import offline from "@/lib/offline"
import type { DriveItem } from "@/types"

export const BASE_QUERY_KEY = "useDriveItemStoredOfflineQuery"

export type UseDriveItemStoredOfflineQueryParams = {
	uuid: string
	type: DriveItem["type"]
}

export async function fetchData(
	params: UseDriveItemStoredOfflineQueryParams & {
		signal?: AbortSignal
	}
) {
	const item = cache.uuidToDriveItem.get(params.uuid)

	if (!item) {
		throw new Error("Item not found in cache")
	}

	if (item.type !== params.type) {
		return false
	}

	return await offline.isItemStored(item)
}

export function useDriveItemStoredOfflineQuery(
	params: UseDriveItemStoredOfflineQueryParams,
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

export function driveItemStoredOfflineQueryUpdate({
	updater,
	params,
	dataUpdatedAt
}: {
	params: Parameters<typeof fetchData>[0]
} & {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
	dataUpdatedAt?: number
}): void {
	const sortedParams = sortParams(params)

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>(
		[BASE_QUERY_KEY, sortedParams],
		prev => {
			const currentData = prev ?? (false satisfies Awaited<ReturnType<typeof fetchData>>)

			return typeof updater === "function" ? updater(currentData) : updater
		},
		dataUpdatedAt
	)
}

export default useDriveItemStoredOfflineQuery
