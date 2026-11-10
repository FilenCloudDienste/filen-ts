import type { Playlist } from "@filen/shared"
import type { PlaylistEntry } from "@/features/audio/queries/playlists"
import { hasClosest } from "@/lib/domTarget"

// The sidebar row's marker: the uuid of the playlist it names (playlistsSidebar.tsx).
export const PLAYLIST_ROW_ATTRIBUTE = "data-playlist-uuid"

// A playlist command's target: the playlist whose sidebar row holds focus (a keyboard user tabbing down the list acts
// on the row they are on, as its ⋯ menu would), else the one on screen. A degraded row, or one no longer listed,
// falls back to the one on screen too.
export function playlistForKeyTarget(
	entries: readonly PlaylistEntry[],
	shown: Playlist | null,
	target: EventTarget | null
): Playlist | null {
	const row = hasClosest(target) ? target.closest(`[${PLAYLIST_ROW_ATTRIBUTE}]`) : null
	const uuid = row?.getAttribute(PLAYLIST_ROW_ATTRIBUTE)

	if (uuid === null || uuid === undefined) {
		return shown
	}

	for (const entry of entries) {
		if (entry.status === "ok" && entry.playlist.uuid === uuid) {
			return entry.playlist
		}
	}

	return shown
}

// The track table row's marker: the uuid of its track (playlistPane.tsx).
export const TRACK_ROW_ATTRIBUTE = "data-track-uuid"

// The track whose row a key was pressed in, or null outside every track row.
export function trackUuidOf(target: EventTarget | null): string | null {
	return hasClosest(target) ? (target.closest(`[${TRACK_ROW_ATTRIBUTE}]`)?.getAttribute(TRACK_ROW_ATTRIBUTE) ?? null) : null
}

// The track a move swaps places with: the one `step` rows away from `uuid`, or null at either end (or for a track no
// longer listed).
export function trackMoveTarget(playlist: Playlist, uuid: string, step: -1 | 1): string | null {
	const index = playlist.files.findIndex(file => file.uuid === uuid)

	if (index === -1) {
		return null
	}

	return playlist.files[index + step]?.uuid ?? null
}
