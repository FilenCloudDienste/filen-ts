import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater, queryClient } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import offline from "@/features/offline/offline"
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

// Snapshot of every cached entry under BASE_QUERY_KEY (partial key match — i.e. all
// [BASE_QUERY_KEY, { type, uuid }] queries, including ones restored from SQLite persistence).
// offline.updateIndex() feeds these to findStaleStoredOfflineEntries (offlineHelpers) to
// broadcast `false` for cached `true` entries whose uuid is no longer in the rebuilt offline
// index — otherwise this push-only cache keeps ghost "stored offline" badges forever.
export function getStoredOfflineQueryCacheEntries(): {
	queryKey: readonly unknown[]
	state: {
		data: unknown
	}
}[] {
	// Hand-rolled instead of `findAll({ queryKey: [BASE_QUERY_KEY] })`, which is exactly
	// `getAll().filter(q => matchQuery({queryKey}, q))`. With only a queryKey and no `exact`, matchQuery
	// reduces to `partialMatchKey(q.queryKey, [BASE_QUERY_KEY])` — which, for two arrays, loops the
	// one-element pattern and compares `q.queryKey[0] === BASE_QUERY_KEY`. Identical verdict, without
	// the per-query filter destructure and recursive descent, over a cache that holds every listing,
	// note and chat query in the account. (Version-pinned third-party surface — re-verify the
	// matchQuery/partialMatchKey reduction on @tanstack/query-core upgrades.)
	//
	// `getAll()` itself still materializes the whole cache: QueryCache exposes no iterator, and
	// reaching into its private map to avoid one array would be worse than the array.
	return queryClient
		.getQueryCache()
		.getAll()
		.filter(query => query.queryKey[0] === BASE_QUERY_KEY)
}

export default useDriveItemStoredOfflineQuery
