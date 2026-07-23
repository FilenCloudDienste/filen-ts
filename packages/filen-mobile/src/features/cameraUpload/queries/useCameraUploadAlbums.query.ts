import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import * as MediaLibraryLegacy from "expo-media-library/legacy"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { Semaphore } from "@filen/utils"

export const BASE_QUERY_KEY = "useCameraUploadAlbumsQuery"

export async function fetchData(_signal?: AbortSignal) {
	const permissions = await hasAllNeededMediaPermissions({ library: "all", needCamera: false })

	if (!permissions) {
		return [] as MediaLibraryLegacy.Album[]
	}

	const albums = await MediaLibraryLegacy.getAlbumsAsync({
		includeSmartAlbums: true
	})

	// Albums are raw OS collections — on Android that means ANY MediaStore bucket, so
	// audio-only directories (music, recordings, voice notes) arrive here too, and
	// assetCount totals every media type in the bucket. Camera upload only ever syncs
	// photos and videos, so re-count each album against that filter: albums with nothing
	// syncable are dropped, and the count the screen sorts/badges by becomes the filtered
	// total instead of the misleading bucket total. A failed probe keeps the album with
	// its original count (fail open — never hide an album over a transient query error).
	// Bounded concurrency keeps devices with many albums from firing dozens of media-store
	// queries at once.
	const semaphore = new Semaphore(4)

	const counted = await Promise.all(
		albums.map(async album => {
			if (album.assetCount <= 0) {
				return null
			}

			await semaphore.acquire()

			try {
				const { totalCount } = await MediaLibraryLegacy.getAssetsAsync({
					album,
					mediaType: [MediaLibraryLegacy.MediaType.photo, MediaLibraryLegacy.MediaType.video],
					first: 1
				})

				if (totalCount <= 0) {
					return null
				}

				return {
					...album,
					assetCount: totalCount
				}
			} catch {
				return album
			} finally {
				semaphore.release()
			}
		})
	)

	return counted.filter((album): album is MediaLibraryLegacy.Album => album !== null)
}

export function useCameraUploadAlbumsQuery(
	options?: Omit<UseQueryOptions<Awaited<ReturnType<typeof fetchData>>, Error>, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery<Awaited<ReturnType<typeof fetchData>>, Error>({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) => fetchData(signal)
	})

	return query
}

// CU-11: this query intentionally has NO imperative cache updater. The album list is OS-derived
// (expo-media-library) and read-only — there is no producer that should ever write it, and it always
// refetches (refetchOnMount/Focus: "always" via DEFAULT_QUERY_OPTIONS, plus an AppState-active
// refetch in the albums screen). A queryUpdater.set here would race that always-on refetch and could
// clobber the freshly enumerated list, so it is deliberately omitted (was previously dead code).
export default useCameraUploadAlbumsQuery
