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

// Bumped by every cache patch. A read one overlapped may hold a playlist from before that patch's save.
let patchCount = 0
// When the last read no patch overlapped began; null while there is none. Freshness counts from a read's
// start: a save made while it ran is after it, whatever it fetched.
let cleanReadStartedAt: number | null = null

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
	const startedAt = Date.now()
	const patchesBefore = patchCount
	const playlists = await audio.getPlaylists(params?.signal)

	for (const playlist of playlists) {
		for (const { item } of playlist.files) {
			seedTrackIfUncached(item)
		}
	}

	cleanReadStartedAt = patchCount === patchesBefore ? startedAt : null

	return playlists
}

// The cached list is that clean read's (not a restored row, nor an older read it never replaced), no
// read failed since, it is under a minute old, and the drive hasn't changed since it began.
function cachedReadReusable(state: { dataUpdatedAt: number; isInvalidated: boolean }): boolean {
	return (
		cleanReadStartedAt !== null &&
		state.dataUpdatedAt >= cleanReadStartedAt &&
		!state.isInvalidated &&
		Date.now() - cleanReadStartedAt < PLAYLISTS_STALE_TIME &&
		!driveContentChangedSince(cleanReadStartedAt)
	)
}

export function usePlaylistsQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		staleTime: PLAYLISTS_STALE_TIME,
		refetchOnMount: q => (cachedReadReusable(q.state) ? false : "always"),
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
	updater,
	keepInFlightRead
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
	// For the dead-track prune, which patches during its own read: that read already leaves them out.
	keepInFlightRead?: boolean
}) {
	patchCount++

	const state = queryClient.getQueryState([BASE_QUERY_KEY])

	// A read in flight would land after this patch and overwrite it with what it fetched before the save
	// behind it, and the next edit would build on that. Cancelled, so the cached list comes back and the
	// patch applies to it; a first read (nothing cached yet) still lands.
	if (!keepInFlightRead && state?.data !== undefined && state.fetchStatus !== "idle") {
		void queryClient.cancelQueries({
			queryKey: [BASE_QUERY_KEY],
			exact: true
		})
	}

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
