import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isPhotoItem } from "@/features/photos/lib/predicate"
import { sortPhotosByCaptureDesc, type PhotoItem } from "@/features/photos/lib/captureSort"

// Owns the photos query-key namespace (["photos", …], per client.ts's [domain, entity, params?]
// taxonomy) — separate from ["drive", "listing", …] because a local mutation (favorite/trash/rename)
// on a photos tile must patch THIS key, not drive's own (driveListingQueryUpdate only ever touches
// ["drive", …] keys — see photosListingQueryUpdate below and features/photos/lib/actions.ts, which
// wraps drive's shared mutations with the extra patch this key needs).
export function photosListingQueryKey(rootUuid: string) {
	return ["photos", "listing", rootUuid] as const
}

// Roots whose latest walk ran entirely under a live socket. A persisted listing restores with its
// original read time, the socket can't replay what changed while the app was closed, and a walk it
// wasn't up for may predate an event it never delivered.
const readThisSession = new Set<string>()

// The recursive walk (listPhotosRecursive) plus the media predicate and capture-date sort, all in one
// queryFn — a photos listing has exactly one consumer shape (the grid), so there is no separate
// selector layer filtering/sorting on every render the way a multi-mode drive listing would need.
export async function fetchPhotosListing(rootUuid: string): Promise<PhotoItem[]> {
	const epoch = currentSocketEpoch()
	const { dirs, files } = await sdkApi.listPhotosRecursive(rootUuid)

	if (socketLiveSince(epoch)) {
		readThisSession.add(rootUuid)
	} else {
		readThisSession.delete(rootUuid)
	}

	const items: DriveItem[] = [...dirs.map(narrowItem), ...files.map(narrowItem)]
	const photos = items.filter(isPhotoItem) as PhotoItem[]

	return sortPhotosByCaptureDesc(photos)
}

// A full recursive walk, and drive socket events already mark the listing stale when something under the
// root changes (invalidatePhotosListing), so a remount or refocus reuses it. Until a walk counts (see
// readThisSession) it refetches like any staleTime-0 query, and a network reconnect always does: events
// may have been missed meanwhile.
export const PHOTOS_LISTING_STALE_TIME = 15 * 60 * 1000

export function usePhotosListingQuery(rootUuid: string | null): UseQueryResult<PhotoItem[]> {
	return useQuery({
		queryKey: photosListingQueryKey(rootUuid ?? ""),
		queryFn: () => fetchPhotosListing(rootUuid ?? ""),
		enabled: rootUuid !== null,
		staleTime: query => (readThisSession.has(query.queryKey[2]) ? PHOTOS_LISTING_STALE_TIME : 0),
		refetchOnReconnect: "always"
	})
}

// Single-key confirm-then-patch, mirroring driveListingQueryUpdate's own shape (features/drive/
// queries/drive.ts) but scoped to the one photos key currently mounted for `rootUuid` — there is only
// ever one photos listing query alive at a time (kv-persisted single root), so this needs no
// "Global" fan-out counterpart the way drive's own multi-listing surface does. A cache miss (nobody
// has viewed this root yet) is left alone rather than defaulting to [] — unlike driveListingQueryUpdate,
// a photos patch is always the tail of an action taken FROM an already-rendered grid, so the query is
// always already populated by the time this runs.
export function photosListingQueryUpdate(rootUuid: string, updater: (prev: PhotoItem[]) => PhotoItem[]): void {
	const queryKey = photosListingQueryKey(rootUuid)
	const query = queryClient.getQueryCache().find({ queryKey, exact: true })
	// setQueryData marks the listing fresh, dropping a pending invalidation and the refetch cancelled
	// below; left unrestored, the change behind them would wait out the stale time.
	const refreshPending = query !== undefined && (query.state.isInvalidated || query.state.fetchStatus !== "idle")

	if (queryClient.getQueryData(queryKey) !== undefined) {
		void queryClient.cancelQueries({ queryKey })
	}

	queryClient.setQueryData<PhotoItem[]>(queryKey, prev => (prev === undefined ? prev : updater(prev)))

	if (refreshPending && queryClient.getQueryData(queryKey) !== undefined) {
		void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" })
	}
}

// What a drive event touched, for deciding whether a photos listing can have changed: every directory
// it landed in or left, and the item itself. The event concerns a listing when the item is the root or
// a photo the listing holds, or when any of `dirs` may sit under the root.
export interface PhotosEventScope {
	dirs: readonly string[]
	item: string
}

// Refetches the whole recursive walk rather than splice-patching the event's single item in: a photo
// three subdirectories down has no cheap membership test from a bare uuid/parent payload. Given a
// scope, a listing is skipped only when that is proven harmless; anything unproven invalidates. The
// proof reads the worker's dir cache, which is only trusted for an active listing that was read this
// session and is neither mid-walk (the walk may predate the change, so it walks once more after) nor
// already invalidated (a missed or pending change may have left cached parent pointers stale). An
// inactive listing is just marked stale, which costs nothing until it mounts.
export function invalidatePhotosListing(scope: PhotosEventScope | null): void {
	for (const query of queryClient.getQueryCache().findAll({ queryKey: ["photos", "listing"] })) {
		const queryKey = query.queryKey
		const rootUuid = queryKey[2]
		const photos = queryClient.getQueryData<PhotoItem[]>(queryKey)

		// Read at call time: a scope check resolving later may find a walk already under way.
		const invalidate = (): void => {
			if (query.state.fetchStatus === "idle") {
				void queryClient.invalidateQueries({ queryKey, exact: true })
			} else {
				rewalkAfterCurrentWalk(query.queryHash, queryKey)
			}
		}

		if (query.state.fetchStatus !== "idle") {
			invalidate()

			continue
		}

		if (
			scope === null ||
			typeof rootUuid !== "string" ||
			photos === undefined ||
			!readThisSession.has(rootUuid) ||
			!query.isActive() ||
			query.state.isInvalidated
		) {
			invalidate()

			continue
		}

		if (scope.item === rootUuid || photos.some(photo => photo.data.uuid === scope.item)) {
			invalidate()

			continue
		}

		// Only the item itself could have been involved, and it isn't listed: removing it changes nothing.
		if (scope.dirs.length === 0) {
			continue
		}

		sdkApi.isOutsidePhotosRoot(rootUuid, [...scope.dirs]).then(outside => {
			if (!outside) {
				invalidate()
			}
		}, invalidate)
	}
}

// A walk in flight may predate the event, so it walks once more after it settles — once, however many
// events arrive meanwhile. Restarting it per event instead would never let a walk finish while a copy
// under the root streams its files in.
const rewalkQueued = new Set<string>()

function rewalkAfterCurrentWalk(queryHash: string, queryKey: QueryKey): void {
	if (rewalkQueued.has(queryHash)) {
		return
	}

	rewalkQueued.add(queryHash)

	void queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false }).finally(() => {
		rewalkQueued.delete(queryHash)

		void queryClient.invalidateQueries({ queryKey, exact: true })
	})
}

// A dropped socket may have missed events: mark every listing stale without refetching while the socket
// is down. The next mount, focus or event reads it again, and the scoping above stays off until it has.
export function markPhotosListingStale(): void {
	void queryClient.invalidateQueries({ queryKey: ["photos", "listing"], refetchType: "none" })
}
