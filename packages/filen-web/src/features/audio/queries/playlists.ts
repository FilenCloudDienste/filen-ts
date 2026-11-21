import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { patchQuery, replaceOrAppend } from "@/queries/patch"
import { fetchPlaylistEntries, isSettledPlaylistEntry } from "@/features/audio/lib/playlists"
import { comparePlaylists, compareNamesThenIds, type Playlist } from "@filen/shared"

// One global playlists list query — the playlists sidebar and screen (and the add-tracks picker they
// open) and the assistant's tools all read this one cache slice, same one-list-per-session rationale as
// NOTES_QUERY_KEY/CONTACTS_QUERY_KEY.
export const PLAYLISTS_QUERY_KEY = ["audio", "playlists"] as const

// A row this list can render: a successfully parsed playlist, or a degraded placeholder for a
// `${uuid}.json` file that failed to download/parse — isolated per file (features/audio/lib/playlists.ts's
// fetchPlaylistEntries), never collapsing the whole screen. `fileUuid` is the DRIVE file's uuid (the
// only identity available for a file whose body never parsed enough to yield the playlist's OWN uuid).
export type PlaylistEntry = { status: "ok"; playlist: Playlist } | { status: "degraded"; fileUuid: string; name: string }

// The list's one order, applied to every read and patch so the cache always holds it and no render sorts:
// playlists by comparePlaylists, then the degraded rows by name and file uuid. Never the listing's order,
// which changes whenever a save rewrites a file.
export function comparePlaylistEntries(a: PlaylistEntry, b: PlaylistEntry): number {
	if (a.status === "ok") {
		return b.status === "ok" ? comparePlaylists(a.playlist, b.playlist) : -1
	}

	return b.status === "ok" ? 1 : compareNamesThenIds(a.name, a.fileUuid, b.name, b.fileUuid)
}

// A read downloads every playlist file in full. Same-tab writes patch the cache and the socket marks it
// unsynced when anything else touches the Playlists directory (features/audio/lib/socketHandlers.ts), so
// a synced cache holds across mounts, focus and reconnect; the window backstops a change no event
// reported. Unsynced — no clean read yet in the current socket session, or a signal since the last one —
// it refetches like any staleTime-0 query.
export const PLAYLISTS_STALE_TIME = 15 * 60 * 1000

let unsyncSignals = 0
// The signal count and socket epoch the last read began under; the count is -1 when that read wasn't
// clean or none has run (a restored cache predates this tab's socket, so it vouches for nothing). A read
// the socket wasn't live for throughout is not clean: an event it needed may never have been delivered.
let syncedAtSignal = -1
let syncedEpoch: number | null = null
// Bumped by every cache patch: one landing mid-read cancels it or is overwritten by it.
let patchCount = 0

export function markPlaylistsUnsynced(): void {
	unsyncSignals++
}

async function fetchPlaylistsQuery(): Promise<PlaylistEntry[]> {
	const signals = unsyncSignals
	const patches = patchCount
	const epoch = currentSocketEpoch()
	const entries = (await fetchPlaylistEntries()).sort(comparePlaylistEntries)

	// A degraded row may be a transient download failure — keep retrying it on mount/focus as before, even
	// after an earlier clean read. One whose bytes do not parse reads the same every time, so it does not.
	if (patchCount === patches) {
		syncedAtSignal = socketLiveSince(epoch) && entries.every(isSettledPlaylistEntry) ? signals : -1
		syncedEpoch = epoch
	}

	return entries
}

function playlistsStaleTime(): number {
	return syncedAtSignal === unsyncSignals && socketLiveSince(syncedEpoch) ? PLAYLISTS_STALE_TIME : 0
}

export function usePlaylistsQuery(): UseQueryResult<PlaylistEntry[]> {
	return useQuery({
		queryKey: PLAYLISTS_QUERY_KEY,
		queryFn: fetchPlaylistsQuery,
		staleTime: playlistsStaleTime
	})
}

// The list for a caller outside the playlist screens (the assistant), under the same key and freshness.
export function playlistsQueryRead(): Promise<PlaylistEntry[]> {
	return queryClient.query({
		queryKey: PLAYLISTS_QUERY_KEY,
		queryFn: fetchPlaylistsQuery,
		staleTime: playlistsStaleTime
	})
}

export function playlistsQueryUpdate(updater: (prev: PlaylistEntry[]) => PlaylistEntry[]): void {
	patchCount++
	patchQuery<PlaylistEntry[]>(PLAYLISTS_QUERY_KEY, prev => {
		const base = prev ?? []
		const next = updater(base)

		// An updater that changed nothing hands back the cached array, already in order: never sort it in place.
		return next === base ? next : next.sort(comparePlaylistEntries)
	})
}

// Replaces (or appends) a single playlist's "ok" row by uuid, then the patch puts it in its place —
// the write path's confirm-then-patch after a successful create/rename/add/remove/reorder/prune save.
export function playlistsQueryUpsert(playlist: Playlist): void {
	playlistsQueryUpdate(prev =>
		replaceOrAppend(prev, { status: "ok", playlist }, entry => entry.status === "ok" && entry.playlist.uuid === playlist.uuid)
	)
}

export function playlistsQueryRemove(uuid: string): void {
	playlistsQueryUpdate(prev => prev.filter(entry => !(entry.status === "ok" && entry.playlist.uuid === uuid)))
}

// Synchronous cache read for a caller that needs the current list without subscribing via the hook —
// mirrors notesQueryGet's own rationale (playlists.ts's freshest-copy recompose reads this directly).
export function playlistsQueryGet(): PlaylistEntry[] | undefined {
	return queryClient.getQueryData<PlaylistEntry[]>(PLAYLISTS_QUERY_KEY)
}
