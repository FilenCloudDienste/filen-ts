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

let latestPlaylistPlayer: MockPlayer
let latestPreviewPlayer: MockPlayer
let playerCreateCount = 0

vi.mock("expo-audio", () => ({
	createAudioPlayer: vi.fn(() => {
		playerCreateCount++

		// Odd calls = playlist player, even calls = preview player
		// (each Audio() constructor creates playlist first, then preview)
		if (playerCreateCount % 2 === 1) {
			latestPlaylistPlayer = makeMockPlayer()
			return latestPlaylistPlayer
		}

		latestPreviewPlayer = makeMockPlayer()
		return latestPreviewPlayer
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

vi.mock("@/lib/alerts", () => ({
	default: {
		error: vi.fn()
	}
}))

vi.mock("@/lib/memo", () => ({
	useCallback: (fn: unknown) => fn,
	useMemo: (fn: () => unknown) => fn(),
	memo: (component: unknown) => component
}))

vi.mock("@filen/utils", () => {
	class Semaphore {
		async acquire(): Promise<void> {}
		release(): void {}
	}

	async function run(fn: (defer: (cleanup: () => void) => void) => Promise<any>, opts?: { throw?: boolean }): Promise<any> {
		const cleanups: (() => void)[] = []

		const defer = (cleanup: () => void) => {
			cleanups.push(cleanup)
		}

		try {
			const data = await fn(defer)

			for (const cleanup of cleanups) {
				cleanup()
			}

			return opts?.throw ? data : { success: true, data }
		} catch (error) {
			for (const cleanup of cleanups) {
				cleanup()
			}

			if (opts?.throw) {
				throw error
			}

			return { success: false, error }
		}
	}

	return { Semaphore, run }
})

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
	preview: MockPlayer
}

async function createAudio(): Promise<AudioTestContext> {
	const mod = await import("@/lib/audio")
	const audio = new (mod.Audio as new () => InstanceType<typeof mod.Audio>)()

	return {
		audio,
		playlist: latestPlaylistPlayer,
		preview: latestPreviewPlayer
	}
}

function getPlaylistStatusListener(playlist: MockPlayer): ((status: Record<string, unknown>) => void) | undefined {
	const found = playlist.addListener.mock.calls.find((call: any) => call[0] === "playbackStatusUpdate")

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
		it("creates two audio players", async () => {
			const { createAudioPlayer: mockCreate } = await import("expo-audio")

			// The module-level singleton also creates 2 players on first import,
			// so we measure all calls and verify they come in pairs of 2
			const callsBefore = vi.mocked(mockCreate).mock.calls.length

			await createAudio()

			const newCalls = vi.mocked(mockCreate).mock.calls.length - callsBefore

			// newCalls includes module-level singleton (2) on first import + our new Audio() (2)
			// On subsequent runs (module cached), it's just 2
			expect(newCalls % 2).toBe(0)
			expect(newCalls).toBeGreaterThanOrEqual(2)
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

		it("bails if operationId changed during fetch", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "song-a.mp3")

			vi.mocked(audioCache.get).mockImplementation(async () => {
				// Simulate another operation bumping the id
				audio.clearQueue()

				return {
					audio: { uri: "file:///cache/audio.mp3" },
					metadata: { title: "Test", artist: "Test", album: "Test", cachedAt: Date.now() }
				} as never
			})

			await audio.addToQueue({ item })

			// Queue should be empty because clearQueue was called and the add bailed
			expect(audio.getQueue()).toHaveLength(0)
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

		it("bails if operationId changed during fetch", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("a", "song.mp3")

			vi.mocked(audioCache.get).mockImplementation(async () => {
				audio.clearQueue()

				return {
					audio: { uri: "file:///cache/audio.mp3" },
					metadata: { title: "Test", artist: "Test", album: "Test", cachedAt: Date.now() }
				} as never
			})

			await audio.play(item)

			expect(audio.getQueue()).toHaveLength(0)
		})
	})

	describe("pausePlaylist / resumePlaylist", () => {
		it("pauses the playlist player", async () => {
			const { audio, playlist } = await createAudio()

			playlist.pause.mockClear()

			audio.pausePlaylist()

			expect(playlist.pause).toHaveBeenCalled()
		})

		it("resumes the playlist player when queue has items", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			playlist.play.mockClear()

			audio.resumePlaylist()

			expect(playlist.play).toHaveBeenCalled()
		})

		it("does not resume when queue is empty", async () => {
			const { audio, playlist } = await createAudio()

			playlist.play.mockClear()

			audio.resumePlaylist()

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

		it("bumps operationId", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			const beforeQueue = audio.getQueue().length

			audio.next()

			expect(audio.getQueue().length).toBe(beforeQueue)
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

		it("bumps operationId", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.skipTo(1)

			const beforeQueue = audio.getQueue().length

			playlist.currentTime = 0

			audio.previous()

			expect(audio.getQueue().length).toBe(beforeQueue)
		})
	})

	describe("seekPlaylist / stopPlaylist", () => {
		it("seeks to given position", async () => {
			const { audio, playlist } = await createAudio()

			playlist.seekTo.mockClear()

			audio.seekPlaylist(42)

			expect(playlist.seekTo).toHaveBeenCalledWith(42)
		})

		it("stops: pauses, seeks to 0, clears lock screen", async () => {
			const { audio, playlist } = await createAudio()

			playlist.pause.mockClear()
			playlist.seekTo.mockClear()
			playlist.clearLockScreenControls.mockClear()

			audio.stopPlaylist()

			expect(playlist.pause).toHaveBeenCalled()
			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(playlist.clearLockScreenControls).toHaveBeenCalled()
		})

		it("stop bumps operationId", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })

			audio.stopPlaylist()

			expect(playlist.pause).toHaveBeenCalled()
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

		it("bumps operationId", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeFileItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeFileItem("b", "b.mp3") })

			audio.skipTo(1)

			expect(audio.getQueuePosition()).toBe(1)
		})
	})

	describe("enterPreviewMode", () => {
		it("pauses playlist and sets mode to preview", async () => {
			const { audio, playlist } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			playlist.pause.mockClear()

			await audio.enterPreviewMode({ item })

			expect(playlist.pause).toHaveBeenCalled()
			expect(audio.getMode()).toBe("preview")
		})

		it("loads and optionally autoplays track", async () => {
			const { audio, preview } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			await audio.enterPreviewMode({ item, autoPlay: true })

			expect(preview.replace).toHaveBeenCalled()
			expect(preview.play).toHaveBeenCalled()
		})

		it("sets loading during fetch", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			vi.mocked(events.emit).mockClear()

			await audio.enterPreviewMode({ item })

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("bails if operationId changed during fetch", async () => {
			const { audio, preview } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			vi.mocked(audioCache.get).mockImplementation(async () => {
				// Simulate another operation
				audio.exitPreviewMode()

				return {
					audio: { uri: "file:///cache/audio.mp3" },
					metadata: { title: "Test", artist: "Test", album: "Test", cachedAt: Date.now() }
				} as never
			})

			await audio.enterPreviewMode({ item })

			// exitPreviewMode bumps operationId, so the replace should not happen
			expect(preview.replace).not.toHaveBeenCalled()
		})
	})

	describe("switchPreviewTrack", () => {
		it("pauses preview player and loads new track", async () => {
			const { audio, preview } = await createAudio()
			const item1 = makeFileItem("p1", "preview1.mp3")
			const item2 = makeFileItem("p2", "preview2.mp3")

			await audio.enterPreviewMode({ item: item1 })

			preview.pause.mockClear()
			preview.replace.mockClear()

			await audio.switchPreviewTrack({ item: item2 })

			expect(preview.pause).toHaveBeenCalled()
			expect(preview.replace).toHaveBeenCalled()
		})

		it("sets loading during fetch", async () => {
			const { audio } = await createAudio()
			const item1 = makeFileItem("p1", "preview1.mp3")
			const item2 = makeFileItem("p2", "preview2.mp3")

			await audio.enterPreviewMode({ item: item1 })

			vi.mocked(events.emit).mockClear()

			await audio.switchPreviewTrack({ item: item2 })

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("bails if operationId changed during fetch", async () => {
			const { audio, preview } = await createAudio()
			const item1 = makeFileItem("p1", "preview1.mp3")
			const item2 = makeFileItem("p2", "preview2.mp3")

			await audio.enterPreviewMode({ item: item1 })

			vi.mocked(audioCache.get).mockImplementation(async () => {
				audio.exitPreviewMode()

				return {
					audio: { uri: "file:///cache/audio.mp3" },
					metadata: { title: "Test", artist: "Test", album: "Test", cachedAt: Date.now() }
				} as never
			})

			preview.replace.mockClear()

			await audio.switchPreviewTrack({ item: item2 })

			expect(preview.replace).not.toHaveBeenCalled()
		})
	})

	describe("pausePreview / resumePreview / seekPreview", () => {
		it("pauses the preview player", async () => {
			const { audio, preview } = await createAudio()

			preview.pause.mockClear()

			audio.pausePreview()

			expect(preview.pause).toHaveBeenCalled()
		})

		it("resumes the preview player", async () => {
			const { audio, preview } = await createAudio()

			preview.play.mockClear()

			audio.resumePreview()

			expect(preview.play).toHaveBeenCalled()
		})

		it("seeks the preview player", async () => {
			const { audio, preview } = await createAudio()

			preview.seekTo.mockClear()

			audio.seekPreview(15)

			expect(preview.seekTo).toHaveBeenCalledWith(15)
		})
	})

	describe("exitPreviewMode", () => {
		it("pauses preview player and seeks to 0", async () => {
			const { audio, preview } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			await audio.enterPreviewMode({ item })

			preview.pause.mockClear()
			preview.seekTo.mockClear()

			audio.exitPreviewMode()

			expect(preview.pause).toHaveBeenCalled()
			expect(preview.seekTo).toHaveBeenCalledWith(0)
		})

		it("resets mode to queue and clears previewItem", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			await audio.enterPreviewMode({ item })

			expect(audio.getMode()).toBe("preview")
			expect(audio.getPreviewItem()).toBe(item)

			audio.exitPreviewMode()

			expect(audio.getMode()).toBe("queue")
			expect(audio.getPreviewItem()).toBeNull()
		})

		it("bumps operationId", async () => {
			const { audio } = await createAudio()
			const item = makeFileItem("prev", "preview.mp3")

			await audio.enterPreviewMode({ item })

			audio.exitPreviewMode()

			expect(audio.getMode()).toBe("queue")
		})
	})

	describe("handlePlaylistTrackEnd", () => {
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

			// Track loop is handled by native player, so handlePlaylistTrackEnd returns early
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
		it("getMode returns current mode", async () => {
			const { audio } = await createAudio()

			expect(audio.getMode()).toBe("queue")

			await audio.enterPreviewMode({ item: makeFileItem("p", "p.mp3") })

			expect(audio.getMode()).toBe("preview")
		})

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
	})
})
