// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest"

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
import type { AudioStatus } from "expo-audio"
import audio, { useAudio, useAudioLoading, useAudioPlaying } from "@/features/audio/audio"
import events from "@/lib/events"

function makeStatus(playing: boolean, currentTime: number): AudioStatus {
	return { playing, currentTime } as AudioStatus
}

describe("useAudioPlaying", () => {
	it("follows audioStatus.playing and skips ticks that leave it unchanged", () => {
		let renders = 0

		const { result } = renderHook(() => {
			renders++

			return useAudioPlaying()
		})

		expect(result.current).toBe(audio.getStatus()?.playing ?? false)

		act(() => {
			events.emit("audioStatus", makeStatus(true, 1))
		})

		expect(result.current).toBe(true)

		const rendersWhilePlaying = renders

		for (let second = 2; second <= 60; second++) {
			act(() => {
				events.emit("audioStatus", makeStatus(true, second))
			})
		}

		// React may render once more before its eager same-value bailout kicks in.
		expect(renders).toBeLessThanOrEqual(rendersWhilePlaying + 1)

		act(() => {
			events.emit("audioStatus", makeStatus(false, 60))
		})

		expect(result.current).toBe(false)
	})
})

describe("useAudioLoading", () => {
	it("seeds from audio.getLoading() and follows audioLoading, matching useAudio", () => {
		const { result } = renderHook(() => ({
			loading: useAudioLoading(),
			fromUseAudio: useAudio().loading
		}))

		expect(result.current).toEqual({ loading: audio.getLoading(), fromUseAudio: audio.getLoading() })

		act(() => {
			events.emit("audioLoading", true)
		})

		expect(result.current).toEqual({ loading: true, fromUseAudio: true })

		act(() => {
			events.emit("audioLoading", false)
		})

		expect(result.current).toEqual({ loading: false, fromUseAudio: false })
	})
})
