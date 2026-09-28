import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isPhotoItem } from "@/features/photos/lib/predicate"
import { sortPhotosByCaptureDesc, type PhotoItem } from "@/features/photos/lib/captureSort"
import { photoFolderPaths } from "@/features/photos/lib/search"

// Owns the photos query-key namespace (["photos", …], per client.ts's [domain, entity, params?]
// taxonomy) — separate from ["drive", "listing", …] because a local mutation (favorite/trash/rename)
// on a photos tile must patch THIS key, not drive's own (driveListingQueryUpdate only ever touches
// ["drive", …] keys — see photosListingQueryUpdate below and features/photos/lib/actions.ts, which
// wraps drive's shared mutations with the extra patch this key needs).
export function photosListingQueryKey(rootUuid: string) {
	return ["photos", "listing", rootUuid] as const
}

export interface PhotosListing {
	photos: PhotoItem[]
	// Path below the root of each directory directly holding a photo, for search (photoFolderPaths).
	folders: Record<string, string>
}

// Roots whose latest walk ran entirely under a live socket. A persisted listing restores with its
// original read time, the socket can't replay what changed while the app was closed, and a walk it
// wasn't up for may predate an event it never delivered.
const readThisSession = new Set<string>()

// Favorite flips that land while a walk runs, one map per walk. The walk may have read a flag before its
// flip, so it applies them to what it returns. The echo carries the whole change, the new flag, so unlike
// an event that can change which photos are listed, a favorite never costs another walk.
const flipsDuringWalks = new Set<Map<string, boolean>>()

// The same array when no flip changes a flag.
function withFavoriteFlips(photos: PhotoItem[], flips: ReadonlyMap<string, boolean>): PhotoItem[] {
	if (flips.size === 0) {
		return photos
	}

	let next: PhotoItem[] | undefined

	for (let index = 0; index < photos.length; index++) {
		const photo = photos[index]
		const favorited = photo === undefined ? undefined : flips.get(photo.data.uuid)

		if (photo !== undefined && favorited !== undefined && favorited !== photo.data.favorited) {
			next ??= photos.slice()
			next[index] = { ...photo, data: { ...photo.data, favorited } }
		}
	}

	return next ?? photos
}

// Drive events counted in arrival order, and the count each root's latest walk started at: an event
// counted before the walk under way began is already in what that walk reads, so it needs no walk after.
let photosEventSeq = 0
const walkStartSeq = new Map<string, number>()

// The recursive walk (listPhotosRecursive) plus the media predicate and capture-date sort, all in one
// queryFn — a photos listing has exactly one consumer shape (the grid), so there is no separate
// selector layer filtering/sorting on every render the way a multi-mode drive listing would need.
export async function fetchPhotosListing(rootUuid: string): Promise<PhotosListing> {
	const epoch = currentSocketEpoch()
	const flips = new Map<string, boolean>()

	flipsDuringWalks.add(flips)
	walkStartSeq.set(rootUuid, photosEventSeq)

	try {
		const { dirs, files } = await sdkApi.listPhotosRecursive(rootUuid)

		if (socketLiveSince(epoch)) {
			readThisSession.add(rootUuid)
		} else {
			readThisSession.delete(rootUuid)
		}

		const photos = files.map(narrowItem).filter(isPhotoItem) as PhotoItem[]

		return {
			photos: withFavoriteFlips(sortPhotosByCaptureDesc(photos), flips),
			folders: photoFolderPaths(dirs, photos, rootUuid)
		}
	} finally {
		flipsDuringWalks.delete(flips)
	}
}

// A full recursive walk, and drive socket events already mark the listing stale when something under the
// root changes (invalidatePhotosListing), so a remount or refocus reuses it. Until a walk counts (see
// readThisSession) it refetches like any staleTime-0 query, and a network reconnect always does: events
// may have been missed meanwhile.
export const PHOTOS_LISTING_STALE_TIME = 15 * 60 * 1000

