import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { patchQuery } from "@/queries/patch"
import { fetchPlaylistEntries } from "@/features/audio/lib/playlists"
import type { Playlist } from "@filen/shared"

// One global playlists list query — every playlist surface (the now-playing panel's Playlists tab, a
// playlist detail dialog, the add-tracks picker's "already in this playlist" check) reads this one
// cache slice, same one-list-per-session rationale as NOTES_QUERY_KEY/CONTACTS_QUERY_KEY.
export const PLAYLISTS_QUERY_KEY = ["audio", "playlists"] as const

// A row this list can render: a successfully parsed playlist, or a degraded placeholder for a
// `${uuid}.json` file that failed to download/parse — isolated per file (features/audio/lib/playlists.ts's
// fetchPlaylistEntries), never collapsing the whole screen. `fileUuid` is the DRIVE file's uuid (the
// only identity available for a file whose body never parsed enough to yield the playlist's OWN uuid).
export type PlaylistEntry = { status: "ok"; playlist: Playlist } | { status: "degraded"; fileUuid: string; name: string }

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
	const entries = await fetchPlaylistEntries()

	// A degraded row may be a transient download failure — keep retrying it on mount/focus as before, even
	// after an earlier clean read.
	if (patchCount === patches) {
		syncedAtSignal = socketLiveSince(epoch) && entries.every(entry => entry.status === "ok") ? signals : -1
		syncedEpoch = epoch
	}

	return entries
}

export function usePlaylistsQuery(): UseQueryResult<PlaylistEntry[]> {
	return useQuery({
		queryKey: PLAYLISTS_QUERY_KEY,
		queryFn: fetchPlaylistsQuery,
		staleTime: () => (syncedAtSignal === unsyncSignals && socketLiveSince(syncedEpoch) ? PLAYLISTS_STALE_TIME : 0)
	})
}

export function playlistsQueryUpdate(updater: (prev: PlaylistEntry[]) => PlaylistEntry[]): void {
	patchCount++
	patchQuery<PlaylistEntry[]>(PLAYLISTS_QUERY_KEY, prev => updater(prev ?? []))
}

// Replaces (or appends) a single playlist's "ok" row by uuid, preserving every other row's position —
// the write path's confirm-then-patch after a successful create/rename/add/remove/reorder/prune save.
export function playlistsQueryUpsert(playlist: Playlist): void {
	playlistsQueryUpdate(prev => {
		const index = prev.findIndex(entry => entry.status === "ok" && entry.playlist.uuid === playlist.uuid)

		if (index === -1) {
			return [...prev, { status: "ok", playlist }]
		}

		const next = prev.slice()

		next[index] = { status: "ok", playlist }

		return next
	})
}

export function playlistsQueryRemove(uuid: string): void {
	playlistsQueryUpdate(prev => prev.filter(entry => !(entry.status === "ok" && entry.playlist.uuid === uuid)))
}

// Synchronous cache read for a caller that needs the current list without subscribing via the hook —
// mirrors notesQueryGet's own rationale (playlists.ts's freshest-copy recompose reads this directly).
export function playlistsQueryGet(): PlaylistEntry[] | undefined {
	return queryClient.getQueryData<PlaylistEntry[]>(PLAYLISTS_QUERY_KEY)
}
