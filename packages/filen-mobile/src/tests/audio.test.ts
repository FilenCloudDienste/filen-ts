import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ──────────────────────────────────────────────
// Mock player factory
// ──────────────────────────────────────────────

function makeMockPlayer() {
	return {
		addListener: vi.fn(),
		play: vi.fn(),
		pause: vi.fn(),
		replace: vi.fn(),
		seekTo: vi.fn().mockResolvedValue(undefined),
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

const secureStoreMap = new Map<string, unknown>()

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: vi.fn(async (key: string) => secureStoreMap.get(key)),
		set: vi.fn(async (key: string, value: unknown) => {
			secureStoreMap.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			secureStoreMap.delete(key)
		})
	},
	useSecureStore: vi.fn(() => [undefined, vi.fn()])
}))

const mockSdkClient = {
	listDir: vi.fn(),
	downloadFileToBytes: vi.fn(),
	uploadFileFromBytes: vi.fn().mockResolvedValue(undefined),
	deleteFilePermanently: vi.fn().mockResolvedValue(undefined),
	createDir: vi.fn(),
	getFileOptional: vi.fn(),
	root: vi.fn(() => ({ uuid: "root-uuid" }))
}

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn(async () => ({ authedSdkClient: mockSdkClient }))
	}
}))

vi.mock("@/lib/cache", () => ({
	default: { uuidToAnyDriveItem: new Map() }
}))

vi.mock("@/lib/utils", () => ({
	wrapAbortSignalForSdk: vi.fn((signal: unknown) => signal)
}))

vi.mock("@/queries/usePlaylists.query", () => ({
	playlistsQueryUpdate: vi.fn()
}))

class WrapClass {
	public inner: unknown

	public constructor(inner: unknown) {
		this.inner = inner
	}
}

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: { Root: WrapClass, Dir: WrapClass },
	AnyFile: { File: WrapClass },
	DirMeta_Tags: { Decoded: "Decoded" },
	FileMeta_Tags: { Decoded: "Decoded" },
	FileMeta: { Decoded: WrapClass },
	ParentUuid: { Uuid: WrapClass }
}))

vi.mock("react-native-quick-crypto", async () => {
	const { Buffer } = await import("node:buffer")

	return {
		Buffer
	}
})

import { Buffer } from "node:buffer"
import { type DriveItemFileExtracted } from "@/types"
import audioCache from "@/lib/audioCache"
import events from "@/lib/events"
import { createAudioPlayer, setAudioModeAsync } from "expo-audio"
import { type QueueItem } from "@/lib/audio"

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

