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

type Playlists = Awaited<ReturnType<typeof audio.getPlaylists>>
type PlaylistsUpdater = Playlists | ((prev: Playlists) => Playlists)

// Bumped by every cache patch.
let patchCount = 0
// The patches made while a read was out, in order, with the patchCount each bumped to. A read may have
// fetched a playlist before the save behind one, so it applies those made after it began to what it
// fetched: no patch is lost to a read, and no read is cancelled or repeated for one.
let patchesDuringReads: { count: number; updater: PlaylistsUpdater }[] = []
let readsInFlight = 0
// The patchCount of each playlist's latest save or delete here.
const lastPatchOf = new Map<string, number>()
// When the last read no patch overlapped began; null while there is none. Freshness counts from a read's
// start: a save made while it ran is after it, whatever it fetched. A read a patch overlapped holds the
// patch in place of its own copy of that playlist, which may be newer, so it doesn't count.
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

function applyPatchesSince(count: number, playlists: Playlists): Playlists {
	let next = playlists

	for (const patch of patchesDuringReads) {
		if (patch.count > count) {
			next = typeof patch.updater === "function" ? patch.updater(next) : patch.updater
		}
	}

	return next
}

export async function fetchData(params?: { signal?: AbortSignal }) {
	const startedAt = Date.now()
	const patchesBefore = patchCount

	readsInFlight++

	try {
		const fetched = await audio.getPlaylists(params?.signal)

		// Cancelled: its answer never lands, so it mustn't overwrite the freshness of the read that replaced it.
		if (params?.signal?.aborted) {
			return fetched
		}

		const playlists = applyPatchesSince(patchesBefore, fetched)

		for (const playlist of playlists) {
			for (const { item } of playlist.files) {
				seedTrackIfUncached(item)
			}
		}

		cleanReadStartedAt = patchCount === patchesBefore ? startedAt : null

		return playlists
	} finally {
		readsInFlight--

		if (readsInFlight === 0) {
			patchesDuringReads = []
		}
	}
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

// The playlists a patch saved or deleted: the ones it replaced, added or dropped.
function notePatchedPlaylists(prev: Playlists, next: Playlists, count: number): void {
	const before = new Map(prev.map(playlist => [playlist.uuid, playlist]))

	for (const playlist of next) {
		if (before.get(playlist.uuid) !== playlist) {
			lastPatchOf.set(playlist.uuid, count)
		}

		before.delete(playlist.uuid)
	}

	for (const uuid of before.keys()) {
		lastPatchOf.set(uuid, count)
	}
}

// For a read as it begins: whether a playlist is saved or deleted here after that.
export function playlistPatchedSinceNow(): (uuid: string) => boolean {
	const since = patchCount

	return uuid => (lastPatchOf.get(uuid) ?? 0) > since
}

export function playlistsQueryUpdate({ updater }: { updater: PlaylistsUpdater }) {
	patchCount++

	const count = patchCount

	if (readsInFlight > 0) {
		patchesDuringReads.push({ count, updater })
	}

	queryUpdater.set<Playlists>(
		[BASE_QUERY_KEY],
		prev => {
			const before = prev ?? []
			const next = typeof updater === "function" ? updater(before) : updater

			notePatchedPlaylists(before, next, count)

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
