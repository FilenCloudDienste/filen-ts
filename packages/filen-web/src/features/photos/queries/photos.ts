import { useEffect, useSyncExternalStore } from "react"
import { useQueries } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { removeQueriesAndPersisted } from "@/queries/persist"
import {
	cachedQueriesWithPrefix,
	cachedQuery,
	cancelInFlightIfCached,
	invalidateJoiningInFlight,
	isReadAgainQueued,
	setQueryDataKeepInvalidated
} from "@/queries/patch"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isPhotoCandidate, isPhotoCategory } from "@/features/photos/lib/predicate"
import { subscribeFileKindVerdicts } from "@/features/drive/lib/fileKindVerdicts"
import { itemFileKind } from "@/features/drive/lib/preview.logic"
import { createListenerSet } from "@/lib/listenerSet"
import { mergePhotosByCaptureDesc, sortPhotosByCaptureDesc, type PhotoItem } from "@/features/photos/lib/captureSort"
import { outermostOfRoots, useDirectoryRootChains } from "@/lib/directoryRoots"
import { photoFolderPaths } from "@/features/photos/lib/search"

// Owns the photos query-key namespace (["photos", …], per client.ts's [domain, entity, params?]
// taxonomy) — separate from ["drive", "listing", …] because a local mutation (favorite/trash/rename)
// on a photos tile must patch THIS key, not drive's own (driveListingQueryUpdate only ever touches
// ["drive", …] keys — see photosListingQueryUpdate below and features/photos/lib/actions.ts, which
// wraps drive's shared mutations with the extra patch this key needs).
export const PHOTOS_LISTING_KEY_PREFIX = ["photos", "listing"] as const

export function photosListingQueryKey(rootUuid: string) {
	return [...PHOTOS_LISTING_KEY_PREFIX, rootUuid] as const
}

export interface PhotosListing {
	// Photos and the files a content verdict could still make one (isPhotoCandidate); what shows is
	// decided as it is read (usePhotosTimeline).
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

