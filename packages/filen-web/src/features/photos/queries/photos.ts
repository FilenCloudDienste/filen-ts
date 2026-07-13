import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
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

// The recursive walk (listPhotosRecursive) plus the media predicate and capture-date sort, all in one
// queryFn — a photos listing has exactly one consumer shape (the grid), so there is no separate
// selector layer filtering/sorting on every render the way a multi-mode drive listing would need.
export async function fetchPhotosListing(rootUuid: string): Promise<PhotoItem[]> {
	const { dirs, files } = await sdkApi.listPhotosRecursive(rootUuid)
	const items: DriveItem[] = [...dirs.map(narrowItem), ...files.map(narrowItem)]
	const photos = items.filter(isPhotoItem) as PhotoItem[]

	return sortPhotosByCaptureDesc(photos)
}

export function usePhotosListingQuery(rootUuid: string | null): UseQueryResult<PhotoItem[]> {
	return useQuery({
		queryKey: photosListingQueryKey(rootUuid ?? ""),
		queryFn: () => fetchPhotosListing(rootUuid ?? ""),
		enabled: rootUuid !== null
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

	if (queryClient.getQueryData(queryKey) !== undefined) {
		void queryClient.cancelQueries({ queryKey })
	}

	queryClient.setQueryData<PhotoItem[]>(queryKey, prev => (prev === undefined ? prev : updater(prev)))
}

// Coarse, cheap invalidation (see socketHandlers.ts's own call site for which drive events trigger
// this): refetches the WHOLE recursive walk rather than attempting to splice-patch a socket event's
// single item into a listing that may or may not even contain it (a photo three subdirectories under
// the root has no cheap membership test from a bare uuid/parent payload). A no-op when no photos
// query is mounted — invalidateQueries against an absent key does nothing.
export function invalidatePhotosListing(): void {
	void queryClient.invalidateQueries({ queryKey: ["photos", "listing"] })
}
