import type { PlaylistEntry } from "@/features/audio/queries/playlists"
import type { Playlist } from "@filen/shared"

// The playlist the /playlists split view shows, shared by the sidebar (highlight) and the pane (body)
// so both always agree. No param, a stale one (deleted, or from another account) or a degraded row
// falls back to the first playlist that parsed — resolved in render, never by redirecting.
export function resolveSelectedPlaylist(entries: readonly PlaylistEntry[], uuid: string | undefined): Playlist | null {
	let first: Playlist | null = null

	for (const entry of entries) {
		if (entry.status !== "ok") {
			continue
		}

		if (entry.playlist.uuid === uuid) {
			return entry.playlist
		}

		first ??= entry.playlist
	}

	return first
}
