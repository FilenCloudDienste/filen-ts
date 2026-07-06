import { useEffect, useMemo, useState } from "react"
import { queryClient } from "@/queries/client"
import type { DriveItem } from "@/types"
import type { DrivePathType } from "@/hooks/useDrivePath"
import { BASE_QUERY_KEY, directorySizeQueryOptions, type fetchData } from "@/features/drive/queries/useDirectorySize.query"
import { directorySizeTypeForDrivePath } from "@/features/drive/utils"

type DirectorySizeResult = Awaited<ReturnType<typeof fetchData>>

function isDirectoryItemType(type: DriveItem["type"]): boolean {
	return type === "directory" || type === "sharedDirectory" || type === "sharedRootDirectory"
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
//     bumps a version counter as size results land, and the returned map is rebuilt from
//     synchronous getQueryData reads. O(1) reactive footprint regardless of directory count.
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

		return queryClient.getQueryCache().subscribe(event => {
			if (event.type === "updated" && event.action.type === "success" && event.query.queryKey[0] === BASE_QUERY_KEY) {
				setVersion(previous => previous + 1)
			}
		})
	}, [enabled])

	useEffect(() => {
		if (!enabled || !items) {
			return
		}

		for (const item of items) {
			if (isDirectoryItemType(item.type)) {
				void queryClient.prefetchQuery(
					directorySizeQueryOptions({
						uuid: item.data.uuid,
						type
					})
				)
			}
		}
	}, [enabled, items, type])

	return useMemo(() => {
		// `version` is the reactivity bridge to the query cache: the subscription above bumps it
		// as directory-size results land, which is what makes this memo re-read getQueryData.
		void version

		if (!enabled || !items) {
			return undefined
		}

		const sizes = new Map<string, number>()

		for (const item of items) {
			if (!isDirectoryItemType(item.type)) {
				continue
			}

			const data = queryClient.getQueryData<DirectorySizeResult>(
				directorySizeQueryOptions({
					uuid: item.data.uuid,
					type
				}).queryKey
			)

			if (data) {
				sizes.set(item.data.uuid, data.size)
			}
		}

		return sizes.size > 0 ? sizes : undefined
	}, [enabled, items, type, version])
}
