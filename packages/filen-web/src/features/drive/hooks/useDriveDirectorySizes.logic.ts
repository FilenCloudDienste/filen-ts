import type { QueryClient } from "@tanstack/react-query"
import type { DirSizeResponse } from "@filen/sdk-rs"
import { type DriveItem } from "@/features/drive/lib/item"
import { directorySizeQueryKey, type DirectorySizeItem } from "@/features/drive/queries/drive"

// Pure bits pulled out of useDriveDirectorySizes.ts's effect/subscription wiring so they're
// table-testable without React, a worker, or Comlink — the hook owns only the wiring around them.

// Ceiling on how many of a listing's directories get a size prefetch fired at once. filen-mobile
// prefetches every directory unbounded; a web listing can hold far more rows, and each prefetch is a
// recursive server-side size walk, so this caps the burst. Directories past the cap keep the size
// sort's deterministic fallback (raw synthetic 0n size + name tiebreak — see lib/sort) until one
// scrolls into a later listing. DEVIATION FROM MOBILE (which is unbounded).
export const MAX_DIRECTORY_SIZE_PREFETCH = 1000

// A DriveItem arm the size query can dispatch on — owned OR shared directories, matching
// queries/drive's DirectorySizeItem (the arms toAnyDirWithContext accepts).
export function isDirectorySizeItem(item: DriveItem): item is DirectorySizeItem {
	return item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}

// Which directories in the listing to fire a size prefetch for — directories only, capped at
// MAX_DIRECTORY_SIZE_PREFETCH, input order preserved.
export function directorySizePrefetchTargets(items: readonly DriveItem[]): DirectorySizeItem[] {
	const targets: DirectorySizeItem[] = []

	for (const item of items) {
		if (!isDirectorySizeItem(item)) {
			continue
		}

		targets.push(item)

		if (targets.length >= MAX_DIRECTORY_SIZE_PREFETCH) {
			break
		}
	}

	return targets
}

// Synchronous read of whatever directory sizes have landed in the query cache so far, assembled into
// the uuid->bytes map lib/sort consumes. Not-yet-resolved directories are simply omitted — the sort's
// 0n fallback covers them. Returns undefined when the map is empty so the sort takes its zero-cost
// path (identical to passing no map). Sizes cross Comlink as bigint; Number() here matches the map
// type sort expects — a directory past 2^53 bytes is not a real case.
export function collectDirectorySizes(items: readonly DriveItem[], queryClient: QueryClient): ReadonlyMap<string, number> | undefined {
	const sizes = new Map<string, number>()

	for (const item of items) {
		if (!isDirectorySizeItem(item)) {
			continue
		}

		const data = queryClient.getQueryData<DirSizeResponse>(directorySizeQueryKey(item.data.uuid))

		if (data !== undefined) {
			sizes.set(item.data.uuid, Number(data.size))
		}
	}

	return sizes.size > 0 ? sizes : undefined
}

// The cache-event filter the hook's single subscription uses: a directory-size query settling
// successfully is the ONLY event that should re-read the map (bump the version counter). Matches on
// the key prefix so it ignores every other domain/entity churning through the shared cache.
export interface DirectorySizeCacheEvent {
	type: string
	action?: { type?: string }
	query: { queryKey: readonly unknown[] }
}

export function isDirectorySizeSuccessEvent(event: DirectorySizeCacheEvent): boolean {
	return (
		event.type === "updated" &&
		event.action?.type === "success" &&
		event.query.queryKey[0] === "drive" &&
		event.query.queryKey[1] === "dirSize"
	)
}
