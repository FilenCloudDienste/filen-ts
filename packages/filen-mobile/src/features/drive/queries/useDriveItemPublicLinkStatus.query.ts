import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import auth from "@/lib/auth"
import logger from "@/lib/logger"
import { type DriveItem } from "@/types"

export const BASE_QUERY_KEY = "useDriveItemPublicLinkStatusQuery"

export type UseDriveItemPublicLinkStatusQueryParams = {
	uuid: string
	// Optional by-value item, preferred over the cache lookup so a screen that already holds a valid
	// item (its route param) resolves even when the global uuid cache never observed it. NEVER part of
	// the query key — see the hook — so one uuid shares a single cache entry regardless of source.
	item?: DriveItem
}

export async function fetchData(
	params: UseDriveItemPublicLinkStatusQueryParams & {
		signal?: AbortSignal
	}
) {
	const item = params.item ?? cache.uuidToAnyDriveItem.get(params.uuid)

	if (!item) {
		logger.warn("drive", "Public link status query: item not in cache, returning null", { uuid: params.uuid })

		return null
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "file") {
		const status = await authedSdkClient.getFileLinkStatus(
			item.data,
			params?.signal
				? {
						signal: params.signal
					}
				: undefined
		)

		if (!status) {
			return null
		}

		return {
			type: "file" as const,
			status
		}
	} else if (item.type === "directory") {
		const status = await authedSdkClient.getDirLinkStatus(
			item.data,
			params?.signal
				? {
						signal: params.signal
					}
				: undefined
		)

		if (!status) {
			return null
		}

		return {
			type: "directory" as const,
			status
		}
	}

	return null
}

// Stable query key: identity (uuid) only, with the optional by-value item stripped so its object
// identity can't destabilize the key and both resolution sources for one uuid share a cache entry.
export function publicLinkStatusQueryKey(params: UseDriveItemPublicLinkStatusQueryParams): { uuid: string } {
	return { uuid: params.uuid }
}

export function useDriveItemPublicLinkStatusQuery(
	params: UseDriveItemPublicLinkStatusQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY, sortParams(publicLinkStatusQueryKey(params))],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function driveItemPublicLinkStatusQueryUpdate({
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
	const sortedParams = sortParams(publicLinkStatusQueryKey(params))

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>(
		[BASE_QUERY_KEY, sortedParams],
		prev => {
			const currentData = prev ?? (null satisfies Awaited<ReturnType<typeof fetchData>>)

			return typeof updater === "function" ? updater(currentData) : updater
		},
		dataUpdatedAt
	)
}

export default useDriveItemPublicLinkStatusQuery
