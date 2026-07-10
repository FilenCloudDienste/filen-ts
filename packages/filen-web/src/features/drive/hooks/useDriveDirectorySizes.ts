import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { queryClient } from "@/queries/client"
import { type DriveItem } from "@/features/drive/lib/item"
import { directorySizeQueryOptions } from "@/features/drive/queries/drive"
import {
	collectDirectorySizes,
	directorySizePrefetchTargets,
	isDirectorySizeSuccessEvent
} from "@/features/drive/hooks/useDriveDirectorySizes.logic"

// Feeds REAL directory sizes to the listing's row size column (and, at sort time, the size sort).
// Directories are constructed with a synthetic 0n size (item.ts's narrowItem) — their true recursive
// sizes live only in the useDirectorySizeQuery cache a row would otherwise mount individually. This
// hook makes that cache usable in bulk, cheaply, from ONE call site (directoryListing.tsx):
//
//   - PREFETCH, don't observe: every directory in the listing (capped, see logic) gets a
//     prefetchQuery under the exact key a row would use (shared directorySizeQueryOptions builder) —
//     deduped against any in-flight row fetch, skipped while the cached value is fresh (15min
//     staleTime), zero observers, so the cost stays flat for many-directory listings. prefetchQuery
//     swallows failures; an affected directory just stays on the 0n fallback until a later fetch lands.
//   - ONE cache subscription total (not one per directory): a single filtered QueryCache listener
//     bumps a version counter as size results land, and the map is rebuilt from synchronous
//     getQueryData reads. O(1) reactive footprint regardless of directory count.
//
// The version counter + useMemo is load-bearing, not micro-perf: it is the reactivity bridge to an
// external mutable store (the query cache), and the memo keeps the returned map's identity stable so
// a row/sort re-runs only when a size actually lands. Returns undefined while `enabled` is false (grid
// view, where nothing displays a size — see directoryListing.tsx's own call site) so the caller takes
// its zero-cost path.
//
// useSyncExternalStore, not a useEffect+useState subscription: a plain effect attaches its listener
// AFTER the commit that produced the render it reacts to, leaving a real gap on initial mount (or any
// remount, e.g. navigating into a listing with directories already mid-prefetch from a previous mount)
// where a size-success event lands between this component's render and its subscribe effect running —
// that event bumps nothing, and the affected directory sticks on the 0n fallback under size-sort until
// some LATER, unrelated size event happens to bump the version and drag it in. useSyncExternalStore
// closes exactly that gap: React re-checks the snapshot immediately after subscribing and re-renders
// if it already moved, so no event landing in that window is ever silently missed.
export function useDriveDirectorySizes({
	items,
	enabled
}: {
	items: DriveItem[] | undefined
	enabled: boolean
}): ReadonlyMap<string, number> | undefined {
	// The store's "value" is a monotonic counter kept OUTSIDE React state (a ref, not useState) — only
	// its identity change matters to useSyncExternalStore, never the number itself.
	const versionRef = useRef(0)

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			if (!enabled) {
				return () => undefined
			}

			return queryClient.getQueryCache().subscribe(event => {
				if (isDirectorySizeSuccessEvent(event)) {
					versionRef.current += 1
					onStoreChange()
				}
			})
		},
		[enabled]
	)

	const getSnapshot = useCallback(() => versionRef.current, [])

	const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	useEffect(() => {
		if (!enabled || items === undefined) {
			return
		}

		for (const item of directorySizePrefetchTargets(items)) {
			void queryClient.prefetchQuery(directorySizeQueryOptions(item))
		}
	}, [enabled, items])

	return useMemo(() => {
		// `version` is the reactivity bridge to the query cache: the subscription above bumps it as
		// directory-size results land, which is what makes this memo re-read getQueryData.
		void version

		if (!enabled || items === undefined) {
			return undefined
		}

		return collectDirectorySizes(items, queryClient)
	}, [enabled, items, version])
}

export default useDriveDirectorySizes
