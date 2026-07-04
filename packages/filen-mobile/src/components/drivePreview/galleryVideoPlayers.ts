import { createVideoPlayer, type VideoPlayer } from "expo-video"
import usePipStore from "@/stores/usePip.store"
import events from "@/lib/events"

// Silence + free a session player. `release()` alone is NOT enough on iOS: `VideoView.player` is a
// WEAK ref, so the AVPlayer's audio only stops in the VideoPlayer's deinit (replaceCurrentItem nil).
// release() merely drops the JS handle — if any native holder lingers (NowPlayingManager, or the
// AVPictureInPictureController that allowsPictureInPicture=true now creates), dealloc is deferred and
// the AVPlayer keeps playing (audible for minutes after the gallery is dismissed — reliably after a
// swipe-away-and-back leaves an extra playerViewController retaining it). Pausing first stops the
// audio immediately regardless of when the object finally deallocs. Android already tears the
// ExoPlayer down synchronously in release(), so pause() there is a harmless no-op.
function stopAndRelease(player: VideoPlayer): void {
	try {
		player.pause()
	} catch {
		// released natively already — nothing to pause
	}

	try {
		player.release()
	} catch {
		// already released
	}
}

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
			// Never evict the player presented in the system PiP window — releasing it kills the
			// floating window mid-playback (spec: docs/pip-video-player.md §5.7).
			const pipActiveKey = usePipStore.getState().activeKey
			let oldestKey: string | undefined = undefined

			for (const candidateKey of this.players.keys()) {
				if (candidateKey !== pipActiveKey) {
					oldestKey = candidateKey

					break
				}
			}

			if (oldestKey !== undefined) {
				const oldest = this.players.get(oldestKey)

				this.players.delete(oldestKey)

				if (oldest) {
					stopAndRelease(oldest)
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
	// the user pages back); they are only destroyed in releaseAll(). The PiP
	// player is exempt: during iOS in-app PiP the pager stays scrollable, and
	// settling elsewhere must not pause the floating window (spec §5.7).
	public pauseAllExcept(key: string | null): void {
		const pipActiveKey = usePipStore.getState().activeKey

		for (const [playerKey, player] of this.players) {
			if (playerKey === key || playerKey === pipActiveKey) {
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
			stopAndRelease(player)
		}

		this.players.clear()

		// Releasing the players closes any system PiP window with them — end the session signal
		// so the provider teardown and the biometric lock re-arm (spec §5.2 defensive clears).
		usePipStore.getState().setActiveKey(null)
	}
}

const galleryVideoPlayers = new GalleryVideoPlayers()

// Logout wipes decrypted state and destroys the SDK client mid-stream — release the players (which
// also closes any PiP window on both platforms; Android has no stopPictureInPicture API) instead of
// leaving the floating window over a dead stream. Subscribed here (not called from lib/auth) so the
// auth module never has to import expo-video-backed component modules (spec §5.7).
events.subscribe("logout", () => {
	galleryVideoPlayers.releaseAll()
})

export default galleryVideoPlayers
