// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { MediaSessionHandler } from "@/lib/media/mediaSessionOwner"

const handlers = vi.hoisted(() => new Map<string, MediaSessionHandler>())
const setPositionState = vi.hoisted(() => vi.fn())

vi.mock("@/lib/media/mediaSessionOwner", () => ({
	mediaSessionOwners: {
		create: () => ({
			acquire: () => undefined,
			release: () => undefined,
			setOnPreempt: () => undefined,
			setMetadata: () => undefined,
			setPlaybackState: () => undefined,
			setPositionState,
			setActionHandler: (action: string, handler: MediaSessionHandler) => {
				handlers.set(action, handler)
			}
		})
	}
}))

import { useStageMediaSession } from "@/components/media/video/useStageMediaSession"

describe("useStageMediaSession", () => {
	it("counts every OS media control as the user touching the player (still watching)", () => {
		const video = document.createElement("video")
		const onInteraction = vi.fn()
		const onNext = vi.fn()

		video.pause = vi.fn()
		renderHook(() => {
			useStageMediaSession({ video, info: { title: "T", artist: "", artworkUrl: null }, onNext, onPrevious: null, onInteraction })
		})

		handlers.get("pause")?.({ action: "pause" })
		handlers.get("seekforward")?.({ action: "seekforward" })
		handlers.get("nexttrack")?.({ action: "nexttrack" })

		expect(onInteraction).toHaveBeenCalledTimes(3)
		expect(onNext).toHaveBeenCalledTimes(1)
		expect(handlers.get("previoustrack")).toBeNull()
	})

	it("re-anchors the published position at both edges of a buffering stall, never per timeupdate", () => {
		const video = document.createElement("video")

		Object.defineProperty(video, "duration", { value: 120 })
		video.currentTime = 42
		renderHook(() => {
			useStageMediaSession({ video, info: { title: "T", artist: "", artworkUrl: null }, onNext: null, onPrevious: null })
		})
		setPositionState.mockClear()

		video.dispatchEvent(new Event("timeupdate"))

		expect(setPositionState).not.toHaveBeenCalled()

		video.dispatchEvent(new Event("waiting"))

		expect(setPositionState).toHaveBeenCalledTimes(1)
		expect(setPositionState).toHaveBeenLastCalledWith({ duration: 120, position: 42, playbackRate: 1 })

		video.dispatchEvent(new Event("playing"))

		expect(setPositionState).toHaveBeenCalledTimes(2)
		expect(setPositionState).toHaveBeenLastCalledWith({ duration: 120, position: 42, playbackRate: 1 })
	})
})
