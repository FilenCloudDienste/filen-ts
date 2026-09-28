import { describe, expect, it, vi } from "vitest"
import type { Playlist } from "@filen/shared"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

// The real audioEngine singleton wires DOM/media-session/kv side effects on import, and playlists.ts pulls
// in the sdk client's worker — both mocked at their boundaries.
const { audioEngine, queueTracksFromPlaylist } = vi.hoisted(() => ({
	audioEngine: {
		setShuffleEnabled: vi.fn(),
		enqueueAndPlay: vi.fn().mockResolvedValue(undefined)
	},
	queueTracksFromPlaylist: vi.fn()
}))

vi.mock("@/features/audio/lib/audioEngine", () => ({ audioEngine }))
vi.mock("@/features/audio/lib/playlists", () => ({ queueTracksFromPlaylist }))

const { shufflePlayPlaylist } = await import("@/features/audio/lib/playlistPlayback")

const playlist = {} as unknown as Playlist
const tracks = [{ uuid: "a" }, { uuid: "b" }] as unknown as QueueTrack[]

describe("shufflePlayPlaylist", () => {
	// Toggling shuffle first would warm the next track of the queue about to be replaced.
	it("turns shuffle on inside the queue swap, never through the toggle", async () => {
		queueTracksFromPlaylist.mockReturnValueOnce(tracks)

		await shufflePlayPlaylist(playlist)

		expect(audioEngine.enqueueAndPlay).toHaveBeenCalledExactlyOnceWith(tracks, 0, { shuffle: true })
		expect(audioEngine.setShuffleEnabled).not.toHaveBeenCalled()
	})

	it("touches neither the queue nor the shuffle flag for an empty playlist", async () => {
		queueTracksFromPlaylist.mockReturnValueOnce([])

		await shufflePlayPlaylist(playlist)

		expect(audioEngine.enqueueAndPlay).not.toHaveBeenCalled()
		expect(audioEngine.setShuffleEnabled).not.toHaveBeenCalled()
	})
})
