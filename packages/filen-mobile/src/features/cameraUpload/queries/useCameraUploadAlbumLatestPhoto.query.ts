import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import * as MediaLibraryLegacy from "expo-media-library/legacy"

export const BASE_QUERY_KEY = "useCameraUploadAlbumLatestPhotoQuery"

// One native call per album row, so keep results fresh-enough for a few
// minutes instead of refetching on every mount/focus — the screen is a picker,
// not a live gallery. The call itself is cheap by construction: a single-page
// (first: 1), photo-only, creationTime-descending fetch resolved natively.
const STALE_TIME_MS = 5 * 60 * 1000

export async function fetchData(albumId: string, _signal?: AbortSignal): Promise<string | null> {
	const page = await MediaLibraryLegacy.getAssetsAsync({
		album: albumId,
		first: 1,
		mediaType: [MediaLibraryLegacy.MediaType.photo],
		sortBy: [[MediaLibraryLegacy.SortBy.creationTime, false]]
	})

	return page.assets.at(0)?.uri ?? null
}

export function useCameraUploadAlbumLatestPhotoQuery({
	albumId
}: {
	albumId: string
}): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery<Awaited<ReturnType<typeof fetchData>>, Error>({
		staleTime: STALE_TIME_MS,
		queryKey: [BASE_QUERY_KEY, albumId],
		queryFn: ({ signal }) => fetchData(albumId, signal)
	})

	return query
}

export default useCameraUploadAlbumLatestPhotoQuery
