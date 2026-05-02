import { vi, describe, it, expect, beforeEach } from "vitest"

// ──────────────────────────────────────────────
// Mock player factory
// ──────────────────────────────────────────────

function makeMockPlayer() {
	return {
		addListener: vi.fn(),
		play: vi.fn(),
		pause: vi.fn(),
		replace: vi.fn(),
		seekTo: vi.fn(),
		setActiveForLockScreen: vi.fn(),
		clearLockScreenControls: vi.fn(),
		remove: vi.fn(),
		playing: false,
		paused: false,
		isLoaded: false,
		loop: false,
		currentTime: 0,
		duration: 0
	}
}

type MockPlayer = ReturnType<typeof makeMockPlayer>

let latestPlayer: MockPlayer

vi.mock("expo-audio", () => ({
	createAudioPlayer: vi.fn(() => {
		latestPlayer = makeMockPlayer()

		return latestPlayer
	}),
	setAudioModeAsync: vi.fn().mockResolvedValue(undefined)
}))

vi.mock("@/lib/audioCache", () => ({
	default: {
		get: vi.fn().mockResolvedValue({
			audio: { uri: "file:///cache/audio.mp3" },
			metadata: { title: "Test Song", artist: "Test Artist", album: "Test Album", cachedAt: Date.now() }
		})
	}
}))

vi.mock("@/lib/events", () => ({
	default: {
		emit: vi.fn(),
		subscribe: vi.fn().mockReturnValue({ remove: vi.fn() })
	}
}))

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("expo-file-system", () => ({
	Paths: {
		parse: (name: string) => ({ name: name.replace(/\.[^.]+$/, "") })
	}
}))

import type { DriveItemFileExtracted } from "@/types"
import audioCache from "@/lib/audioCache"
import events from "@/lib/events"
import { createAudioPlayer, setAudioModeAsync } from "expo-audio"

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeFileItem(uuid: string, name: string): DriveItemFileExtracted {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900,
				mime: "audio/mpeg"
			},
			size: 100n
		}
	} as unknown as DriveItemFileExtracted
}

interface AudioTestContext {
	audio: InstanceType<typeof import("@/lib/audio").Audio>
	playlist: MockPlayer
}

async function createAudio(): Promise<AudioTestContext> {
	const mod = await import("@/lib/audio")
	const audio = new (mod.Audio as new () => InstanceType<typeof mod.Audio>)()

	return {
		audio,
		playlist: latestPlayer
	}
}

function getPlaylistStatusListener(playlist: MockPlayer): ((status: Record<string, unknown>) => void) | undefined {
	const found = playlist.addListener.mock.calls.find((call: unknown[]) => call[0] === "playbackStatusUpdate")

	return found?.[1] as ((status: Record<string, unknown>) => void) | undefined
}

// ──────────────────────────────────────────────
// Reset
// ──────────────────────────────────────────────

