import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import { fetchPlaylistEntries } from "@/features/audio/lib/playlists"
import type { Playlist } from "@/features/audio/lib/playlistSchema"

// One global playlists list query — every playlist surface (the now-playing panel's Playlists tab, a
// playlist detail dialog, the add-tracks picker's "already in this playlist" check) reads this one
// cache slice, same one-list-per-session rationale as NOTES_QUERY_KEY/CONTACTS_QUERY_KEY.
export const PLAYLISTS_QUERY_KEY = ["audio", "playlists"] as const

// A row this list can render: a successfully parsed playlist, or a degraded placeholder for a
// `${uuid}.json` file that failed to download/parse — isolated per file (features/audio/lib/playlists.ts's
// fetchPlaylistEntries), never collapsing the whole screen. `fileUuid` is the DRIVE file's uuid (the
// only identity available for a file whose body never parsed enough to yield the playlist's OWN uuid).
export type PlaylistEntry = { status: "ok"; playlist: Playlist } | { status: "degraded"; fileUuid: string; name: string }

export function usePlaylistsQuery(): UseQueryResult<PlaylistEntry[]> {
	return useQuery({
		queryKey: PLAYLISTS_QUERY_KEY,
		queryFn: fetchPlaylistEntries
	})
}

// Cancel-before-patch WITH the initial-fetch carve-out — same rule as driveListingQueryUpdate/
// notesQueryUpdate: abort an in-flight refetch before patching (it would otherwise land after the
// patch and silently overwrite it), but only once cached data already exists, so a first-ever mount's
// initial fetch is never stranded loading forever.
function cancelInFlightIfCached(): void {
	if (queryClient.getQueryData(PLAYLISTS_QUERY_KEY) !== undefined) {
		void queryClient.cancelQueries({ queryKey: PLAYLISTS_QUERY_KEY })
	}
}

export function playlistsQueryUpdate(updater: (prev: PlaylistEntry[]) => PlaylistEntry[]): void {
	cancelInFlightIfCached()
	queryClient.setQueryData<PlaylistEntry[]>(PLAYLISTS_QUERY_KEY, prev => updater(prev ?? []))
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
