import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { fetchDirectoryListing } from "@/features/drive/queries/drive"
import type { DriveItem } from "@/features/drive/lib/item"

// Owns the photos query-key namespace (["photos", …], per client.ts's [domain, entity, params?]
// taxonomy) — separate from ["drive", "listing", …] because a local mutation (favorite/trash/rename)
// on a photos tile must patch THIS key, not drive's own (driveListingQueryUpdate only ever touches
// ["drive", …] keys). That patch helper is Wave 2's concern; this step only needs the key shape to
// be stable ahead of it.
export function photosListingQueryKey(rootUuid: string) {
	return ["photos", "listing", rootUuid] as const
}

// Wave-1 placeholder queryFn: a single-level listing of the chosen root, reused unchanged from the
// drive feature's own fetcher (fetchDirectoryListing("drive", uuid) already resolves the uuid the
// same way listDirectory's "uuid" branch does, so a gone root surfaces the exact
// DIRECTORY_NOT_FOUND_PREFIX error features/photos/lib/root.ts's isRootGoneError keys off). Wave 2
// swaps only this function's body for the real recursive listPhotosRecursive worker op — the query
// KEY above, and every consumer reading this hook's status/error, stay unchanged.
export async function fetchPhotosListing(rootUuid: string): Promise<DriveItem[]> {
	return await fetchDirectoryListing("drive", rootUuid)
}

export function usePhotosListingQuery(rootUuid: string | null): UseQueryResult<DriveItem[]> {
	return useQuery({
		queryKey: photosListingQueryKey(rootUuid ?? ""),
		queryFn: () => fetchPhotosListing(rootUuid ?? ""),
		enabled: rootUuid !== null
	})
}
