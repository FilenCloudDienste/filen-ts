import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryClient, queryUpdater } from "@/queries/client"
import { driveContentChangedSince } from "@/lib/driveChanges"
import audio from "@/features/audio/audio"
import cache from "@/lib/cache"
import { type DriveItemFileExtracted } from "@/types"

export const BASE_QUERY_KEY = "usePlaylistsQuery"

// A read is 3 listDirs, one download per playlist and one existence check per track, and no socket
// covers playlists, so a mount rereads only once the list is a minute old or the drive changed
// since (a deleted track must drop out). Local edits patch the cache; pull-to-refresh always reads.
const PLAYLISTS_STALE_TIME = 60 * 1000

/**
 * Seeds a playlist track so the audioMetadata query — which resolves each file by uuid FROM this
 * cache — can find it.
 *
 * Only fills a GAP. A playlist track is rebuilt from the playlist file itself (see
 * playlistFileToDriveItem), so it carries no whole-life id; letting it overwrite an entry that came
 * from a real listing would hand every cache reader an item the SDK refuses to mutate
 * (ErrorKind.MissingStableUuid) — the public-link screen prefers this cache over its own route item.
 */
function seedTrackIfUncached(item: DriveItemFileExtracted): void {
	if (cache.uuidToAnyDriveItem.has(item.data.uuid)) {
		return
	}

	cache.uuidToAnyDriveItem.set(item.data.uuid, item)
}

export async function fetchData(params?: { signal?: AbortSignal }) {
	const playlists = await audio.getPlaylists(params?.signal)

	for (const playlist of playlists) {
		for (const { item } of playlist.files) {
			seedTrackIfUncached(item)
		}
	}

	return playlists
}

export function usePlaylistsQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		staleTime: PLAYLISTS_STALE_TIME,
		refetchOnMount: q => (driveContentChangedSince(q.state.dataUpdatedAt) ? "always" : true),
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
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>(
		[BASE_QUERY_KEY],
		prev => {
			const next = typeof updater === "function" ? updater(prev ?? []) : updater

			// Keep cache.uuidToAnyDriveItem in sync with the list query (mirrors fetchData). The audio
			// metadata query resolves each file by uuid FROM this cache, so an optimistically-updated
			// playlist's files must be seeded here too, not only on the next refetch.
			for (const playlist of next) {
				for (const { item } of playlist.files ?? []) {
					seedTrackIfUncached(item)
				}
			}

			return next
		},
		// Keep the last read's time: an edit makes one playlist current, not every other playlist or
		// track check. Never read yet (0): the list holds only local edits, so the first mount reads.
		queryClient.getQueryState([BASE_QUERY_KEY])?.dataUpdatedAt ?? 0
	)
}

export function playlistsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default usePlaylistsQuery