		const photos = files.map(narrowItem).filter(isPhotoCandidate) as PhotoItem[]

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
const PHOTOS_LISTING_STALE_TIME = 15 * 60 * 1000

// Key, walk and freshness in one place, so a read outside the grid (the assistant) reuses the grid's listing.
export function photosListingQueryOptions(rootUuid: string) {
	return {
		queryKey: photosListingQueryKey(rootUuid),
		queryFn: () => fetchPhotosListing(rootUuid),
		staleTime: (query: { queryKey: ReturnType<typeof photosListingQueryKey> }) =>
			readThisSession.has(query.queryKey[2]) ? PHOTOS_LISTING_STALE_TIME : 0
	}
}

// Listed files whose content verdict can change whether they show: a candidate `.ts`, a video an "audio"
// verdict would hide. Taken as a listing is read; a verdict for any other file leaves the listing alone.
let verdictWatched: ReadonlySet<string> = new Set()
let shownVersion = 0
let shownBump: ReturnType<typeof setTimeout> | null = null
const shownChanges = createListenerSet("photos-verdicts")

// One re-read per frame at most, however many verdicts land.
subscribeFileKindVerdicts(uuids => {
	if (shownBump !== null || verdictWatched.size === 0 || (uuids !== null && !uuids.some(uuid => verdictWatched.has(uuid)))) {
		return
	}

	shownBump = setTimeout(() => {
		shownBump = null
		shownVersion++
		shownChanges.emit()
	}, 16)
})

function subscribeShownPhotos(listener: () => void): () => void {
	return shownChanges.subscribe(listener)
}

function shownPhotosVersion(): number {
	return shownVersion
}

// The photos a listing shows under the verdicts known now, in one pass that also notes which of them a
// verdict could still change; the same listing when it shows all it holds.
function shownPhotos(listing: PhotosListing): PhotosListing {
	const watched = new Set<string>()
	const photos = listing.photos.filter(photo => {
		const kind = itemFileKind(photo)

		if (kind === null) {
			return false
		}

		if (kind.ambiguous) {
			watched.add(photo.data.uuid)
		}

		return isPhotoCategory(kind.kind)
	})

	verdictWatched = watched

	return photos.length === listing.photos.length ? listing : { ...listing, photos }
}

// The listing filtered again only when it or a verdict about one of its watched files changes.
let shownCache: { listing: PhotosListing; version: number; shown: PhotosListing } | null = null

function shownPhotosOf(listing: PhotosListing, version: number): PhotosListing {
	if (shownCache?.listing !== listing || shownCache.version !== version) {
		shownCache = { listing, version, shown: shownPhotos(listing) }
	}

	return shownCache.shown
}

// The roots' listings as one: their photos in one capture-time order, merged rather than sorted again (each is
// sorted already), and their directory paths. A single listing is itself.
export function mergePhotosListings(listings: readonly PhotosListing[]): PhotosListing {
	const [first] = listings

	if (listings.length === 1 && first !== undefined) {
		return first
	}

	const folders: Record<string, string> = {}

	for (const listing of listings) {
		Object.assign(folders, listing.folders)
	}

	return {
		photos: mergePhotosByCaptureDesc(listings.map(listing => listing.photos)),
		folders
	}
}

let mergedCache: { listings: readonly PhotosListing[]; merged: PhotosListing } | null = null

function mergedListing(listings: readonly PhotosListing[]): PhotosListing {
	const known = mergedCache

	if (known?.listings.length === listings.length && known.listings.every((listing, index) => listing === listings[index])) {
		return known.merged
	}

	const merged = mergePhotosListings(listings)

	mergedCache = { listings, merged }

	return merged
}

export type PhotosTimeline =
	| { status: "pending" }
	// No root could be listed; `error` is the first root's failure.
	| { status: "error"; error: unknown }
	| { status: "success"; listing: PhotosListing }

export interface PhotosTimelineResult {
	timeline: PhotosTimeline
	// The roots listed: the configured ones minus any another holds (resolved from their chains, only with two roots
	// or more), so no directory is walked twice. Empty until known.
	listedRoots: readonly string[]
	// Roots whose listing failed (others may still have listed).
	failures: readonly { rootUuid: string; error: unknown }[]
	retry: () => void
}

// Every root's listing (one recursive walk each), merged into the one timeline the grid shows. Pending until every
// root has a listing, failed, or waits for the network (offline, what is held shows at once), so the timeline
// never reorders under the user as a late root lands.
export function usePhotosTimeline(roots: readonly string[]): PhotosTimelineResult {
	const chains = useDirectoryRootChains(roots, roots.length > 1)
	// A chain not resolved yet (or waiting for the network) keeps its root: walking a nested root once costs less
	// than holding every listing back, and the merge keeps a photo listed twice once.
	const listedRoots = outermostOfRoots(roots, chains)
	const droppedKey = roots.filter(root => !listedRoots.includes(root)).join(",")
	const results = useQueries({
		queries: listedRoots.map(rootUuid => ({
			...photosListingQueryOptions(rootUuid),
			refetchOnReconnect: "always" as const
		}))
	})

	// A root another one holds is read through that one: its own listing goes.
	useEffect(() => {
		if (droppedKey.length > 0) {
			forgetPhotosListings(droppedKey.split(","))
		}
	}, [droppedKey])

	const version = useSyncExternalStore(subscribeShownPhotos, shownPhotosVersion)
	const listings: PhotosListing[] = []
	const failures: { rootUuid: string; error: unknown }[] = []
	let pending = false

	for (let index = 0; index < results.length; index++) {
		const result = results[index]
		const rootUuid = listedRoots[index]

		if (result === undefined || rootUuid === undefined) {
			continue
		}

		if (result.data !== undefined) {
			listings.push(result.data)
		}

		if (result.status === "error") {
			failures.push({ rootUuid, error: result.error })
		} else if (result.data === undefined && result.fetchStatus !== "paused") {
			pending = true
		}
	}

	const [firstFailure] = failures
	const timeline: PhotosTimeline = pending
		? { status: "pending" }
		: listings.length === 0 && firstFailure !== undefined
			? { status: "error", error: firstFailure.error }
			: { status: "success", listing: shownPhotosOf(mergedListing(listings), version) }

	return {
		timeline,
		listedRoots,
		failures,
		retry: () => {
			for (const result of results) {
				if (result.status === "error") {
					void result.refetch()
				}
			}
		}
	}
}

// Drops these roots' listings from memory and from disk: a listing is a whole recursive walk, and one of a root that
// is no longer read would otherwise stay for as long as the persisted cache keeps anything.
export function forgetPhotosListings(rootUuids: readonly string[]): void {
	for (const rootUuid of rootUuids) {
		readThisSession.delete(rootUuid)
		walkStartSeq.delete(rootUuid)
		removeQueriesAndPersisted(queryClient, photosListingQueryKey(rootUuid))
	}
}

// forgetPhotosListings for every held listing of a root outside `active`.
export function forgetPhotosListingsExcept(active: ReadonlySet<string>): void {
	const stale: string[] = []

	for (const query of cachedQueriesWithPrefix(PHOTOS_LISTING_KEY_PREFIX)) {
		const rootUuid = query.queryKey[2]

		if (typeof rootUuid === "string" && !active.has(rootUuid)) {
			stale.push(rootUuid)
		}
	}

	forgetPhotosListings(stale)
}

// photosListingQueryUpdate for the listings (of `rootUuids`) that hold one of `touched`: a photo is listed under
// one root only, so the others aren't patched, nor their walks cancelled.
export function photosListingsUpdate(
	rootUuids: readonly string[],
	touched: ReadonlySet<string>,
	updater: (prev: PhotoItem[]) => PhotoItem[]
): void {
	for (const rootUuid of rootUuids) {
		const photos = queryClient.getQueryData<PhotosListing>(photosListingQueryKey(rootUuid))?.photos

		if (photos?.some(photo => touched.has(photo.data.uuid)) === true) {
			photosListingQueryUpdate(rootUuid, updater)
		}
	}
}

// Single-key confirm-then-patch, mirroring driveListingQueryUpdate's own shape (features/drive/
// queries/drive.ts) but scoped to one root's photos key (photosListingsUpdate picks the roots a change
// concerns). A cache miss (nobody has viewed this root yet) is left alone; a photos patch is the tail of
// an action taken FROM an already-rendered grid anyway. Unlike drive's patches it still cancels a walk
// under way, whose result may predate the patched change; an active listing walks again at once, as the
// mutation behind the patch has resolved by now, and an inactive one stays marked for its next mount.
export function photosListingQueryUpdate(rootUuid: string, updater: (prev: PhotoItem[]) => PhotoItem[]): void {
	const queryKey = photosListingQueryKey(rootUuid)
	const query = cachedQuery<PhotosListing>(queryKey)

	if (query?.state.data === undefined) {
		return
	}

	// setQueryData marks the listing fresh, dropping a pending invalidation and the refetch cancelled
	// below; left unrestored, the change behind them would wait out the stale time.
	const walking = query.state.fetchStatus !== "idle"
	const refreshPending = walking || query.state.isInvalidated

	cancelInFlightIfCached(query)
	queryClient.setQueryData<PhotosListing>(queryKey, prev => (prev === undefined ? prev : { ...prev, photos: updater(prev.photos) }))

	// A queued rewalk already walks again once the cancelled one settles.
	if (walking && query.isActive() && !isReadAgainQueued(query)) {
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
	// A listing holds photos and candidates only, so no other favorite can concern one.
	if (item.type !== "file" || !isPhotoCandidate(item)) {
		return
	}

	const flip = new Map([[item.data.uuid, item.data.favorited]])

	for (const flips of flipsDuringWalks) {
		flips.set(item.data.uuid, item.data.favorited)
	}

	for (const query of cachedQueriesWithPrefix(PHOTOS_LISTING_KEY_PREFIX)) {
		const listing = query.state.data as PhotosListing | undefined

		if (listing === undefined) {
			continue
		}

		const next = withFavoriteFlips(listing.photos, flip)

		if (next === listing.photos) {
			continue
		}

		// No cancel: the walk under way returns the flip too.
		setQueryDataKeepInvalidated(query, { ...listing, photos: next })
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

	for (const query of cachedQueriesWithPrefix(PHOTOS_LISTING_KEY_PREFIX)) {
		const queryKey = query.queryKey
		const rootUuid = queryKey[2]
		const photos = queryClient.getQueryData<PhotosListing>(queryKey)?.photos

		// Read at call time: a scope check resolving later may find a walk already under way. An inactive
		// listing is only marked, on the query itself rather than through a filter that scans the cache.
		const invalidate = (): void => {
			// A walk that began after this event arrived already reads what it changed.
			if (query.state.fetchStatus !== "idle" && typeof rootUuid === "string" && (walkStartSeq.get(rootUuid) ?? -1) >= seq) {
				return
			}

			invalidateJoiningInFlight(query)
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

// A dropped socket may have missed events: mark every listing stale without refetching while the socket
// is down. The next mount, focus or event reads it again, and the scoping above stays off until it has.
export function markPhotosListingStale(): void {
	void queryClient.invalidateQueries({ queryKey: PHOTOS_LISTING_KEY_PREFIX, refetchType: "none" })
}
