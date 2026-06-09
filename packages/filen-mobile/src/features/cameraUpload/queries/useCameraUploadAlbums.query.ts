import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
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

export function cameraUploadAlbumsQueryUpdate({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY], prev => {
		return typeof updater === "function" ? updater(prev ?? []) : updater
	})
}

export function cameraUploadAlbumsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useCameraUploadAlbumsQuery
