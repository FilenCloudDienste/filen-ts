import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import audio from "@/features/audio/audio"
import cache from "@/lib/cache"

export const BASE_QUERY_KEY = "usePlaylistsQuery"

export async function fetchData(params?: { signal?: AbortSignal }) {
	const playlists = await audio.getPlaylists(params?.signal)

	for (const playlist of playlists) {
		for (const { item } of playlist.files) {
			// We need to cache it here for the audioMetadata query to work later, since it relies on the cache

			cache.uuidToAnyDriveItem.set(item.data.uuid, item)
		}
	}

	return playlists
}

export function usePlaylistsQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) =>
			fetchData({
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function playlistsQueryUpdate({
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

export function playlistsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default usePlaylistsQuery
