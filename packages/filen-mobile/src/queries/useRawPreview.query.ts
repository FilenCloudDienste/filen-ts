import { useQuery, onlineManager, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import rawPreviewCache, { type RawPreviewResult } from "@/lib/rawPreviewCache"
import offline from "@/features/offline/offline"
import { type FileSource, fileSourceKey } from "@/queries/fileSource"

export const BASE_QUERY_KEY = "useRawPreviewQuery"

// Only a drive file can be RAW (an external item is a local file the OS handed us).
export type UseRawPreviewQueryParams = Extract<FileSource, { type: "drive" }>

export type RawPreviewQueryResult = RawPreviewResult | { kind: "offline" }

// Order mirrors useFileUrl.query.ts: a cached preview is served offline too, and a stored-offline RAW
// is extracted from its own local container — the cache reaches the network for neither. `offline` is
// therefore only the genuine miss: no cached preview, no local copy, no connection. Otherwise the SDK
// answers `uri` or `noPreview`. Transport errors throw so the gallery shows its error state with an
// explicit Retry (this app wires no refetch-on-focus).
export async function fetchData(
	params: UseRawPreviewQueryParams & {
		signal?: AbortSignal
	}
): Promise<RawPreviewQueryResult> {
	// Prefer the by-value item (a cross-directory search hit may not be in the global uuid
	// cache); fall back to the cache lookup — same rule as resolveFile.
	const item = params.data.item ?? cache.uuidToAnyDriveItem.get(params.data.uuid)

	if (!item || (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")) {
		throw new Error("Drive item not found or is not a file")
	}

	// The local-copy probe is what keeps this from short-circuiting a RAW the cache could still answer
	// from disk; without it a stored-offline container would report "not available offline" while its
	// own bytes sit right there.
	if (!rawPreviewCache.has(item) && !onlineManager.isOnline() && !(await offline.getLocalFile(item))?.exists) {
		return {
			kind: "offline"
		}
	}

	return await rawPreviewCache.get({
		item,
		signal: params.signal
	})
}

export function useRawPreviewQuery(
	params: UseRawPreviewQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<RawPreviewQueryResult, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		// Session-scoped like useFileUrlQuery: the cache may evict the JPEG on its own, so re-resolve on the next mount.
		gcTime: 0,
		staleTime: 0,
		// fetchData answers the offline case itself; TanStack's offline gating must not pause it.
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

	return query as UseQueryResult<RawPreviewQueryResult, Error>
}

export default useRawPreviewQuery
