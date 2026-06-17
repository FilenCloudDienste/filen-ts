import { useQuery, onlineManager, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { AnyFile } from "@filen/sdk-rs"
import cache from "@/lib/cache"
import useHttpStore from "@/stores/useHttp.store"
import { normalizeFilePathForExpo } from "@/lib/paths"
import type { DriveItemFileExtracted } from "@/types"
import { type FileSource, fileSourceKey } from "@/queries/fileSource"
import offline from "@/features/offline/offline"
import fileCache from "@/lib/fileCache"
import { waitForHttpProvider } from "@/lib/thumbnailsHelpers"
import logger from "@/lib/logger"

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
		logger.warn("fileUrl", "getFileUrl threw for item", { error: e })

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

	// Prefer the by-value item (a cross-directory search hit may not be in the global uuid
	// cache); fall back to the cache lookup.
	const item = params.data.item ?? cache.uuidToAnyDriveItem.get(params.data.uuid)

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

	// No local copy. If we're genuinely offline, bail with null — the HTTP provider URL
	// would stall because the provider streams via SDK which needs network.
	// Returning null lets viewers render an "unavailable offline" state.
	if (!onlineManager.isOnline()) {
		return null
	}

	// Online but the provider may still be booting: `http.tsx` starts it asynchronously on
	// AppState "active" and clears it on "background". A one-shot getState() here would resolve
	// SUCCESS+null during that window, leaving the preview stuck in a false "unavailable offline"
	// state with no retry. Instead, wait for readiness (port + getFileUrl) so the query either
	// resolves with a real URL or enters error/retry. waitForHttpProvider resolves immediately if
	// already ready, rejects on abort, and rejects after ~30s.
	let getFileUrl = useHttpStore.getState().getFileUrl

	if (!getFileUrl) {
		getFileUrl = await waitForHttpProvider(params.signal)
	}

	return getFileUrlForItem(item, getFileUrl)
}

export function useFileUrlQuery(
	params: UseFileUrlQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
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

export default useFileUrlQuery
