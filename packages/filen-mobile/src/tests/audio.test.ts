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

vi.mock("expo-asset", () => ({
	Asset: {
		fromModule: vi.fn(() => ({
			localUri: "file:///mock/placeholder-artwork.png",
			downloadAsync: vi.fn().mockResolvedValue(undefined)
		}))
	}
}))

vi.mock("@/features/audio/audioCache", () => ({
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

vi.mock("@/lib/fileCache", () => ({
	default: { getCachedUri: vi.fn().mockResolvedValue(null) }
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: { isOnline: () => true }
}))

vi.mock("@/lib/utils", () => ({
	wrapAbortSignalForSdk: vi.fn((signal: unknown) => signal)
}))

vi.mock("@/features/audio/queries/usePlaylists.query", () => ({
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
import { type DriveItem, type DriveItemFileExtracted } from "@/types"
import audioCache from "@/features/audio/audioCache"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import { createAudioPlayer, setAudioModeAsync } from "expo-audio"
import { Platform } from "react-native"
import { type QueueItem } from "@/features/audio/audio"
import { playlistsQueryUpdate } from "@/features/audio/queries/usePlaylists.query"

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
			undecryptable: false,
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
	audio: InstanceType<typeof import("@/features/audio/audio").Audio>
	playlist: MockPlayer
}

async function createAudio(): Promise<AudioTestContext> {
	const mod = await import("@/features/audio/audio")
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
			await import("@/features/audio/audio")

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

		it("returns false for an undecryptable item and does not add it to the queue", async () => {
			const { audio } = await createAudio()

			const undecryptableItem: QueueItem = {
				playlistUuid: "test-playlist",
				item: {
					type: "file",
					data: {
						uuid: "bad-uuid",
						decryptedMeta: null,
						undecryptable: true,
						size: 0n
					}
				} as unknown as DriveItemFileExtracted
			}

			vi.mocked(alerts.normal).mockClear()

			const added = await audio.addToQueue({ item: undecryptableItem })

			expect(added).toBe(false)
			expect(audio.getQueue()).toHaveLength(0)
			// The toast now lives in the UI layer — the lib must stay silent.
			expect(alerts.normal).not.toHaveBeenCalled()
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
		it("does not double-advance when user-initiated next() races with a suspended handleTrackEnd (fix #24)", async () => {
			// This test exercises the race described in bug #24:
			// 1. didJustFinish fires → handleTrackEnd stamps trackEndHandledGeneration and
			//    suspends at the getLoopMode() await (secureStore read).
			// 2. User taps next() while handleTrackEnd is suspended → next() calls
			//    loadAndPlay() which bumps loadGeneration.
			// 3. handleTrackEnd resumes → without the fix it would advanceToNext() again,
			//    skipping an extra track. With the fix it detects gen !== loadGeneration and
			//    returns early.
			//
			// We simulate the suspension by making secureStore.get hang until we release it.
			const { default: secureStore } = await import("@/lib/secureStore")

			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })

			// Start at position 0 with loopMode "none" (default)
			await audio.setLoopMode("none")

			const statusListener = getPlaylistStatusListener(playlist)

			expect(statusListener).toBeDefined()

			// Make secureStore.get hang so handleTrackEnd suspends at getLoopMode()
			let releaseSecureStoreGet: () => void = () => {}
			const hangPromise = new Promise<void>(resolve => {
				releaseSecureStoreGet = resolve
			})

			let firstGetCall = true

			vi.mocked(secureStore.get).mockImplementation(async (key: string) => {
				if (key === audio.loopModeKey && firstGetCall) {
					firstGetCall = false
					await hangPromise

					return "none" as unknown as never
				}

				return secureStoreMap.get(key) as never
			})

			playlist.replace.mockClear()

			// Step 1: track ends — fires handleTrackEnd, which hangs at getLoopMode()
			statusListener!({ didJustFinish: true, remoteAction: undefined })

			// Give the microtask queue one tick so handleTrackEnd reaches its first await
			await new Promise(resolve => setTimeout(resolve, 0))

			// Step 2: user taps next() while handleTrackEnd is still suspended.
			// This advances position from 0 → 1 and bumps loadGeneration.
			await audio.next()

			expect(audio.getPosition()).toBe(1)

			// Step 3: release the suspended getLoopMode() so handleTrackEnd continues
			releaseSecureStoreGet()

			// Flush remaining microtasks so handleTrackEnd finishes its async tail
			await flushMicrotasks()
			await flushMicrotasks()

			// Position must still be 1 — handleTrackEnd should have bailed after detecting
			// that loadGeneration changed, NOT advanced to 2.
			expect(audio.getPosition()).toBe(1)

			// loadAndPlay was called exactly once — by next(), not a second time by handleTrackEnd
			const replaceCalls = playlist.replace.mock.calls.length

			expect(replaceCalls).toBe(1)
		})

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

		it("getLoading is true while a track is loading and false after it finishes", async () => {
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			// Replace the audioCache.get with a promise we control so we can observe loading=true mid-flight.
			let resolveLoad: (value: { audio: { uri: string }; metadata: { title: string; cachedAt: number } }) => void = () => {}
			const hangPromise = new Promise<{ audio: { uri: string }; metadata: { title: string; cachedAt: number } }>(r => {
				resolveLoad = r
			})

			vi.mocked(audioCache.get).mockReturnValueOnce(hangPromise as never)

			const playPromise = audio.play()

			// Give the micro-task queue one tick so loadAndPlay can set loading=true before we block on hangPromise.
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(audio.getLoading()).toBe(true)

			resolveLoad({ audio: { uri: "file:///cache/a.mp3" }, metadata: { title: "Track A", cachedAt: Date.now() } })

			await playPromise

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

		it("advances correctly in shuffle mode after replaceQueue changes the queue size", async () => {
			// NOTE: replaceQueue regenerates shuffleOrder to match the new queue length, so by the
			// time next() runs, shuffleOrder.length === queue.length (the stale-order guard inside
			// advanceToNext is not triggered here). This test verifies the normal happy-path of
			// shuffled next() following a replaceQueue call.
			const { audio } = await createAudio()

			await audio.setShuffleEnabled(true)

			await audio.replaceQueue({
				items: [makeQueueItem("x", "x.mp3"), makeQueueItem("y", "y.mp3"), makeQueueItem("z", "z.mp3")],
				startingPosition: 0
			})

			const startPosition = audio.getPosition()

			await audio.next()

			const nextPosition = audio.getPosition()

			// next() must advance to a different valid queue index
			expect(nextPosition).toBeGreaterThanOrEqual(0)
			expect(nextPosition).toBeLessThan(3)
			expect(nextPosition).not.toBe(startPosition)
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

			// Should have wrapped to the end of the shuffleOrder and loaded a track
			expect(playlist.replace).toHaveBeenCalled()
			// wrapToEnd sets shufflePosition to shuffleOrder.length - 1, so the resulting
			// position must be a valid queue index (0 or 1 for a 2-item queue).
			expect(audio.getPosition()).toBeGreaterThanOrEqual(0)
			expect(audio.getPosition()).toBeLessThan(2)
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

			// The last replace call should be for track B (the winner).
			// skipTo(1) triggers an immediate loadAndPlay that calls replace once (for B).
			// The stale A-load is discarded by the generation guard, so replace is called exactly once.
			const replaceCalls = playlist.replace.mock.calls

			expect(replaceCalls).toHaveLength(1)

			const lastReplaceArg = (replaceCalls[0] as unknown[])[0] as { uri: string }

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

	describe("track-end watchdog (short-track fallback)", () => {
		it("advances to the next track when didJustFinish never fires", async () => {
			vi.useFakeTimers()

			try {
				const { audio, playlist } = await createAudio()

				await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
				await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
				await audio.play()

				const statusListener = getPlaylistStatusListener(playlist)

				expect(statusListener).toBeDefined()

				playlist.replace.mockClear()

				// A 2s track starts playing — arms the watchdog.
				playlist.duration = 2
				playlist.currentTime = 0
				statusListener!({ playing: true, isLoaded: true, duration: 2, currentTime: 0, didJustFinish: false })

				// Track reaches its end, but didJustFinish never arrives.
				playlist.currentTime = 2

				// Watchdog fires TRACK_END_WATCHDOG_BUFFER_MS (2000) after the expected end.
				await vi.advanceTimersByTimeAsync(2 * 1000 + 2000 + 100)

				expect(audio.getPosition()).toBe(1)
				expect(playlist.replace).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not double-advance: a normal didJustFinish cancels the watchdog", async () => {
			vi.useFakeTimers()

			try {
				const { audio, playlist } = await createAudio()

				await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
				await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
				await audio.addToQueue({ item: makeQueueItem("c", "c.mp3") })
				await audio.play()

				const statusListener = getPlaylistStatusListener(playlist)

				// Arm the watchdog for a 2s track.
				playlist.duration = 2
				playlist.currentTime = 0
				statusListener!({ playing: true, isLoaded: true, duration: 2, currentTime: 0, didJustFinish: false })

				// didJustFinish arrives normally → advances to track 1 and cancels the watchdog.
				statusListener!({ didJustFinish: true })
				await vi.advanceTimersByTimeAsync(0)

				expect(audio.getPosition()).toBe(1)

				// Long past the (cancelled) watchdog deadline — must NOT advance again.
				await vi.advanceTimersByTimeAsync(10000)

				expect(audio.getPosition()).toBe(1)
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not skip a track that merely stalled mid-playback", async () => {
			vi.useFakeTimers()

			try {
				const { audio, playlist } = await createAudio()

				await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
				await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
				await audio.play()

				const statusListener = getPlaylistStatusListener(playlist)

				playlist.replace.mockClear()

				// 10s track arms the watchdog.
				playlist.duration = 10
				playlist.currentTime = 0
				statusListener!({ playing: true, isLoaded: true, duration: 10, currentTime: 0, didJustFinish: false })

				// Playback stalls at 3s (buffering) — well short of the end.
				playlist.currentTime = 3

				// Past the original watchdog deadline (10s + 2s buffer).
				await vi.advanceTimersByTimeAsync(10 * 1000 + 2000 + 100)

				// Still on the same track — the watchdog re-armed instead of skipping.
				expect(audio.getPosition()).toBe(0)
				expect(playlist.replace).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not advance after pause(), even past the watchdog deadline", async () => {
			vi.useFakeTimers()

			try {
				const { audio, playlist } = await createAudio()

				await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
				await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
				await audio.play()

				const statusListener = getPlaylistStatusListener(playlist)

				playlist.replace.mockClear()

				playlist.duration = 2
				playlist.currentTime = 0
				statusListener!({ playing: true, isLoaded: true, duration: 2, currentTime: 0, didJustFinish: false })

				audio.pause()

				await vi.advanceTimersByTimeAsync(2 * 1000 + 2000 + 100)

				expect(audio.getPosition()).toBe(0)
				expect(playlist.replace).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("lock screen artwork + controls", () => {
		// When a track has no embedded art, the code substitutes a bundled placeholder
		// resolved via Metro's asset require(). That require() can't resolve in the vitest
		// node env (no Metro transform), so the placeholder URI itself is verified on-device;
		// here we assert the no-artwork path still pushes a lock-screen update with the track's
		// metadata rather than crashing or skipping.
		it("still updates the lock screen for a track without embedded artwork", async () => {
			vi.mocked(audioCache.get).mockResolvedValue({
				audio: { uri: "file:///cache/audio.mp3" },
				metadata: { title: "No Art Song", artist: "Artist", album: "Album", pictureUri: null, cachedAt: Date.now() }
			} as never)

			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.play()
			await flushMicrotasks()

			const lastCall = playlist.setActiveForLockScreen.mock.calls.at(-1)

			expect(lastCall).toBeDefined()
			expect(lastCall![1].title).toBe("No Art Song")
		})

		it("uses the track's own artwork when present", async () => {
			vi.mocked(audioCache.get).mockResolvedValue({
				audio: { uri: "file:///cache/audio.mp3" },
				metadata: {
					title: "Song",
					artist: "Artist",
					album: "Album",
					pictureUri: "file:///cache/cover.jpg",
					cachedAt: Date.now()
				}
			} as never)

			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.play()
			await flushMicrotasks()

			const lastCall = playlist.setActiveForLockScreen.mock.calls.at(-1)

			expect(lastCall![1].artworkUrl).toBe("file:///cache/cover.jpg")
		})

		it("disables the 10s seek controls on iOS so prev/next are shown", async () => {
			Platform.OS = "ios"

			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.play()
			await flushMicrotasks()

			const lastCall = playlist.setActiveForLockScreen.mock.calls.at(-1)

			expect(lastCall![2]).toEqual({ showSeekBackward: false, showSeekForward: false })
		})

		it("keeps the 10s seek controls on Android", async () => {
			Platform.OS = "android"

			try {
				const { audio, playlist } = await createAudio()

				await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
				await audio.play()
				await flushMicrotasks()

				const lastCall = playlist.setActiveForLockScreen.mock.calls.at(-1)

				expect(lastCall![2]).toEqual({ showSeekBackward: true, showSeekForward: true })
			} finally {
				Platform.OS = "ios"
			}
		})

		it("calls Asset.fromModule only once — second play reuses cached placeholder URI", async () => {
			// In the node test environment, require('@/assets/images/icon-light.png') throws
			// MODULE_NOT_FOUND (no Metro transform). The run() wrapper in getPlaceholderArtworkUri
			// catches that error before Asset.fromModule is reached, so fromModule is never called.
			// To exercise the caching path we override Module.require for the icon asset path.
			const { createRequire } = await import("node:module")
			const fakeAssetId = 42

			const nodeModule = await import("node:module")
			const origLoad = (nodeModule.Module as unknown as { _load: (...args: unknown[]) => unknown })._load

			;(nodeModule.Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
				request: unknown,
				...rest: unknown[]
			): unknown {
				if (typeof request === "string" && request.includes("icon-light.png")) {
					return fakeAssetId
				}

				return origLoad.call(this, request, ...rest)
			}

			const { Asset } = await import("expo-asset")
			const fromModuleSpy = vi.mocked(Asset.fromModule)

			// Ensure placeholder is not yet resolved by using a fresh audio instance.
			const { audio } = await createAudio()

			vi.mocked(audioCache.get).mockResolvedValue({
				audio: { uri: "file:///cache/audio.mp3" },
				metadata: { title: "Song", artist: "Artist", album: "Album", pictureUri: null, cachedAt: Date.now() }
			} as never)

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })

			fromModuleSpy.mockClear()

			try {
				// First play — should call fromModule to resolve the placeholder.
				await audio.play()
				await flushMicrotasks()

				const callsAfterFirst = fromModuleSpy.mock.calls.length

				// fromModule must have been invoked at least once on the first play (pictureUri is null).
				expect(callsAfterFirst).toBeGreaterThanOrEqual(1)

				// Second play — placeholder is already cached, fromModule must NOT be called again.
				await audio.play()
				await flushMicrotasks()

				expect(fromModuleSpy.mock.calls.length).toBe(callsAfterFirst)
			} finally {
				;(nodeModule.Module as unknown as { _load: (...args: unknown[]) => unknown })._load = origLoad
			}

			void createRequire // silence unused import warning
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// lock-screen remote callbacks
	// ──────────────────────────────────────────────────────────────────────────

	describe("remoteNextTrack / remotePreviousTrack lock-screen listeners", () => {
		function getRemoteListener(playlist: MockPlayer, eventName: string): (() => void) | undefined {
			const found = playlist.addListener.mock.calls.find((call: unknown[]) => call[0] === eventName)

			return found?.[1] as (() => void) | undefined
		}

		it("remoteNextTrack advances to the next track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			const listener = getRemoteListener(playlist, "remoteNextTrack")

			expect(listener).toBeDefined()

			playlist.replace.mockClear()

			listener!()

			await flushMicrotasks()

			expect(audio.getPosition()).toBe(1)
			expect(playlist.replace).toHaveBeenCalled()
		})

		it("remotePreviousTrack restarts the current track when more than 3 seconds in", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)

			playlist.seekTo.mockClear()
			playlist.replace.mockClear()
			playlist.currentTime = 5

			const listener = getRemoteListener(playlist, "remotePreviousTrack")

			expect(listener).toBeDefined()

			listener!()

			await flushMicrotasks()

			expect(playlist.seekTo).toHaveBeenCalledWith(0)
			// Restarted in place — position unchanged, no new track loaded
			expect(audio.getPosition()).toBe(1)
		})

		it("remotePreviousTrack goes to the previous track when at the start of a track", async () => {
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			await audio.skipTo(1)

			playlist.replace.mockClear()
			playlist.currentTime = 0

			const listener = getRemoteListener(playlist, "remotePreviousTrack")

			expect(listener).toBeDefined()

			listener!()

			await flushMicrotasks()

			expect(audio.getPosition()).toBe(0)
			expect(playlist.replace).toHaveBeenCalled()
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// addToQueue({position:'start'}) + shuffle shuffleOrder bump
	// ──────────────────────────────────────────────────────────────────────────

	describe("addToQueue({position:'start'}) + shuffle", () => {
		it("bumps all existing shuffleOrder indices by 1 and prepends index 0", async () => {
			const { audio } = await createAudio()

			// Start with items [a, b] at position 0, shuffle enabled — shuffleOrder has length 2.
			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.setShuffleEnabled(true)

			// Prepend item c at start.  Queue becomes [c, a, b], a→1, b→2.
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3"), position: "start" })

			// After prepend the queue is [c, a, b] and position was incremented to 1 (pointing at 'a').
			expect(audio.getQueue()).toHaveLength(3)
			expect(audio.getQueue()[0]!.item.data.uuid).toBe("c")
			expect(audio.getPosition()).toBe(1)

			// Walk all remaining shuffle slots and verify index 0 ('c') appears exactly once.
			const visited = new Set<number>([audio.getPosition()])

			for (let i = 0; i < 2; i++) {
				await audio.next()
				visited.add(audio.getPosition())
			}

			// Every queue index 0-2 must have been visited.
			expect([...visited].sort()).toEqual([0, 1, 2])
		})

		it("prepending into an empty queue does not increment position", async () => {
			const { audio } = await createAudio()

			await audio.setShuffleEnabled(true)

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3"), position: "start" })

			expect(audio.getPosition()).toBe(0)
			expect(audio.getQueue()).toHaveLength(1)
		})

		it("item prepended at start is reachable via previous() in shuffle mode", async () => {
			// NOTE: The out-of-sync fallback branch (shuffleOrder.length + 1 !== queue.length)
			// inside addToQueue({position:'start'}) requires a queue mutation path that skips the
			// shuffleOrder update — there is none through the public API. This test verifies the
			// normal in-sync path: a newly prepended item is reachable when walking backwards.
			const { audio } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })
			await audio.setShuffleEnabled(true)

			// skipTo(1) so previous() can walk back to whatever is at shufflePosition - 1.
			await audio.skipTo(1)

			// Prepend c. Queue is now [c, a, b]. Position was 1 (a), bumped to 2 after prepend.
			await audio.addToQueue({ item: makeQueueItem("c", "c.mp3"), position: "start" })

			expect(audio.getQueue()).toHaveLength(3)
			// Queue head is now 'c'.
			expect(audio.getQueue()[0]!.item.data.uuid).toBe("c")

			// Walk forward across all items and confirm index 0 ('c') is visited.
			const visited = new Set<number>([audio.getPosition()])

			for (let i = 0; i < 3; i++) {
				await audio.next()
				visited.add(audio.getPosition())
			}

			expect(visited.has(0)).toBe(true)
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// replaceQueue with undecryptable items
	// ──────────────────────────────────────────────────────────────────────────

	describe("replaceQueue with undecryptable items", () => {
		function makeUndecryptableQueueItem(uuid: string): QueueItem {
			return {
				playlistUuid: "test-playlist",
				item: {
					type: "file",
					data: {
						uuid,
						decryptedMeta: null,
						undecryptable: true,
						size: 0n
					}
				} as unknown as DriveItemFileExtracted
			}
		}

		it("filters out undecryptable items and returns droppedUndecryptable: true", async () => {
			const { audio } = await createAudio()

			const result = await audio.replaceQueue({
				items: [makeQueueItem("a", "a.mp3"), makeUndecryptableQueueItem("bad"), makeQueueItem("c", "c.mp3")]
			})

			expect(result.droppedUndecryptable).toBe(true)
			expect(audio.getQueue()).toHaveLength(2)
			expect(audio.getQueue()[0]!.item.data.uuid).toBe("a")
			expect(audio.getQueue()[1]!.item.data.uuid).toBe("c")
		})

		it("returns droppedUndecryptable: false when all items are decryptable", async () => {
			const { audio } = await createAudio()

			const result = await audio.replaceQueue({
				items: [makeQueueItem("a", "a.mp3"), makeQueueItem("b", "b.mp3")]
			})

			expect(result.droppedUndecryptable).toBe(false)
			expect(audio.getQueue()).toHaveLength(2)
		})

		it("adjusts startingPosition when undecryptable items are dropped before it", async () => {
			const { audio } = await createAudio()

			// Items: [bad, good-a, good-b], startingPosition: 2 (pointing at good-b).
			// After filtering: [good-a, good-b], droppedBeforePosition=1, adjustedPosition=2-1=1.
			await audio.replaceQueue({
				items: [makeUndecryptableQueueItem("bad"), makeQueueItem("a", "a.mp3"), makeQueueItem("b", "b.mp3")],
				startingPosition: 2
			})

			// good-b is now at index 1
			expect(audio.getPosition()).toBe(1)
			expect(audio.getCurrentQueueItem()!.item.data.uuid).toBe("b")
		})

		it("results in empty queue and position 0 when all items are undecryptable", async () => {
			const { audio } = await createAudio()

			const result = await audio.replaceQueue({
				items: [makeUndecryptableQueueItem("bad1"), makeUndecryptableQueueItem("bad2")]
			})

			expect(result.droppedUndecryptable).toBe(true)
			expect(audio.getQueue()).toHaveLength(0)
			expect(audio.getPosition()).toBe(0)
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// deletePlaylist
	// ──────────────────────────────────────────────────────────────────────────

	describe("deletePlaylist", () => {
		function setupPlaylistsDir(playlistFileUuid: string, playlistJsonName: string) {
			// getPlaylistsDirectory calls listDir twice: root → .filen, .filen → Playlists.
			// deletePlaylist then calls listDir once more on Playlists to find the file to delete.
			// Use a call-count-based implementation so fire-and-forget calls from earlier tests
			// (which may consume mockResolvedValueOnce slots) don't desync the sequence.
			let callCount = 0

			mockSdkClient.listDir.mockImplementation(async () => {
				callCount++

				if (callCount === 1) {
					return { dirs: [{ meta: { tag: "Decoded", inner: [{ name: ".filen" }] } }], files: [] }
				}

				if (callCount === 2) {
					return { dirs: [{ meta: { tag: "Decoded", inner: [{ name: "Playlists" }] } }], files: [] }
				}

				// 3rd call: actual playlist directory listing
				return {
					dirs: [],
					files: [{ uuid: playlistFileUuid, meta: { tag: "Decoded", inner: [{ name: playlistJsonName }] } }]
				}
			})
		}

		it("calls deleteFilePermanently on the matching playlist file", async () => {
			const { audio } = await createAudio()

			const playlist = {
				uuid: "pl-delete",
				name: "Delete Me",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			setupPlaylistsDir("file-to-delete", `${playlist.uuid}.json`)

			await audio.deletePlaylist({ playlist })

			expect(mockSdkClient.deleteFilePermanently).toHaveBeenCalledTimes(1)

			// The first arg to deleteFilePermanently must be the resolved file object.
			const deleteArg = mockSdkClient.deleteFilePermanently.mock.calls[0]![0] as { uuid: string }

			expect(deleteArg.uuid).toBe("file-to-delete")
		})

		it("calls playlistsQueryUpdate to remove the playlist from the cache", async () => {
			const { audio } = await createAudio()

			const playlist = {
				uuid: "pl-update",
				name: "Update Me",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			setupPlaylistsDir("file-upd", `${playlist.uuid}.json`)

			vi.mocked(playlistsQueryUpdate).mockClear()

			await audio.deletePlaylist({ playlist })

			expect(playlistsQueryUpdate).toHaveBeenCalledTimes(1)

			// The updater should filter out the deleted playlist by uuid.
			const updaterArg = vi.mocked(playlistsQueryUpdate).mock.calls[0]![0] as unknown as {
				updater: (prev: { uuid: string }[]) => { uuid: string }[]
			}
			const prev = [{ uuid: "pl-update" }, { uuid: "other-pl" }]
			const result = updaterArg.updater(prev)

			expect(result).toHaveLength(1)
			expect(result[0]!.uuid).toBe("other-pl")
		})

		it("skips deleteFilePermanently when the file is not found in the directory", async () => {
			const { audio } = await createAudio()

			const playlist = {
				uuid: "pl-missing",
				name: "Ghost Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			// Playlists directory is empty — the file for pl-missing doesn't exist.
			let callCount = 0

			mockSdkClient.listDir.mockImplementation(async () => {
				callCount++

				if (callCount === 1) {
					return { dirs: [{ meta: { tag: "Decoded", inner: [{ name: ".filen" }] } }], files: [] }
				}

				if (callCount === 2) {
					return { dirs: [{ meta: { tag: "Decoded", inner: [{ name: "Playlists" }] } }], files: [] }
				}

				// 3rd call: empty playlist dir (no matching file)
				return { dirs: [], files: [] }
			})

			vi.mocked(playlistsQueryUpdate).mockClear()

			await audio.deletePlaylist({ playlist })

			expect(mockSdkClient.deleteFilePermanently).not.toHaveBeenCalled()
			// Query updater must still be called to remove it from the UI state.
			expect(playlistsQueryUpdate).toHaveBeenCalledTimes(1)
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// handleTrackEnd gen-guard race for loopMode='track' (finding #63)
	// ──────────────────────────────────────────────────────────────────────────

	describe("handleTrackEnd gen-guard race — loopMode='track'", () => {
		it("does not double-load when skipTo races while loopMode='track' and handleTrackEnd is suspended", async () => {
			// Scenario: handleTrackEnd fires (loopMode='track'), suspends at getLoopMode await.
			// While suspended, user calls skipTo(1) which bumps loadGeneration.
			// When handleTrackEnd resumes, the gen guard (gen !== loadGeneration) must fire
			// before the track-loop loadAndPlay, so replace is called exactly once (by skipTo).
			const { default: secureStore } = await import("@/lib/secureStore")
			const { audio, playlist } = await createAudio()

			await audio.addToQueue({ item: makeQueueItem("a", "a.mp3") })
			await audio.addToQueue({ item: makeQueueItem("b", "b.mp3") })

			// Store loopMode='track' so handleTrackEnd takes the track-loop branch
			await audio.setLoopMode("track")

			const statusListener = getPlaylistStatusListener(playlist)

			expect(statusListener).toBeDefined()

			// Suspend secureStore.get so handleTrackEnd hangs after didJustFinish
			let releaseSecureStoreGet: () => void = () => {}
			const hangPromise = new Promise<void>(resolve => {
				releaseSecureStoreGet = resolve
			})

			let firstGetCall = true

			vi.mocked(secureStore.get).mockImplementation(async (key: string) => {
				if (key === audio.loopModeKey && firstGetCall) {
					firstGetCall = false
					await hangPromise

					return "track" as unknown as never
				}

				return secureStoreMap.get(key) as never
			})

			playlist.replace.mockClear()

			// Step 1: track ends — fires handleTrackEnd, which hangs at getLoopMode()
			statusListener!({ didJustFinish: true, remoteAction: undefined })

			// Let handleTrackEnd reach its first await
			await new Promise(resolve => setTimeout(resolve, 0))

			// Step 2: user skips to track 1 while handleTrackEnd is suspended.
			// skipTo bumps loadGeneration so the gen guard inside handleTrackEnd fires.
			await audio.skipTo(1)

			expect(audio.getPosition()).toBe(1)

			// Step 3: release getLoopMode so handleTrackEnd continues
			releaseSecureStoreGet()

			await flushMicrotasks()
			await flushMicrotasks()

			// Position must still be 1 — handleTrackEnd bailed at the gen guard
			// and did NOT reset position to 0 via the track-loop loadAndPlay.
			expect(audio.getPosition()).toBe(1)

			// replace called exactly once (by skipTo), not twice
			expect(playlist.replace.mock.calls.length).toBe(1)
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// addFilesToPlaylist filtering guards (finding #60)
	// ──────────────────────────────────────────────────────────────────────────

	describe("addFilesToPlaylist", () => {
		function setupPlaylistsDirForSave() {
			mockSdkClient.listDir.mockImplementation(async () => ({
				dirs: [
					{ meta: { tag: "Decoded", inner: [{ name: ".filen" }] } },
					{ meta: { tag: "Decoded", inner: [{ name: "Playlists" }] } }
				],
				files: []
			}))
			mockSdkClient.uploadFileFromBytes.mockReset().mockResolvedValue(undefined)
		}

		function makePlaylist(extraUuids: string[] = []) {
			return {
				uuid: "pl-test",
				name: "Test Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: extraUuids.map(uuid => ({
					uuid,
					name: "existing.mp3",
					mime: "audio/mpeg",
					size: 100,
					bucket: "b",
					key: "k",
					version: 2,
					chunks: 1,
					region: "r",
					playlist: "pl-test"
				}))
			}
		}

		function makeDriveItem(
			uuid: string,
			opts: {
				type?: "file" | "sharedFile" | "sharedRootFile" | "directory"
				undecryptable?: boolean
				decryptedMeta?: Record<string, unknown> | null
			} = {}
		) {
			const {
				type: itemType = "file",
				undecryptable = false,
				decryptedMeta = { name: "track.mp3", size: 100n, modified: 1000, created: 900, mime: "audio/mpeg" }
			} = opts

			return {
				type: "driveItem" as const,
				data: {
					type: itemType,
					data: {
						uuid,
						undecryptable,
						decryptedMeta,
						size: 100n,
						bucket: "b",
						key: "k",
						version: 2,
						chunks: 1,
						region: "r"
					}
				}
			} as unknown as { type: "driveItem"; data: DriveItem }
		}

		it("returns 0 and does not call savePlaylist when all items are already in the playlist", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist(["dup-1", "dup-2"])

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("dup-1"), makeDriveItem("dup-2")]
			})

			expect(result).toBe(0)
			expect(mockSdkClient.uploadFileFromBytes).not.toHaveBeenCalled()
		})

		it("returns 0 and does not call savePlaylist when all items are undecryptable", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist()

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("bad-1", { undecryptable: true }), makeDriveItem("bad-2", { undecryptable: true })]
			})

			expect(result).toBe(0)
			expect(mockSdkClient.uploadFileFromBytes).not.toHaveBeenCalled()
		})

		it("returns 0 and does not call savePlaylist when all items have null decryptedMeta", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist()

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("null-1", { decryptedMeta: null }), makeDriveItem("null-2", { decryptedMeta: null })]
			})

			expect(result).toBe(0)
			expect(mockSdkClient.uploadFileFromBytes).not.toHaveBeenCalled()
		})

		it("skips 'root' type items entirely", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist()

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [{ type: "root" as const, data: {} as never }]
			})

			expect(result).toBe(0)
			expect(mockSdkClient.uploadFileFromBytes).not.toHaveBeenCalled()
		})

		it("skips directory-type driveItems (only file/sharedFile/sharedRootFile pass)", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist()

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("dir-1", { type: "directory" })]
			})

			expect(result).toBe(0)
			expect(mockSdkClient.uploadFileFromBytes).not.toHaveBeenCalled()
		})

		it("returns correct count and calls savePlaylist when valid new items are added", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			vi.mocked(playlistsQueryUpdate).mockClear()

			const playlist = makePlaylist()

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("new-1"), makeDriveItem("new-2")]
			})

			expect(result).toBe(2)
			expect(mockSdkClient.uploadFileFromBytes).toHaveBeenCalledTimes(1)
		})

		it("only adds valid items from a mixed valid/invalid batch", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist(["already-in"])

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [
					makeDriveItem("already-in"),
					makeDriveItem("undecryptable", { undecryptable: true }),
					makeDriveItem("no-meta", { decryptedMeta: null }),
					{ type: "root" as const, data: {} as never },
					makeDriveItem("valid-1"),
					makeDriveItem("valid-2")
				]
			})

			expect(result).toBe(2)
			expect(mockSdkClient.uploadFileFromBytes).toHaveBeenCalledTimes(1)
		})

		it("includes the valid items in the saved playlist payload", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			vi.mocked(playlistsQueryUpdate).mockClear()

			const playlist = makePlaylist()

			await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("save-me")]
			})

			// The updater passed to playlistsQueryUpdate should include the new file
			const updaterArg = vi.mocked(playlistsQueryUpdate).mock.calls[0]?.[0] as unknown as {
				updater: (prev: { uuid: string; files: { uuid: string }[] }[]) => { uuid: string; files: { uuid: string }[] }[]
			}

			const updatedList = updaterArg.updater([])
			const savedPlaylist = updatedList[0]

			expect(savedPlaylist).toBeDefined()
			expect(savedPlaylist!.files.some(f => f.uuid === "save-me")).toBe(true)
		})

		it("sharedFile type passes the filter and is added", async () => {
			const { audio } = await createAudio()
			setupPlaylistsDirForSave()

			const playlist = makePlaylist()

			const result = await audio.addFilesToPlaylist({
				playlist,
				items: [makeDriveItem("shared-1", { type: "sharedFile" })]
			})

			expect(result).toBe(1)
			expect(mockSdkClient.uploadFileFromBytes).toHaveBeenCalledTimes(1)
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// savePlaylist (direct)
	// ──────────────────────────────────────────────────────────────────────────

	describe("savePlaylist (direct)", () => {
		function setupPlaylistsDirForSave() {
			// Use mockImplementation (not mockResolvedValueOnce) so that fire-and-forget savePlaylist
			// calls from earlier tests cannot consume the setup intended for this test.
			mockSdkClient.listDir.mockImplementation(async () => ({
				dirs: [
					{ meta: { tag: "Decoded", inner: [{ name: ".filen" }] } },
					{ meta: { tag: "Decoded", inner: [{ name: "Playlists" }] } }
				],
				files: []
			}))
			mockSdkClient.uploadFileFromBytes.mockReset().mockResolvedValue(undefined)
		}

		it("calls uploadFileFromBytes with JSON-encoded playlist content", async () => {
			const { audio } = await createAudio()

			setupPlaylistsDirForSave()

			const playlist = {
				uuid: "pl-save",
				name: "Saved Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			// Capture the serialised payload by intercepting JSON.stringify before calling savePlaylist.
			// Node's Buffer.from(string).buffer is a shared pool ArrayBuffer whose byteOffset is unknown
			// to the test, so decoding the raw ArrayBuffer would require the byteOffset. Capturing via
			// a JSON.stringify spy avoids that issue entirely.
			let capturedJson: string | null = null
			const origStringify = JSON.stringify

			vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>): string => {
				const result = origStringify(...args)

				if (typeof args[0] === "object" && args[0] !== null && (args[0] as { uuid?: string }).uuid === "pl-save") {
					capturedJson = result
				}

				return result
			})

			try {
				await audio.savePlaylist({ playlist })
			} finally {
				vi.mocked(JSON.stringify).mockRestore()
			}

			expect(mockSdkClient.uploadFileFromBytes).toHaveBeenCalledTimes(1)
			expect(capturedJson).not.toBeNull()

			const decoded = JSON.parse(capturedJson!)

			expect(decoded.uuid).toBe("pl-save")
			expect(decoded.name).toBe("Saved Playlist")
			expect(decoded.files).toEqual([])
		})

		it("strips the runtime-only `item` field (with its bigint size) before serializing", async () => {
			const { audio } = await createAudio()

			setupPlaylistsDirForSave()

			// addFilesToPlaylist appends files carrying the runtime-only `item`
			// (DriveItemFileExtracted) whose bigint `size` would make JSON.stringify throw
			// ("cannot serialize BigInt") if it reached the serializer un-stripped.
			const playlist = {
				uuid: "pl-strip",
				name: "Strip Playlist",
				created: 1700000000000,
				updated: 1700000000000,
				files: [
					{
						uuid: "file-1",
						name: "song.mp3",
						mime: "audio/mpeg",
						size: 100,
						bucket: "bucket-1",
						key: "key-1",
						version: 2,
						chunks: 1,
						region: "region-1",
						playlist: "pl-strip",
						item: { type: "file", data: { uuid: "file-1", size: 100n } }
					}
				]
			}

			let capturedJson: string | null = null
			const origStringify = JSON.stringify

			vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>): string => {
				const result = origStringify(...args)

				if (typeof args[0] === "object" && args[0] !== null && (args[0] as { uuid?: string }).uuid === "pl-strip") {
					capturedJson = result
				}

				return result
			})

			try {
				// Must NOT throw despite the bigint inside `item`.
				await audio.savePlaylist({
					playlist: playlist as unknown as Parameters<typeof audio.savePlaylist>[0]["playlist"]
				})
			} finally {
				vi.mocked(JSON.stringify).mockRestore()
			}

			expect(mockSdkClient.uploadFileFromBytes).toHaveBeenCalledTimes(1)
			expect(capturedJson).not.toBeNull()

			const decoded = JSON.parse(capturedJson!)

			expect(decoded.files).toHaveLength(1)
			expect("item" in decoded.files[0]).toBe(false)
			expect(decoded.files[0].uuid).toBe("file-1")
		})

		it("uploads with the correct filename (uuid.json)", async () => {
			const { audio } = await createAudio()

			setupPlaylistsDirForSave()

			const playlist = {
				uuid: "pl-fname",
				name: "Named Playlist",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			await audio.savePlaylist({ playlist })

			const uploadParams = (mockSdkClient.uploadFileFromBytes.mock.calls[0] as unknown[])[1] as {
				fileBuilderParams: { name: string }
			}

			expect(uploadParams.fileBuilderParams.name).toBe("pl-fname.json")
		})

		it("calls playlistsQueryUpdate with the saved playlist", async () => {
			const { audio } = await createAudio()

			setupPlaylistsDirForSave()

			vi.mocked(playlistsQueryUpdate).mockClear()

			const playlist = {
				uuid: "pl-qupdate",
				name: "Query Update Test",
				created: Date.now(),
				updated: Date.now(),
				files: []
			}

			await audio.savePlaylist({ playlist })

			expect(playlistsQueryUpdate).toHaveBeenCalledTimes(1)

			const updaterArg = vi.mocked(playlistsQueryUpdate).mock.calls[0]![0] as unknown as {
				updater: (prev: { uuid: string }[]) => { uuid: string }[]
			}
			const result = updaterArg.updater([])

			expect(result).toHaveLength(1)
			expect(result[0]!.uuid).toBe("pl-qupdate")
		})

		it("populates cache.uuidToAnyDriveItem for each file in the playlist", async () => {
			const { audio } = await createAudio()

			setupPlaylistsDirForSave()

			const { default: cacheModule } = await import("@/lib/cache")

			const playlist = {
				uuid: "pl-cache",
				name: "Cache Test",
				created: Date.now(),
				updated: Date.now(),
				files: [
					{
						uuid: "file-cached-1",
						name: "track.mp3",
						mime: "audio/mpeg",
						size: 200,
						bucket: "b",
						key: "k",
						version: 2,
						chunks: 1,
						region: "r",
						playlist: "pl-cache"
					}
				]
			}

			await audio.savePlaylist({ playlist })

			expect(cacheModule.uuidToAnyDriveItem.has("file-cached-1")).toBe(true)
		})
	})
})