beforeEach(() => {
	vi.mocked(audioCache.get).mockResolvedValue({
		audio: { uri: "file:///cache/audio.mp3" },
		metadata: { title: "Test Song", artist: "Test Artist", album: "Test Album", cachedAt: Date.now() }
	} as never)

	vi.mocked(events.emit).mockClear()
	vi.mocked(setAudioModeAsync).mockClear()
	vi.mocked(createAudioPlayer).mockClear()
})

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Audio", () => {
	describe("constructor", () => {
		it("creates one audio player per Audio instance", async () => {
			const { createAudioPlayer: mockCreate } = await import("expo-audio")

			// On first import, the module-level singleton also creates 1 player.
			// Take a fresh measurement after importing to isolate just our new Audio().
			await import("@/lib/audio")

			const callsBefore = vi.mocked(mockCreate).mock.calls.length

			await createAudio()

			const newCalls = vi.mocked(mockCreate).mock.calls.length - callsBefore

			// new Audio() creates exactly 1 player (queue-unified refactor)
			expect(newCalls).toBe(1)
		})

		it("calls setAudioModeAsync with background playback enabled", async () => {
			await createAudio()

			expect(setAudioModeAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					shouldPlayInBackground: true,
					playsInSilentMode: true,
					interruptionMode: "doNotMix"
				})
			)
		})
	})

	describe("addToQueue", () => {
		it("adds item to end of queue", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "song-a.mp3")

			await audio.addToQueue({ item })

			expect(audio.getQueue()).toHaveLength(1)
			expect(audio.getQueue()[0]!.item).toBe(item)
		})

		it("adds item to start of queue", async () => {
			const { audio } = await createAudio()
			const itemA = makeFileItem("a", "song-a.mp3")
			const itemB = makeFileItem("b", "song-b.mp3")

			await audio.addToQueue({ item: itemA })
			await audio.addToQueue({ item: itemB, position: "start" })

			expect(audio.getQueue()[0]!.item).toBe(itemB)
			expect(audio.getQueue()[1]!.item).toBe(itemA)
		})

		it("increments queuePosition when adding to start with existing items", async () => {
			const { audio } = await createAudio()
			const itemA = makeFileItem("a", "song-a.mp3")
			const itemB = makeFileItem("b", "song-b.mp3")

			await audio.addToQueue({ item: itemA })

			expect(audio.getQueuePosition()).toBe(0)

			await audio.addToQueue({ item: itemB, position: "start" })

			expect(audio.getQueuePosition()).toBe(1)
		})

		it("sets loading true during fetch and false after", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "song-a.mp3")

			vi.mocked(events.emit).mockClear()

			await audio.addToQueue({ item })

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("calls audioCache.get with drive-typed CacheItem", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "song-a.mp3")

			vi.mocked(audioCache.get).mockClear()

			await audio.addToQueue({ item })

			expect(audioCache.get).toHaveBeenCalledWith({
				item: {
					type: "drive",
					data: item
				}
			})
		})
	})

	describe("removeFromQueue", () => {
		it("removes item at index", async () => {
			const { audio } = await createAudio()
			const itemA = makeFileItem("a", "song-a.mp3")
			const itemB = makeFileItem("b", "song-b.mp3")

			await audio.addToQueue({ item: itemA })
			await audio.addToQueue({ item: itemB })

			audio.removeFromQueue(0)

			expect(audio.getQueue()).toHaveLength(1)
			expect(audio.getQueue()[0]!.item).toBe(itemB)
		})

		it("adjusts queuePosition when removing before current", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeFileItem("c", "c.mp3") })

			audio.skipTo(2)

			expect(audio.getQueuePosition()).toBe(2)

			audio.removeFromQueue(0)

			expect(audio.getQueuePosition()).toBe(1)
		})

		it("loads next track when removing current item", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			playlist.replace.mockClear()

			audio.removeFromQueue(0)

			// Should call replace to load the next track (loadWithoutPlaying)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("stops playlist when removing last item", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.pause.mockClear()
			playlist.seekTo.mockClear()
			playlist.clearLockScreenControls.mockClear()

			audio.removeFromQueue(0)

			expect(playlist.pause).toHaveBeenCalled()
			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(playlist.clearLockScreenControls).toHaveBeenCalled()
		})

		it("ignores out-of-bounds negative index", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			const queueBefore = audio.getQueue().slice()

			audio.removeFromQueue(-1)

			expect(audio.getQueue()).toHaveLength(2)
			expect(audio.getQueue()[0]!.item).toBe(queueBefore[0]!.item)
			expect(audio.getQueue()[1]!.item).toBe(queueBefore[1]!.item)
		})

		it("adjusts queuePosition when removing current at last position", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeFileItem("c", "c.mp3") })

			audio.skipTo(2)

			expect(audio.getQueuePosition()).toBe(2)

			audio.removeFromQueue(2)

			expect(audio.getQueue()).toHaveLength(2)
			expect(audio.getQueuePosition()).toBe(1)
		})
	})

	describe("clearQueue", () => {
		it("empties queue and resets position", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.clearQueue()

			expect(audio.getQueue()).toHaveLength(0)
			expect(audio.getQueuePosition()).toBe(0)
		})

		it("pauses playlist player", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.pause.mockClear()

			audio.clearQueue()

			expect(playlist.pause).toHaveBeenCalled()
		})

		it("clears lock screen controls", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.clearLockScreenControls.mockClear()

			audio.clearQueue()

			expect(playlist.clearLockScreenControls).toHaveBeenCalled()
		})
	})

	describe("play", () => {
		it("adds item to front and plays", async () => {
			const { audio, playlist } = await createAudio()
			const item = makeFileItem("a", "song.mp3")

			await audio.play(item)

			expect(audio.getQueue()).toHaveLength(1)
			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("resumes paused player when no item given", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.paused = true
			playlist.isLoaded = true
			playlist.play.mockClear()
			playlist.replace.mockClear()

			await audio.play()

			expect(playlist.play).toHaveBeenCalled()
			expect(playlist.replace).not.toHaveBeenCalled()
		})

		it("plays current queue item when not paused", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.paused = false
			playlist.isLoaded = false
			playlist.replace.mockClear()
			playlist.play.mockClear()

			await audio.play()

			// Should call loadAndPlay which calls replace + play
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("sets loading during item fetch", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "song.mp3")

			vi.mocked(events.emit).mockClear()

			await audio.play(item)

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("does nothing when no item given and queue is empty", async () => {
			const { audio, playlist } = await createAudio()

			playlist.play.mockClear()
			playlist.replace.mockClear()

			await audio.play()

			expect(playlist.play).not.toHaveBeenCalled()
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	describe("pause / resume", () => {
		it("pauses the player", async () => {
			const { audio, playlist } = await createAudio()

			playlist.pause.mockClear()

			audio.pause()

			expect(playlist.pause).toHaveBeenCalled()
		})

		it("resumes the player when queue has items", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.play.mockClear()

			audio.resume()

			expect(playlist.play).toHaveBeenCalled()
		})

		it("does not resume when queue is empty", async () => {
			const { audio, playlist } = await createAudio()

			playlist.play.mockClear()

			audio.resume()

			expect(playlist.play).not.toHaveBeenCalled()
		})
	})

	describe("next", () => {
		it("advances to next track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			playlist.replace.mockClear()
			playlist.play.mockClear()

			audio.next()

			expect(audio.getQueuePosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("wraps to start when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.skipTo(1)
			audio.setLoopMode("queue")

			playlist.replace.mockClear()

			audio.next()

			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("does nothing at end of queue with loopMode none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			audio.setLoopMode("none")

			playlist.replace.mockClear()

			audio.next()

			// Position stays at 0, no replace called
			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	describe("previous", () => {
		it("goes to previous track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.skipTo(1)

			playlist.replace.mockClear()
			playlist.play.mockClear()
			playlist.currentTime = 0

			audio.previous()

			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("restarts current track if more than 3 seconds in", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.skipTo(1)

			playlist.seekTo.mockClear()
			playlist.currentTime = 5

			audio.previous()

			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(audio.getQueuePosition()).toBe(1)
		})

		it("wraps to end when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.setLoopMode("queue")

			playlist.replace.mockClear()
			playlist.currentTime = 0

			audio.previous()

			expect(audio.getQueuePosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("seeks to 0 at start of queue with loopMode none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			audio.setLoopMode("none")

			playlist.seekTo.mockClear()
			playlist.currentTime = 0

			audio.previous()

			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(audio.getQueuePosition()).toBe(0)
		})
	})

	describe("seek / stop", () => {
		it("seeks to given position", async () => {
			const { audio, playlist } = await createAudio()

			playlist.seekTo.mockClear()

			audio.seek(42)

			expect(playlist.seekTo).toHaveBeenCalledWith(42)
		})

		it("stops: pauses, seeks to 0, clears lock screen", async () => {
			const { audio, playlist } = await createAudio()

			playlist.pause.mockClear()
			playlist.seekTo.mockClear()
			playlist.clearLockScreenControls.mockClear()

			audio.stop()

			expect(playlist.pause).toHaveBeenCalled()
			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(playlist.clearLockScreenControls).toHaveBeenCalled()
		})
	})

	describe("setLoopMode", () => {
		it("sets loopMode to track and enables native loop", async () => {
			const { audio, playlist } = await createAudio()

			audio.setLoopMode("track")

			expect(audio.getLoopMode()).toBe("track")
			expect(playlist.loop).toBe(true)
		})

		it("sets loopMode to queue and disables native loop", async () => {
			const { audio, playlist } = await createAudio()

			audio.setLoopMode("queue")

			expect(audio.getLoopMode()).toBe("queue")
			expect(playlist.loop).toBe(false)
		})

		it("sets loopMode to none and disables native loop", async () => {
			const { audio, playlist } = await createAudio()

			audio.setLoopMode("track")

			expect(playlist.loop).toBe(true)

			audio.setLoopMode("none")

			expect(audio.getLoopMode()).toBe("none")
			expect(playlist.loop).toBe(false)
		})
	})

	describe("toggleShuffle", () => {
		it("enables shuffle and generates shuffle order", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeFileItem("c", "c.mp3") })

			audio.toggleShuffle()

			expect(audio.isShuffled()).toBe(true)
		})

		it("disables shuffle and restores real queue position", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeFileItem("c", "c.mp3") })

			audio.toggleShuffle()

			expect(audio.isShuffled()).toBe(true)

			audio.toggleShuffle()

			expect(audio.isShuffled()).toBe(false)
		})

		it("current track stays at position 0 after shuffle", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeFileItem("c", "c.mp3") })

			audio.skipTo(1)

			const currentItemBefore = audio.getCurrentQueueItem()

			audio.toggleShuffle()

			// After shuffle, position is reset to 0 and the effective index
			// should map to the same track that was playing
			expect(audio.getQueuePosition()).toBe(0)

			const currentItemAfter = audio.getCurrentQueueItem()

			expect(currentItemAfter!.item).toBe(currentItemBefore!.item)
		})
	})

	describe("skipTo", () => {
		it("jumps to given queue index", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeFileItem("c", "c.mp3") })

			playlist.replace.mockClear()
			playlist.play.mockClear()

			audio.skipTo(2)

			expect(audio.getQueuePosition()).toBe(2)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("does nothing for out of bounds index", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.replace.mockClear()

			audio.skipTo(5)

			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	// preview mode (enterPreviewMode / switchPreviewTrack / pausePreview / resumePreview / seekPreview / exitPreviewMode / getMode / getPreviewItem) removed in queue-unified refactor

	describe("handleTrackEnd", () => {
		it("advances to next track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			const statusListener = getPlaylistStatusListener(playlist)

			expect(statusListener).toBeDefined()

			playlist.replace.mockClear()
			playlist.play.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			expect(audio.getQueuePosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("wraps to start when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.skipTo(1)
			audio.setLoopMode("queue")

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.replace.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("pauses when no next track and loopMode is none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			audio.setLoopMode("none")

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.pause.mockClear()
			playlist.replace.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			expect(playlist.pause).toHaveBeenCalled()
			expect(playlist.replace).not.toHaveBeenCalled()
		})

		it("does nothing when loopMode is track (defensive guard)", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.setLoopMode("track")

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.replace.mockClear()
			playlist.pause.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			// Track loop is handled by native player, so handleTrackEnd returns early
			expect(audio.getQueuePosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
			expect(playlist.pause).not.toHaveBeenCalled()
		})
	})

	describe("loading state", () => {
		it("emits audioLoading true then false during async operations", async () => {
			const { audio } = await createAudio()

			vi.mocked(events.emit).mockClear()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls).toHaveLength(2)
			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("deduplicates loading events (no duplicate true/false)", async () => {
			const { audio } = await createAudio()

			vi.mocked(events.emit).mockClear()

			// First add sets loading true then false
			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			// Second add also sets loading true then false
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			// Each operation emits true then false, the setLoading dedup guard
			// prevents emitting the same value twice in a row
			for (let i = 1; i < emitCalls.length; i++) {
				// No two consecutive events should have the same value
				expect(emitCalls[i]![1]).not.toBe(emitCalls[i - 1]![1])
			}
		})
	})

	describe("getters", () => {
		it("getQueue returns readonly queue", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "a.mp3")

			await audio.addToQueue({ item })

			const queue = audio.getQueue()

			expect(queue).toHaveLength(1)
			expect(queue[0]!.item).toBe(item)
		})

		it("getCurrentQueueItem returns item at effective index", async () => {
			const { audio } = await createAudio()

			const itemA = makeFileItem("a", "a.mp3")
			const itemB = makeFileItem("b", "b.mp3")

			await audio.addToQueue({ item: itemA })
			await audio.addToQueue({ item: itemB })

			expect(audio.getCurrentQueueItem()!.item).toBe(itemA)

			audio.skipTo(1)

			expect(audio.getCurrentQueueItem()!.item).toBe(itemB)
		})

		it("getCurrentQueueItem returns null when queue is empty", async () => {
			const { audio } = await createAudio()

			expect(audio.getCurrentQueueItem()).toBeNull()
		})

		it("isLoading reflects loading state", async () => {
			const { audio } = await createAudio()

			expect(audio.isLoading()).toBe(false)
		})
	})
})
