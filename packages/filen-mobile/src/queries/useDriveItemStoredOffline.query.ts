import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import offline from "@/lib/offline"
import type { DriveItem } from "@/types"

export const BASE_QUERY_KEY = "useDriveItemStoredOfflineQuery"

export type UseDriveItemStoredOfflineQueryParams = {
	uuid: string
	type: DriveItem["type"]
}

// Normalize type to base form so "file"/"sharedFile"/"sharedRootFile" all share the same query key.
// Without this, items stored offline as "file" wouldn't match UI queries using "sharedFile".
function normalizeTypeForKey(type: DriveItem["type"]): "file" | "directory" {
	switch (type) {
		case "file":
		case "sharedFile":
		case "sharedRootFile": {
			return "file"
		}

		case "directory":
		case "sharedDirectory":
		case "sharedRootDirectory": {
			return "directory"
		}
	}
}

export async function fetchData(
	params: UseDriveItemStoredOfflineQueryParams & {
		signal?: AbortSignal
	}
) {
	const item = cache.uuidToAnyDriveItem.get(params.uuid)

	if (!item) {
		return false
	}

	return await offline.isItemStored(item)
}

export function useDriveItemStoredOfflineQuery(
	params: UseDriveItemStoredOfflineQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const normalizedParams = sortParams({
		uuid: params.uuid,
		type: normalizeTypeForKey(params.type)
	})

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		// Query is updated through setup() indexing
		enabled: false,
		staleTime: Infinity,
		queryKey: [BASE_QUERY_KEY, normalizedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...normalizedParams,
				signal
			})
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
	const normalizedParams = sortParams({
		uuid: params.uuid,
		type: normalizeTypeForKey(params.type)
	})

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>(
		[BASE_QUERY_KEY, normalizedParams],
		prev => {
			const currentData = prev ?? (false satisfies Awaited<ReturnType<typeof fetchData>>)

			return typeof updater === "function" ? updater(currentData) : updater
		},
		dataUpdatedAt
	)
}

export default useDriveItemStoredOfflineQuery
