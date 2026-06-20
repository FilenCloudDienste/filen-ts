import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import * as MediaLibraryLegacy from "expo-media-library/legacy"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"

export const BASE_QUERY_KEY = "useCameraUploadAlbumsQuery"

export async function fetchData(_signal?: AbortSignal) {
	const permissions = await hasAllNeededMediaPermissions({ library: "all", needCamera: false })

	if (!permissions) {
		return [] as MediaLibraryLegacy.Album[]
	}

	return await MediaLibraryLegacy.getAlbumsAsync({
		includeSmartAlbums: true
	})
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
