import { createVideoPlayer, type VideoPlayer } from "expo-video"

// Native players hold decode buffers (tens of MB each) — cap how many stay
// alive. The cap preserves resume-position for the realistic back-and-forth
// pattern while bounding memory in video-heavy directories; only videos this
// many pages back lose their position and start over.
export const MAX_GALLERY_VIDEO_PLAYERS = 4

/**
 * Video players owned by the gallery SESSION instead of the video cells.
 *
 * The carousel remounts on rotation (see gallery.tsx — keyed by width), so a
 * cell-owned player (useVideoPlayer) would be torn down and playback would
 * restart from zero. Re-attaching the surviving player to the remounted
 * VideoView continues playback seamlessly instead — and paging back to a
 * video resumes it from where it was left, scoped to the gallery session.
 *
 * Like useVideoPlayer, the source is initial-only: a later fileUrl for the
 * same item does not re-resolve into the existing player.
 */
export class GalleryVideoPlayers {
	private players = new Map<string, VideoPlayer>()

	public acquire({ key, fileUrl }: { key: string; fileUrl: string }): VideoPlayer {
		const existing = this.players.get(key)

		if (existing) {
			// Map insertion order doubles as the LRU order — re-insert on access
			// so the active item's player is always the most recent.
			this.players.delete(key)
			this.players.set(key, existing)

			return existing
		}

		if (this.players.size >= MAX_GALLERY_VIDEO_PLAYERS) {
			const oldestKey = this.players.keys().next().value

			if (oldestKey !== undefined) {
				const oldest = this.players.get(oldestKey)

				this.players.delete(oldestKey)

				try {
					oldest?.release()
				} catch {
					// already released
				}
			}
		}

		const player = createVideoPlayer(fileUrl)

		player.loop = false
		player.staysActiveInBackground = false

		player.play()

		this.players.set(key, player)

		return player
	}

	// The pager settled on a different item — stop everything that is no longer
	// front and center. Players stay alive (and resume from their position if
	// the user pages back); they are only destroyed in releaseAll().
	public pauseAllExcept(key: string | null): void {
		for (const [playerKey, player] of this.players) {
			if (playerKey === key) {
				continue
			}

			try {
				player.pause()
			} catch {
				// released natively already — nothing to pause
			}
		}
	}

	public releaseAll(): void {
		for (const player of this.players.values()) {
			try {
				player.release()
			} catch {
				// already released
			}
		}

		this.players.clear()
	}
}

export default new GalleryVideoPlayers()
