import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import auth from "@/lib/auth"

export const BASE_QUERY_KEY = "useDriveItemPublicLinkStatusQuery"

export type UseDriveItemPublicLinkStatusQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseDriveItemPublicLinkStatusQueryParams & {
		signal?: AbortSignal
	}
) {
	const fromCache = cache.uuidToAnyDriveItem.get(params.uuid)

	if (!fromCache) {
		return null
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (fromCache.type === "file") {
		const status = await authedSdkClient.getFileLinkStatus(
			fromCache.data,
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
	} else if (fromCache.type === "directory") {
		const status = await authedSdkClient.getDirLinkStatus(
			fromCache.data,
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

export function useDriveItemPublicLinkStatusQuery(
	params: UseDriveItemPublicLinkStatusQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
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
	const sortedParams = sortParams(params)

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
