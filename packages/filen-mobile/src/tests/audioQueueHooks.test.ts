// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))

vi.mock("expo-audio", () => ({
	createAudioPlayer: vi.fn(() => ({
		addListener: vi.fn(),
		play: vi.fn(),
		pause: vi.fn(),
		replace: vi.fn(),
		seekTo: vi.fn().mockResolvedValue(undefined),
		setActiveForLockScreen: vi.fn(),
		updateLockScreenMetadata: vi.fn(),
		clearLockScreenControls: vi.fn(),
		remove: vi.fn(),
		playing: false,
		paused: false,
		isLoaded: false,
		loop: false,
		currentTime: 0,
		duration: 0
	})),
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
		get: vi.fn()
	}
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: vi.fn(async () => undefined),
		set: vi.fn(async () => {}),
		delete: vi.fn(async () => {})
	},
	useSecureStore: vi.fn(() => [undefined, vi.fn()])
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn()
	}
}))

vi.mock("@/features/audio/queries/usePlaylists.query", () => ({
	playlistsQueryUpdate: vi.fn(),
	playlistsQueryGet: vi.fn(() => []),
	playlistPatchedSinceNow: () => () => false
}))

vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({
	markDirectorySizesStale: vi.fn()
}))

vi.mock("@/lib/signals", () => ({
	toSignalOpts: () => undefined,
	wrapAbortSignalForSdk: (signal: AbortSignal) => signal,
	disposeSdkAbortSignal: () => {}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {},
	AnyFile: {},
	DirMeta_Tags: { Decoded: "Decoded" },
	FileMeta_Tags: { Decoded: "Decoded" },
	FileMeta: {},
	ParentUuid: {}
}))

vi.mock("react-native-quick-crypto", async () => {
	const { Buffer } = await import("node:buffer")

	return {
		Buffer
	}
})

import { renderHook, act } from "@testing-library/react"
import audio, { useAudioQueue, useAudioQueueSelector, useIsCurrentTrack, type QueueItem } from "@/features/audio/audio"
import { type DriveItemFileExtracted } from "@/types"
import { driveFileItem } from "@/tests/fixtures/driveItems"

function makeQueueItem(uuid: string, playlistUuid = "playlist-a"): QueueItem {
	return {
		playlistUuid,
		item: driveFileItem("file", uuid, `${uuid}.mp3`, "audio/mpeg") as DriveItemFileExtracted
	}
}

beforeEach(async () => {
	await act(async () => {
		await audio.replaceQueue({ items: [] })
	})
})

describe("useAudioQueue", () => {
	it("returns queue[position] and follows position and queue changes", async () => {
		const a = makeQueueItem("a")
		const b = makeQueueItem("b")

		await act(async () => {
			await audio.replaceQueue({ items: [a, b], startingPosition: 1 })
		})

		const { result } = renderHook(() => useAudioQueue())

		expect(result.current.queueItem).toBe(b)

		await act(async () => {
			await audio.replaceQueue({ items: [a, b], startingPosition: 0 })
		})

		expect(result.current.queueItem).toBe(a)

		await act(async () => {
			await audio.replaceQueue({ items: [] })
		})

		expect(result.current.queueItem).toBeNull()
	})

	it("lands on the prepended-past item after addToQueue at the start", async () => {
		const a = makeQueueItem("a")
		const b = makeQueueItem("b")

		await act(async () => {
			await audio.replaceQueue({ items: [a] })
		})

		const { result } = renderHook(() => useAudioQueue())

		await act(async () => {
			await audio.addToQueue({ item: b, position: "start" })
		})

		expect(result.current.queueItem).toBe(a)
	})
})

describe("useAudioQueueSelector", () => {
	it("does not re-render when a queue mutation leaves the current item unchanged", async () => {
		const a = makeQueueItem("a")

		await act(async () => {
			await audio.replaceQueue({ items: [a] })
		})

		let renders = 0

		const { result } = renderHook(() => {
			renders++

			return useAudioQueueSelector(current => current)
		})

		const rendersBefore = renders

		await act(async () => {
			await audio.addToQueue({ item: makeQueueItem("b") })
		})

		expect(result.current).toBe(a)
		expect(renders).toBe(rendersBefore)
	})
})

describe("useIsCurrentTrack", () => {
	it("matches by file and, when given, by playlist", async () => {
		await act(async () => {
			await audio.replaceQueue({ items: [makeQueueItem("a", "playlist-a"), makeQueueItem("b", "playlist-a")] })
		})

		const { result } = renderHook(() => ({
			fileOnly: useIsCurrentTrack("a"),
			samePlaylist: useIsCurrentTrack("a", "playlist-a"),
			otherPlaylist: useIsCurrentTrack("a", "playlist-b"),
			otherFile: useIsCurrentTrack("b", "playlist-a")
		}))

		expect(result.current).toEqual({ fileOnly: true, samePlaylist: true, otherPlaylist: false, otherFile: false })

		await act(async () => {
			await audio.replaceQueue({ items: [makeQueueItem("a", "playlist-a"), makeQueueItem("b", "playlist-a")], startingPosition: 1 })
		})

		expect(result.current).toEqual({ fileOnly: false, samePlaylist: false, otherPlaylist: false, otherFile: true })
	})
})