export function usePhotosListingQuery(rootUuid: string | null): UseQueryResult<PhotosListing> {
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
// has viewed this root yet) is left alone; a photos patch is the tail of an action taken FROM an
// already-rendered grid anyway. Unlike drive's patches it still cancels a walk under way, whose result
// may predate the patched change; an active listing walks again at once, as the mutation behind the
// patch has resolved by now, and an inactive one stays marked for its next mount.
export function photosListingQueryUpdate(rootUuid: string, updater: (prev: PhotoItem[]) => PhotoItem[]): void {
	const queryKey = photosListingQueryKey(rootUuid)
	// One lookup by the key's hash: a filter find() copies and re-hashes the whole query cache per call.
	const query = queryClient.getQueryCache().get<PhotosListing>(queryClient.defaultQueryOptions({ queryKey }).queryHash)

	if (query?.state.data === undefined) {
		return
	}

	// setQueryData marks the listing fresh, dropping a pending invalidation and the refetch cancelled
	// below; left unrestored, the change behind them would wait out the stale time.
	const walking = query.state.fetchStatus !== "idle"
	const refreshPending = walking || query.state.isInvalidated

	void query.cancel({ revert: true })
	queryClient.setQueryData<PhotosListing>(queryKey, prev => (prev === undefined ? prev : { ...prev, photos: updater(prev.photos) }))

	// A queued rewalk already walks again once the cancelled one settles.
	if (walking && query.isActive() && !rewalkQueued.has(query.queryHash)) {
		void queryClient.invalidateQueries({ queryKey, exact: true })
	} else if (refreshPending) {
		query.invalidate()
	}
}

// A favorite set outside the grid, in Drive or on another device, reaches it through its socket echo: a
// flag flip on a listed photo, never a new row and never a walk, which is why the echo isn't among the
// invalidating events. A listing without the photo, or with the flag already set, is left alone. A walk
// under way gets the flip too (flipsDuringWalks), whether or not the rows it will replace hold the photo.
export function patchPhotosFavorite(item: DriveItem): void {
	// A listing holds photos only, so no other favorite can concern one.
	if (item.type !== "file" || !isPhotoItem(item)) {
		return
	}

	const flip = new Map([[item.data.uuid, item.data.favorited]])

	for (const flips of flipsDuringWalks) {
		flips.set(item.data.uuid, item.data.favorited)
	}

	for (const query of queryClient.getQueryCache().findAll({ queryKey: ["photos", "listing"] })) {
		const listing = query.state.data as PhotosListing | undefined

		if (listing === undefined) {
			continue
		}

		const next = withFavoriteFlips(listing.photos, flip)

		if (next === listing.photos) {
			continue
		}

		// No cancel: the walk under way returns the flip too. setQueryData drops a pending invalidation.
		const invalidated = query.state.isInvalidated

		queryClient.setQueryData<PhotosListing>(query.queryKey, { ...listing, photos: next })

		if (invalidated) {
			query.invalidate()
		}
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
// three subdirectories down has no cheap membership test from a bare uuid/parent payload. A removal is
// the exception, as it needs none: the listed photo is dropped in place. Given a scope, a listing is
// skipped only when that is proven harmless; anything unproven invalidates. The proof reads the
// worker's dir cache, which is only trusted for an active listing that was read this session and is
// neither mid-walk (the walk may predate the change, so it walks once more after) nor already
// invalidated (a missed or pending change may have left cached parent pointers stale). An inactive
// listing is just marked stale, which costs nothing until it mounts.
export function invalidatePhotosListing(scope: PhotosEventScope | null): void {
	const seq = ++photosEventSeq

	for (const query of queryClient.getQueryCache().findAll({ queryKey: ["photos", "listing"] })) {
		const queryKey = query.queryKey
		const rootUuid = queryKey[2]
		const photos = queryClient.getQueryData<PhotosListing>(queryKey)?.photos

		// Read at call time: a scope check resolving later may find a walk already under way. An inactive
		// listing is only marked, on the query itself rather than through a filter that scans the cache.
		const invalidate = (): void => {
			if (query.state.fetchStatus !== "idle") {
				// A walk that began after this event arrived already reads what it changed.
				if (typeof rootUuid === "string" && (walkStartSeq.get(rootUuid) ?? -1) >= seq) {
					return
				}

				rewalkAfterCurrentWalk(query.queryHash, queryKey)
			} else if (query.isActive()) {
				void queryClient.invalidateQueries({ queryKey, exact: true })
			} else {
				query.invalidate()
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

		if (scope.item === rootUuid) {
			invalidate()

			continue
		}

		const listed = photos.some(photo => photo.data.uuid === scope.item)

		// Only the item itself was involved: a file that left the tree (trashed, deleted, superseded by a
		// new version). A listed one just leaves the listing, whichever surface removed it; an unlisted
		// one changes nothing.
		if (scope.dirs.length === 0) {
			if (listed) {
				queryClient.setQueryData<PhotosListing>(queryKey, prev =>
					prev === undefined ? prev : { ...prev, photos: prev.photos.filter(photo => photo.data.uuid !== scope.item) }
				)
			}

			continue
		}

		if (listed) {
			invalidate()

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