function makeQueueItem(uuid: string, name: string): QueueItem {
	return {
		playlistUuid: "test-playlist",
		item: makeFileItem(uuid, name)
	}
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

async function flushMicrotasks(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
	await new Promise(resolve => setTimeout(resolve, 0))
}

// ──────────────────────────────────────────────
// Reset
// ──────────────────────────────────────────────

beforeEach(() => {
	secureStoreMap.clear()

	vi.mocked(audioCache.get).mockResolvedValue({
		audio: { uri: "file:///cache/audio.mp3" },
		metadata: { title: "Test Song", artist: "Test Artist", album: "Test Album", cachedAt: Date.now() }
	} as never)

	vi.mocked(events.emit).mockClear()
	vi.mocked(setAudioModeAsync).mockClear()
	vi.mocked(createAudioPlayer).mockClear()

	mockSdkClient.listDir.mockReset()
	mockSdkClient.downloadFileToBytes.mockReset()
	mockSdkClient.uploadFileFromBytes.mockReset().mockResolvedValue(undefined)
	mockSdkClient.deleteFilePermanently.mockReset().mockResolvedValue(undefined)
	mockSdkClient.createDir.mockReset()
	mockSdkClient.getFileOptional.mockReset()
	mockSdkClient.root.mockReset().mockReturnValue({ uuid: "root-uuid" })
})

afterEach(() => {
	vi.restoreAllMocks()
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
			const qi = makeQueueItem("a", "song-a.mp3")

			await audio.addToQueue({ item: qi })

			expect(audio.getQueue()).toHaveLength(1)
			expect(audio.getQueue()[0]!.item).toBe(qi.item)
		})

		it("adds item to start of queue", async () => {
			const { audio } = await createAudio()
			const qiA = makeQueueItem("a", "song-a.mp3")
			const qiB = makeQueueItem("b", "song-b.mp3")

			await audio.addToQueue({ item: qiA })
			await audio.addToQueue({ item: qiB, position: "start" })

			expect(audio.getQueue()[0]!.item).toBe(qiB.item)
			expect(audio.getQueue()[1]!.item).toBe(qiA.item)
		})

		it("increments queuePosition when adding to start with existing items", async () => {
			const { audio } = await createAudio()
			const qiA = makeQueueItem("a", "song-a.mp3")
			const qiB = makeQueueItem("b", "song-b.mp3")

			await audio.addToQueue({ item: qiA })

			expect(audio.getPosition()).toBe(0)

			await audio.addToQueue({ item: qiB, position: "start" })

			expect(audio.getPosition()).toBe(1)
		})
	})

	describe("clearQueue", () => {
		it("empties queue and resets position", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.clearQueue()

			expect(audio.getQueue()).toHaveLength(0)
			expect(audio.getPosition()).toBe(0)
		})

		it("pauses playlist player", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			playlist.pause.mockClear()

			await audio.clearQueue()

			expect(playlist.pause).toHaveBeenCalled()
		})

		it("clears lock screen controls", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			playlist.clearLockScreenControls.mockClear()

			await audio.clearQueue()

			expect(playlist.clearLockScreenControls).toHaveBeenCalled()
		})
	})

	describe("play", () => {
		it("plays first queued item via loadAndPlay", async () => {
			const { audio, playlist } = await createAudio()
			const qi = makeQueueItem("a", "song.mp3")

			await audio.addToQueue({ item: qi })

			playlist.replace.mockClear()
			playlist.play.mockClear()

			await audio.play()

			expect(audio.getQueue()).toHaveLength(1)
			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("plays current queue item via replace + play", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			playlist.replace.mockClear()
			playlist.play.mockClear()

			await audio.play()

			// Should call loadAndPlay which calls replace + play
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("sets loading true during fetch and false after", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "song.mp3") })

			vi.mocked(events.emit).mockClear()

			await audio.play()

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("calls audioCache.get with drive-typed CacheItem", async () => {
			const { audio } = await createAudio()
			const qi = makeQueueItem("a", "song-a.mp3")

			await audio.addToQueue({ item: qi })

			vi.mocked(audioCache.get).mockClear()

			await audio.play()

			expect(audioCache.get).toHaveBeenCalledWith({
				item: {
					type: "drive",
					data: qi.item
				}
			})
		})

		it("does nothing when queue is empty", async () => {
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

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

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

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			playlist.replace.mockClear()
			playlist.play.mockClear()

			await audio.next()

			expect(audio.getPosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("wraps to start when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)
			await audio.setLoopMode("queue")

			playlist.replace.mockClear()

			await audio.next()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("does nothing at end of queue with loopMode none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			await audio.setLoopMode("none")

			playlist.replace.mockClear()

			await audio.next()

			// Position stays at 0, no replace called
			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	describe("previous", () => {
		it("goes to previous track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)

			playlist.replace.mockClear()
			playlist.play.mockClear()
			playlist.currentTime = 0

			await audio.previous()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("restarts current track if more than 3 seconds in", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)

			playlist.seekTo.mockClear()
			playlist.currentTime = 5

			await audio.previous()

			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(audio.getPosition()).toBe(1)
		})

		it("wraps to end when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setLoopMode("queue")

			playlist.replace.mockClear()
			playlist.currentTime = 0

			await audio.previous()

			expect(audio.getPosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("seeks to 0 at start of queue with loopMode none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			await audio.setLoopMode("none")

			playlist.seekTo.mockClear()
			playlist.currentTime = 0

			await audio.previous()

			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(audio.getPosition()).toBe(0)
		})
	})

	describe("seek / stop", () => {
		it("seeks to given position", async () => {
			const { audio, playlist } = await createAudio()

			playlist.seekTo.mockClear()

			await audio.seek(42)

			expect(playlist.seekTo).toHaveBeenCalledWith(42)
		})

		it("stops: pauses, seeks to 0, clears lock screen", async () => {
			const { audio, playlist } = await createAudio()

			playlist.pause.mockClear()
			playlist.seekTo.mockClear()
			playlist.clearLockScreenControls.mockClear()

			await audio.stop()

			expect(playlist.pause).toHaveBeenCalled()
			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			expect(playlist.clearLockScreenControls).toHaveBeenCalled()
		})
	})

	describe("setLoopMode", () => {
		it("persists track loop mode to secure store", async () => {
			const { audio } = await createAudio()

			await audio.setLoopMode("track")

			expect(secureStoreMap.get(audio.loopModeKey)).toBe("track")
		})

		it("persists queue loop mode to secure store", async () => {
			const { audio } = await createAudio()

			await audio.setLoopMode("queue")

			expect(secureStoreMap.get(audio.loopModeKey)).toBe("queue")
		})

		it("persists none loop mode to secure store", async () => {
			const { audio } = await createAudio()

			await audio.setLoopMode("track")
			await audio.setLoopMode("none")

			expect(secureStoreMap.get(audio.loopModeKey)).toBe("none")
		})
	})

	describe("setShuffleEnabled", () => {
		it("enables shuffle and persists to secure store", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)

			expect(secureStoreMap.get(audio.shuffleEnabledKey)).toBe(true)
		})

		it("disables shuffle and persists to secure store", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)

			expect(secureStoreMap.get(audio.shuffleEnabledKey)).toBe(true)

			await audio.setShuffleEnabled(false)

			expect(secureStoreMap.get(audio.shuffleEnabledKey)).toBe(false)
		})

		it("current track keeps playing after shuffle is enabled", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.skipTo(1)

			const currentItemBefore = audio.getCurrentQueueItem()

			await audio.setShuffleEnabled(true)

			// Position stays the same — shuffle places current track at the front of the
			// shuffle order, so the currently-playing item is unchanged.
			const currentItemAfter = audio.getCurrentQueueItem()

			expect(currentItemAfter!.item).toBe(currentItemBefore!.item)
		})
	})

	describe("skipTo", () => {
		it("jumps to given queue index", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			playlist.replace.mockClear()
			playlist.play.mockClear()

			await audio.skipTo(2)

			expect(audio.getPosition()).toBe(2)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("does nothing for out of bounds index", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			playlist.replace.mockClear()

			await audio.skipTo(5)

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	describe("handleTrackEnd", () => {
		it("advances to next track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			const statusListener = getPlaylistStatusListener(playlist)

			expect(statusListener).toBeDefined()

			playlist.replace.mockClear()
			playlist.play.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			await flushMicrotasks()

			expect(audio.getPosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.play).toHaveBeenCalled()
		})

		it("wraps to start when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)
			await audio.setLoopMode("queue")

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.replace.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			await flushMicrotasks()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("pauses when no next track and loopMode is none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			await audio.setLoopMode("none")

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.pause.mockClear()
			playlist.replace.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			await flushMicrotasks()

			expect(playlist.pause).toHaveBeenCalled()
			expect(playlist.replace).not.toHaveBeenCalled()
		})

		it("restarts current track when loopMode is track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setLoopMode("track")

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.replace.mockClear()
			playlist.pause.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			await flushMicrotasks()

			// Track loop re-loads the current track without advancing position
			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
			expect(playlist.pause).not.toHaveBeenCalled()
		})
	})

	describe("loading state", () => {
		it("emits audioLoading true then false during play", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			vi.mocked(events.emit).mockClear()

			await audio.play()

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			expect(emitCalls).toHaveLength(2)
			expect(emitCalls[0]![1]).toBe(true)
			expect(emitCalls[1]![1]).toBe(false)
		})

		it("emits alternating true/false across consecutive plays", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			vi.mocked(events.emit).mockClear()

			await audio.play()
			await audio.skipTo(1)

			const emitCalls = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")

			for (let i = 1; i < emitCalls.length; i++) {
				// No two consecutive events should have the same value
				expect(emitCalls[i]![1]).not.toBe(emitCalls[i - 1]![1])
			}
		})
	})

	describe("getters", () => {
		it("getQueue returns readonly queue", async () => {
			const { audio } = await createAudio()
			const qi = makeQueueItem("a", "a.mp3")

			await audio.addToQueue({ item: qi })

			const queue = audio.getQueue()

			expect(queue).toHaveLength(1)
			expect(queue[0]!.item).toBe(qi.item)
		})

		it("getCurrentQueueItem returns item at effective index", async () => {
			const { audio } = await createAudio()

			const qiA = makeQueueItem("a", "a.mp3")
			const qiB = makeQueueItem("b", "b.mp3")

			await audio.addToQueue({ item: qiA })
			await audio.addToQueue({ item: qiB })

			expect(audio.getCurrentQueueItem()!.item).toBe(qiA.item)

			await audio.skipTo(1)

			expect(audio.getCurrentQueueItem()!.item).toBe(qiB.item)
		})

		it("getCurrentQueueItem returns null when queue is empty", async () => {
			const { audio } = await createAudio()

			expect(audio.getCurrentQueueItem()).toBeNull()
		})

		it("getLoading reflects loading state", async () => {
			const { audio } = await createAudio()

			expect(audio.getLoading()).toBe(false)
		})
	})

	describe("replaceQueue", () => {
		it("replaces queue and seeds startingPosition", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			const items = [makeQueueItem("x", "x.mp3"), makeQueueItem("y", "y.mp3"), makeQueueItem("z", "z.mp3")]

			await audio.replaceQueue({
				items,
				startingPosition: 2
			})

			expect(audio.getQueue()).toHaveLength(3)
			expect(audio.getPosition()).toBe(2)
			expect(audio.getCurrentQueueItem()!.item).toBe(items[2]!.item)
		})

		it("regenerates shuffle order when shuffle is enabled", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.setShuffleEnabled(true)

			await audio.replaceQueue({
				items: [makeQueueItem("x", "x.mp3"), makeQueueItem("y", "y.mp3"), makeQueueItem("z", "z.mp3")],
				startingPosition: 1
			})

			// startingPosition becomes shuffleOrder[0] when shuffle is on
			expect(audio.getPosition()).toBe(1)

			// Advancing once should consume the next shuffle slot (some index from {0, 2})
			await audio.next()

			expect([0, 2]).toContain(audio.getPosition())
		})

		it("clears shuffle state when shuffle is disabled", async () => {
			const { audio } = await createAudio()

			await audio.replaceQueue({
				items: [makeQueueItem("x", "x.mp3"), makeQueueItem("y", "y.mp3")]
			})

			// With shuffle off, next() walks queue order
			await audio.replaceQueue({
				items: [makeQueueItem("a", "a.mp3"), makeQueueItem("b", "b.mp3"), makeQueueItem("c", "c.mp3")],
				startingPosition: 0
			})

			await audio.next()

			expect(audio.getPosition()).toBe(1)
		})

		it("is a no-op on shuffleOrder when items is empty", async () => {
			const { audio } = await createAudio()

			await audio.setShuffleEnabled(true)

			await audio.replaceQueue({
				items: []
			})

			expect(audio.getQueue()).toHaveLength(0)
			expect(audio.getPosition()).toBe(0)
		})
	})

	describe("next + shuffle", () => {
		it("advances along shuffleOrder, not queue order", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			// Force a deterministic shuffle order: start at position 0, then [2, 1]
			vi.spyOn(Math, "random").mockReturnValue(0)

			await audio.setShuffleEnabled(true)

			const positions: number[] = [audio.getPosition()]

			await audio.next()
			positions.push(audio.getPosition())

			await audio.next()
			positions.push(audio.getPosition())

			// All queue indices should have been visited exactly once
			expect(positions.sort()).toEqual([0, 1, 2])
		})

		it("regenerates stale order when shuffleOrder.length !== queue.length", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setShuffleEnabled(true)

			// Replace queue to introduce a length mismatch
			await audio.replaceQueue({
				items: [makeQueueItem("x", "x.mp3"), makeQueueItem("y", "y.mp3"), makeQueueItem("z", "z.mp3")],
				startingPosition: 0
			})

			// Advancing should still work without throwing
			await audio.next()

			expect(audio.getPosition()).toBeGreaterThanOrEqual(0)
			expect(audio.getPosition()).toBeLessThan(3)
		})

		it("returns false (no advance) when at end of shuffleOrder and loopMode is none", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setShuffleEnabled(true)
			await audio.setLoopMode("none")

			// Advance to the end of shuffleOrder
			await audio.next()

			playlist.replace.mockClear()

			const positionBefore = audio.getPosition()

			await audio.next()

			expect(audio.getPosition()).toBe(positionBefore)
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	describe("previous + shuffle", () => {
		it("walks shuffleOrder backwards", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)
			await audio.next()

			const after = audio.getPosition()

			playlist.currentTime = 0
			await audio.previous()

			expect(audio.getPosition()).toBe(0)
			expect(audio.getPosition()).not.toBe(after)
		})

		it("wraps to end of shuffleOrder when loopMode is queue", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setShuffleEnabled(true)
			await audio.setLoopMode("queue")

			playlist.currentTime = 0
			playlist.replace.mockClear()

			await audio.previous()

			// Should have wrapped to the end of the shuffleOrder
			expect(playlist.replace).toHaveBeenCalled()
		})
	})

	describe("handleTrackEnd + shuffle", () => {
		it("advances via shuffleOrder on didJustFinish", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)

			const statusListener = getPlaylistStatusListener(playlist)

			expect(statusListener).toBeDefined()

			playlist.replace.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			await flushMicrotasks()

			expect(playlist.replace).toHaveBeenCalled()
			expect(audio.getPosition()).toBeGreaterThanOrEqual(0)
			expect(audio.getPosition()).toBeLessThan(3)
		})

		it("wraps to a fresh shuffleOrder via wrapToStart on loop queue + shuffle", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setShuffleEnabled(true)
			await audio.setLoopMode("queue")

			// Advance to the end of the shuffleOrder
			await audio.next()

			const statusListener = getPlaylistStatusListener(playlist)

			playlist.replace.mockClear()

			statusListener!({ didJustFinish: true, remoteAction: undefined })

			await flushMicrotasks()

			// Should have wrapped and reloaded
			expect(playlist.replace).toHaveBeenCalled()
		})
	})

	describe("skipTo + shuffle", () => {
		it("syncs shufflePosition when target index is already in shuffleOrder", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			// Make shuffle order deterministic so we can pick a non-end slot.
			// With Math.random=0, shuffleOrder generated with firstIdx=0 becomes [0, 2, 1].
			vi.spyOn(Math, "random").mockReturnValue(0)

			await audio.setShuffleEnabled(true)

			// Skip to index 2, which is shufflePosition 1 (middle of shuffleOrder).
			// Without re-syncing shufflePosition, the loop-queue wraparound would misbehave.
			await audio.skipTo(2)

			expect(audio.getPosition()).toBe(2)

			// previous() should walk back to shufflePosition 0 → state.position 0
			playlist.currentTime = 0
			await audio.previous()

			expect(audio.getPosition()).toBe(0)
		})

		it("regenerates shuffleOrder when target index is not in stale order", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setShuffleEnabled(true)

			// Introduce a stale order by replacing the queue without keeping shuffleOrder in sync
			await audio.replaceQueue({
				items: [makeQueueItem("x", "x.mp3"), makeQueueItem("y", "y.mp3"), makeQueueItem("z", "z.mp3")],
				startingPosition: 0
			})

			// Force shuffle order to be stale by toggling
			await audio.skipTo(2)

			expect(audio.getPosition()).toBe(2)
		})
	})

	describe("setShuffleEnabled (extra)", () => {
		it("after disabling, next() proceeds in queue order from current position", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)
			await audio.skipTo(1)

			await audio.setShuffleEnabled(false)

			await audio.next()

			expect(audio.getPosition()).toBe(2)
		})

		it("enabling on empty queue produces empty shuffleOrder", async () => {
			const { audio } = await createAudio()

			await audio.setShuffleEnabled(true)

			// next() on empty queue should not throw
			await audio.next()

			expect(audio.getQueue()).toHaveLength(0)
		})
	})

	describe("clearQueue (extra)", () => {
		it("resets shuffleOrder and shufflePosition", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.setShuffleEnabled(true)

			await audio.clearQueue()

			// After clear, re-adding items should start fresh
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			expect(audio.getPosition()).toBe(0)
			expect(audio.getQueue()).toHaveLength(1)
		})
	})

	describe("addToQueue events", () => {
		it("emits audioQueue every time", async () => {
			const { audio } = await createAudio()

			vi.mocked(events.emit).mockClear()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			const queueEmits = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioQueue")

			expect(queueEmits).toHaveLength(3)
		})

		it("emits audioQueuePosition when prepending into non-empty queue, but NOT when prepending into empty queue", async () => {
			const { audio } = await createAudio()

			vi.mocked(events.emit).mockClear()

			// Prepend into empty queue — should NOT bump position
			await audio.addToQueue({
				item: makeQueueItem("a", "a.mp3"),
				position: "start"
			})

			const emptyPosEmits = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioQueuePosition")

			expect(emptyPosEmits).toHaveLength(0)

			vi.mocked(events.emit).mockClear()

			// Prepend into non-empty queue — should bump position
			await audio.addToQueue({
				item: makeQueueItem("b", "b.mp3"),
				position: "start"
			})

			const posEmits = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioQueuePosition")

			expect(posEmits).toHaveLength(1)
			expect(posEmits[0]![1]).toBe(1)
		})
	})

	describe("defaults", () => {
		it("loopMode defaults to 'none' when secureStore is empty", async () => {
			const { audio, playlist } = await createAudio()

			expect(secureStoreMap.has(audio.loopModeKey)).toBe(false)

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			playlist.replace.mockClear()

			// next() from end of queue with default loopMode should NOT wrap
			await audio.next()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
		})

		it("shuffle defaults to false", async () => {
			const { audio } = await createAudio()

			expect(secureStoreMap.has(audio.shuffleEnabledKey)).toBe(false)

			// addToQueue with default shuffle off should not touch shuffleOrder behavior;
			// in shuffle-off mode, next() walks queue order
			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.next()

			expect(audio.getPosition()).toBe(1)
		})
	})

	describe("previous (boundary)", () => {
		it("treats currentTime === 3 as going back, not restarting", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)

			playlist.replace.mockClear()
			playlist.currentTime = 3

			await audio.previous()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})
	})

	describe("skipTo (extra)", () => {
		it("ignores negative index", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			playlist.replace.mockClear()

			await audio.skipTo(-1)

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).not.toHaveBeenCalled()
		})
	})

	describe("previous (NaN guard, fix #4)", () => {
		it("treats undefined/NaN currentTime as 'go back', not restart", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)

			playlist.replace.mockClear()
			playlist.currentTime = NaN

			await audio.previous()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})
	})

	describe("loadAndPlay race (fix #3)", () => {
		it("stale load doesn't overwrite the current track", async () => {
			const { audio, playlist } = await createAudio()

			const itemA = makeQueueItem("a", "a.mp3")
			const itemB = makeQueueItem("b", "b.mp3")

			await audio.addToQueue({ item: itemA })
			await audio.addToQueue({ item: itemB })

			// Slow resolve for first call (track a), fast resolve for the second call (track b).
			let resolveFirst: (value: { audio: { uri: string }; metadata: { title: string; cachedAt: number } }) => void = () => {}

			const firstPromise = new Promise<{ audio: { uri: string }; metadata: { title: string; cachedAt: number } }>(r => {
				resolveFirst = r
			})

			vi.mocked(audioCache.get)
				.mockReset()
				.mockReturnValueOnce(firstPromise as never)
				.mockResolvedValue({
					audio: { uri: "file:///cache/b.mp3" },
					metadata: { title: "Track B", cachedAt: Date.now() }
				} as never)

			playlist.replace.mockClear()

			// Kick off first load (will hang)
			const firstPlay = audio.play()

			// Immediately race ahead to index 1 — this should supersede the first load
			await audio.skipTo(1)

			// Now resolve the first load
			resolveFirst({
				audio: { uri: "file:///cache/a.mp3" },
				metadata: { title: "Track A", cachedAt: Date.now() }
			})

			await firstPlay
			await flushMicrotasks()

			// The last replace call should be for track B (the winner)
			const replaceCalls = playlist.replace.mock.calls

			expect(replaceCalls.length).toBeGreaterThan(0)

			const lastReplaceCall = replaceCalls[replaceCalls.length - 1] as unknown[]
			const lastReplaceArg = lastReplaceCall[0] as { uri: string }

			expect(lastReplaceArg.uri).toBe("file:///cache/b.mp3")
		})

		it("stale load doesn't clear loading=false for newer load", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			let resolveFirst: (value: { audio: { uri: string }; metadata: { title: string; cachedAt: number } }) => void = () => {}

			const firstPromise = new Promise<{ audio: { uri: string }; metadata: { title: string; cachedAt: number } }>(r => {
				resolveFirst = r
			})

			vi.mocked(audioCache.get)
				.mockReset()
				.mockReturnValueOnce(firstPromise as never)
				.mockResolvedValue({
					audio: { uri: "file:///cache/b.mp3" },
					metadata: { title: "Track B", cachedAt: Date.now() }
				} as never)

			vi.mocked(events.emit).mockClear()

			const firstPlay = audio.play()

			await audio.skipTo(1)

			// Final load (B) has completed by here; emit log should end with loading=false for B
			const loadingEventsBefore = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")
			const lastBefore = loadingEventsBefore[loadingEventsBefore.length - 1]

			expect(lastBefore![1]).toBe(false)

			resolveFirst({
				audio: { uri: "file:///cache/a.mp3" },
				metadata: { title: "Track A", cachedAt: Date.now() }
			})

			await firstPlay
			await flushMicrotasks()

			// The final loading event should still be false (stale load didn't re-fire a stale false)
			const loadingEvents = vi.mocked(events.emit).mock.calls.filter(c => c[0] === "audioLoading")
			const last = loadingEvents[loadingEvents.length - 1]

			expect(last![1]).toBe(false)
		})
	})

	describe("addToQueue + shuffle (smell #1, fix #5)", () => {
		it("appended item is reachable via next() in same shuffle pass", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)
			// Ensure we start at shuffle position 0
			await audio.addToQueue({ item: makeQueueItem("d", "d.mp3") })

			// Walk forward at most 3 times and check whether we ever visit index 3
			let visitedNewItem = false

			for (let i = 0; i < 3; i++) {
				await audio.next()

				if (audio.getPosition() === 3) {
					visitedNewItem = true

					break
				}
			}

			expect(visitedNewItem).toBe(true)
		})

		it("appended item is inserted strictly AFTER the current shufflePosition", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			await audio.setShuffleEnabled(true)

			// Force Math.random → 0 so insertAt = shufflePosition + 1 (just after current)
			vi.spyOn(Math, "random").mockReturnValue(0)

			await audio.addToQueue({ item: makeQueueItem("d", "d.mp3") })

			// The new item (index 3) must be the very next track in shuffle order
			await audio.next()

			expect(audio.getPosition()).toBe(3)
		})
	})

	describe("getPlaylists (fix #1 - malformed)", () => {
		it("skips malformed JSON entries and returns the rest", async () => {
			const { audio } = await createAudio()

			// Stub getPlaylistsDirectory's underlying listDir + the playlist file listing
			mockSdkClient.listDir
				.mockResolvedValueOnce({
					dirs: [
						{
							meta: {
								tag: "Decoded",
								inner: [{ name: ".filen" }]
							}
						}
					],
					files: []
				})
				.mockResolvedValueOnce({
					dirs: [
						{
							meta: {
								tag: "Decoded",
								inner: [{ name: "Playlists" }]
							}
						}
					],
					files: []
				})
				.mockResolvedValueOnce({
					dirs: [],
					files: [
						{ uuid: "playlist-bad", meta: { tag: "Decoded", inner: [{ name: "bad.json" }] } },
						{ uuid: "playlist-good", meta: { tag: "Decoded", inner: [{ name: "good.json" }] } }
					]
				})

			const goodPlaylist = {
				uuid: "good-uuid",
				name: "Good Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			mockSdkClient.downloadFileToBytes
				.mockResolvedValueOnce(Buffer.from("not json{{{", "utf-8"))
				.mockResolvedValueOnce(Buffer.from(JSON.stringify(goodPlaylist), "utf-8"))

			mockSdkClient.getFileOptional.mockResolvedValue({ uuid: "any" })

			const result = await audio.getPlaylists()

			expect(result).toHaveLength(1)
			expect(result[0]!.uuid).toBe("good-uuid")
		})

		it("skips entries that fail arktype validation", async () => {
			const { audio } = await createAudio()

			mockSdkClient.listDir
				.mockResolvedValueOnce({
					dirs: [
						{
							meta: {
								tag: "Decoded",
								inner: [{ name: ".filen" }]
							}
						}
					],
					files: []
				})
				.mockResolvedValueOnce({
					dirs: [
						{
							meta: {
								tag: "Decoded",
								inner: [{ name: "Playlists" }]
							}
						}
					],
					files: []
				})
				.mockResolvedValueOnce({
					dirs: [],
					files: [
						{ uuid: "playlist-bad", meta: { tag: "Decoded", inner: [{ name: "bad.json" }] } },
						{ uuid: "playlist-good", meta: { tag: "Decoded", inner: [{ name: "good.json" }] } }
					]
				})

			const goodPlaylist = {
				uuid: "good-uuid",
				name: "Good Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			mockSdkClient.downloadFileToBytes
				.mockResolvedValueOnce(Buffer.from(JSON.stringify({}), "utf-8"))
				.mockResolvedValueOnce(Buffer.from(JSON.stringify(goodPlaylist), "utf-8"))

			mockSdkClient.getFileOptional.mockResolvedValue({ uuid: "any" })

			const result = await audio.getPlaylists()

			expect(result).toHaveLength(1)
			expect(result[0]!.uuid).toBe("good-uuid")
		})
	})

	describe("getPlaylists (fix #2 - rewrite-on-load)", () => {
		const setupCleanupScenario = () => {
			const playlistWithMissingFile = {
				uuid: "p-uuid",
				name: "Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: [
					{
						uuid: "missing-file",
						name: "song.mp3",
						mime: "audio/mpeg",
						size: 100,
						bucket: "b",
						key: "k",
						version: 2,
						chunks: 1,
						region: "r",
						playlist: "p-uuid"
					}
				]
			}

			// Every call to getPlaylists triggers: listDir(root) + listDir(.filen) + listDir(playlists)
			// followed by downloadFileToBytes per playlist file, then getFileOptional per file in playlist.
			mockSdkClient.listDir.mockImplementation(async () => ({
				dirs: [
					{
						meta: {
							tag: "Decoded",
							inner: [{ name: ".filen" }]
						}
					},
					{
						meta: {
							tag: "Decoded",
							inner: [{ name: "Playlists" }]
						}
					}
				],
				files: [{ uuid: "playlist-1", meta: { tag: "Decoded", inner: [{ name: "playlist-1.json" }] } }]
			}))

			mockSdkClient.downloadFileToBytes.mockResolvedValue(Buffer.from(JSON.stringify(playlistWithMissingFile), "utf-8"))

			mockSdkClient.getFileOptional.mockResolvedValue(null)
		}

		it("calls savePlaylist at most once per playlist UUID per session", async () => {
			const { audio } = await createAudio()

			setupCleanupScenario()

			await audio.getPlaylists()
			await flushMicrotasks()

			const firstCount = mockSdkClient.uploadFileFromBytes.mock.calls.length

			expect(firstCount).toBe(1)

			await audio.getPlaylists()
			await flushMicrotasks()

			const secondCount = mockSdkClient.uploadFileFromBytes.mock.calls.length

			expect(secondCount).toBe(1)
		})

		it("doesn't block read on cleanup", async () => {
			const { audio } = await createAudio()

			setupCleanupScenario()

			// Make the persistent write hang forever
			mockSdkClient.uploadFileFromBytes.mockImplementation(() => new Promise(() => {}))

			// getPlaylists must still resolve
			const result = await audio.getPlaylists()

			expect(result).toHaveLength(1)
			expect(result[0]!.uuid).toBe("p-uuid")
		})
	})
})
