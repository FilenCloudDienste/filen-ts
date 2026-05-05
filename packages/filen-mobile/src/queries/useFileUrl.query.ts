import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { AnyFile } from "@filen/sdk-rs"
import cache from "@/lib/cache"
import offline from "@/lib/offline"
import useHttpStore from "@/stores/useHttp.store"
import { normalizeFilePathForExpo } from "@/lib/utils"
import type { DriveItemFileExtracted } from "@/types"
import type { FileSource } from "@/queries/fileSource"

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

	const localFile = await offline.getLocalFile(item)

	if (localFile?.exists) {
		return normalizeFilePathForExpo(localFile.uri)
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
