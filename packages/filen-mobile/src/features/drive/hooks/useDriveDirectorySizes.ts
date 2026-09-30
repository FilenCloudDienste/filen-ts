import { useEffect, useMemo, useState } from "react"
import { queryClient } from "@/queries/client"
import type { DriveItem } from "@/types"
import { isDirectoryItem } from "@/features/drive/driveSelectors"
import type { DrivePathType } from "@/hooks/useDrivePath"
import {
	BASE_QUERY_KEY,
	directorySizeQueryHash,
	directorySizeQueryOptions,
	type fetchData,
	type UseDirectorySizeQueryParams
} from "@/features/drive/queries/useDirectorySize.query"
import { directorySizeTypeForDrivePath } from "@/features/drive/utils"

type DirectorySizeResult = Awaited<ReturnType<typeof fetchData>>
type DirectorySizeType = UseDirectorySizeQueryParams["type"]

// Each rebuild reads every directory's size, and hashing a key (sortParams + serialize) costs far more
// than the lookup, so the hash is kept per listing item and reused across rebuilds.
const queryHashes = new WeakMap<DriveItem, { uuid: string; type: DirectorySizeType; hash: string }>()

function directorySizeQueryHashOf(item: DriveItem, type: DirectorySizeType): string {
	const cached = queryHashes.get(item)

	if (cached && cached.uuid === item.data.uuid && cached.type === type) {
		return cached.hash
	}

	const hash = directorySizeQueryHash(item.data.uuid, type)

	queryHashes.set(item, { uuid: item.data.uuid, type, hash })

	return hash
}

// Feeds REAL directory sizes into the size sort (#49). Directories are constructed with
// `data.size: 0n` (sdkUnwrap) — their true sizes live only in the useDirectorySizeQuery cache the
// rows display from. This hook makes that cache usable at sort time, cheaply:
//
//   - PREFETCH, don't observe: every directory in the listing gets a prefetchQuery with the exact
//     key the rows use (shared directorySizeQueryOptions builder) — deduped against in-flight row
//     fetches, skipped entirely while the cached value is fresh (15min staleTime), zero observers,
//     so the cost stays flat for listings with many directories. Failures are swallowed by
//     prefetchQuery; the affected directory just stays in the deterministic 0-size fallback until
//     a later fetch lands (rows refetch on reconnect, which re-fires the cache events below).
//   - ONE cache subscription total (not one per directory): a single filtered QueryCache listener
//     bumps a version counter as size results of this listing's type land, at most once per frame,
//     and the returned map is rebuilt from synchronous cache reads. O(1) reactive footprint
//     regardless of directory count, and one rebuild + re-sort per frame while sizes stream in.
//
// Returns undefined while disabled (any non-size sort) so the sorter takes its zero-cost path.
export function useDriveDirectorySizes({
	items,
	drivePathType,
	enabled
}: {
	items: DriveItem[] | undefined
	drivePathType: DrivePathType | null
	enabled: boolean
}): ReadonlyMap<string, number> | undefined {
	const [version, setVersion] = useState<number>(0)
	const type = directorySizeTypeForDrivePath(drivePathType)

	useEffect(() => {
		if (!enabled) {
			return
		}

		let frame: number | null = null

		const unsubscribe = queryClient.getQueryCache().subscribe(event => {
			if (
				frame === null &&
				event.type === "updated" &&
				event.action.type === "success" &&
				event.query.queryKey[0] === BASE_QUERY_KEY &&
				// The rebuild reads only keys of this type, so other types' landings cannot change the map.
				(event.query.queryKey[1] as { type?: unknown } | undefined)?.type === type
			) {
				// The rebuild re-reads the cache, so every landing in this frame is picked up by it.
				frame = requestAnimationFrame(() => {
					frame = null

					setVersion(previous => previous + 1)
				})
			}
		})

		return () => {
			unsubscribe()

			if (frame !== null) {
				cancelAnimationFrame(frame)
			}
		}
	}, [enabled, type])

	useEffect(() => {
		if (!enabled || !items) {
			return
		}

		for (const item of items) {
			if (isDirectoryItem(item)) {
				void queryClient.prefetchQuery(
					directorySizeQueryOptions({
						uuid: item.data.uuid,
						type,
						// Thread the listing item so a session-scoped cache miss still resolves by value.
						// directorySizeQueryOptions strips it from the key, so the prefetch stays
						// cache-compatible with the rows' observed query.
						item
					})
				)
			}
		}
	}, [enabled, items, type])

	return useMemo(() => {
		// `version` is the reactivity bridge to the query cache: the subscription above bumps it
		// as directory-size results land, which is what makes this memo re-read the cache.
		void version

		if (!enabled || !items) {
			return undefined
		}

		const queryCache = queryClient.getQueryCache()
		const sizes = new Map<string, number>()

		for (const item of items) {
			if (!isDirectoryItem(item)) {
				continue
			}

			// What getQueryData returns, minus rebuilding and hashing the key.
			const data = queryCache.get<DirectorySizeResult>(directorySizeQueryHashOf(item, type))?.state.data

			if (data) {
				sizes.set(item.data.uuid, data.size)
			}
		}

		return sizes.size > 0 ? sizes : undefined
	}, [enabled, items, type, version])
}
