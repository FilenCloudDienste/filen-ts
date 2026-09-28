import { toast } from "sonner"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { queueTracksFromPlaylist } from "@/features/audio/lib/playlists"
import type { Playlist } from "@filen/shared"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"

// Thin glue between the playlist data layer and the playback engine singleton — split out of
// playlists.ts specifically so that module stays free of audioEngine's import-time side effects
// (real playback wiring, media-session bridge, kv prefs hydration) and trivially unit-testable in
// node. UI components import from HERE for "play"/"shuffle play", not from playlists.ts directly.

// "Play" — replaces the queue with the whole playlist, positioned at `startIndex` (row click-to-play,
// mobile #49 semantics: opening a track from a list enqueues the list, positioned at that track).
// Respects whatever the global shuffle toggle is currently set to, same as any other queue replacement.
export function playPlaylistFrom(playlist: Playlist, startIndex: number): Promise<void> {
	const tracks = queueTracksFromPlaylist(playlist)

	return tracks.length === 0 ? Promise.resolve() : audioEngine.enqueueAndPlay(tracks, startIndex)
}

// "Shuffle play" — an explicit action distinct from the global shuffle toggle: turns shuffle ON (if it
// wasn't already) as part of replacing the queue from the top, so the resulting play order is shuffled
// regardless of whatever the toggle was set to beforehand. Not setShuffleEnabled first: that would warm
// the next track of the queue about to be replaced.
export function shufflePlayPlaylist(playlist: Playlist): Promise<void> {
	const tracks = queueTracksFromPlaylist(playlist)

	return tracks.length === 0 ? Promise.resolve() : audioEngine.enqueueAndPlay(tracks, 0, { shuffle: true })
}

// Fire-and-forget forms of the two above for click handlers, a failure surfacing as a toast.
export function startPlaylist(playlist: Playlist, startIndex: number): void {
	void playPlaylistFrom(playlist, startIndex).catch((error: unknown) => {
		toast.error(errorLabel(asErrorDTO(error)))
	})
}

export function startShuffledPlaylist(playlist: Playlist): void {
	void shufflePlayPlaylist(playlist).catch((error: unknown) => {
		toast.error(errorLabel(asErrorDTO(error)))
	})
}
