import { useQuery, onlineManager, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { AnyFile } from "@filen/sdk-rs"
import cache from "@/lib/cache"
import useHttpStore from "@/stores/useHttp.store"
import { normalizeFilePathForExpo } from "@/lib/utils"
import type { DriveItemFileExtracted } from "@/types"
import type { FileSource } from "@/queries/fileSource"
import offline from "@/features/offline/offline"
import fileCache from "@/lib/fileCache"

export const BASE_QUERY_KEY = "useFileUrlQuery"

export type UseFileUrlQueryParams = FileSource

function getFileUrlForItem(item: DriveItemFileExtracted, getFileUrl: (file: AnyFile) => string): string | null {
	try {
		switch (item.type) {
			case "file": {
				return getFileUrl(new AnyFile.File(item.data))
			}

			case "sharedFile":
			case "sharedRootFile": {
				return getFileUrl(new AnyFile.Shared(item.data))
			}
		}
	} catch (e) {
		console.error(e)

		return null
	}
}

export async function fetchData(
	params: UseFileUrlQueryParams & {
		signal?: AbortSignal
	}
): Promise<string | null> {
	if (params.type === "external") {
		return params.data.url
	}

	const item = cache.uuidToAnyDriveItem.get(params.data.uuid)

	if (!item || (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")) {
		return null
	}

	if (
		await fileCache.has({
			type: "drive",
			data: item
		})
	) {
		const fileCacheFile = await fileCache.get({
			item: {
				type: "drive",
				data: item
			}
		})

		if (fileCacheFile?.exists) {
			return normalizeFilePathForExpo(fileCacheFile.uri)
		}
	}

	const offlineFile = await offline.getLocalFile(item)

	if (offlineFile?.exists) {
		return normalizeFilePathForExpo(offlineFile.uri)
	}

	// No local copy. If we're offline, bail with null — the HTTP provider URL
	// would stall because the provider streams via SDK which needs network.
	// Returning null lets viewers render an "unavailable offline" state.
	if (!onlineManager.isOnline()) {
		return null
	}

	const getFileUrl = useHttpStore.getState().getFileUrl

	if (!getFileUrl) {
		return null
	}

	return getFileUrlForItem(item, getFileUrl)
}

export function useFileUrlQuery(
	params: UseFileUrlQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		// Evict immediately when the last subscriber unmounts. URLs are bound to the localhost HTTP provider's session-scoped port, so re-deriving on next mount is the correct behavior anyway.
		gcTime: 0,
		staleTime: 0,
		// Override the global "offlineFirst" default — this query's fetchData is
		// pure-local computation (offline store / file cache / HTTP-provider URL
		// resolution), so it must never be paused by TanStack's offline gating.
		networkMode: "always",
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

export function fileUrlQueryUpdate({
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

export function fileUrlQueryGet(params: UseFileUrlQueryParams): Awaited<ReturnType<typeof fetchData>> | undefined {
	const sortedParams = sortParams(params)

	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams])
}

export default useFileUrlQuery
