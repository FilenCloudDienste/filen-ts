import { describe, expect, it, beforeEach } from "vitest"
import { getVideoPlaybackState, setVideoPlaybackState, clearVideoPlaybackStates } from "@/features/preview/lib/videoContinuity"

beforeEach(() => {
	clearVideoPlaybackStates()
})

describe("videoContinuity — write/apply lifecycle", () => {
	it("returns undefined for a uuid with no stored position", () => {
		expect(getVideoPlaybackState("11111111-1111-1111-1111-111111111111")).toBeUndefined()
	})

	it("returns exactly what was written for a uuid", () => {
		setVideoPlaybackState("aaaaaaaa-0000-0000-0000-000000000000", { currentTime: 12.5, wasPlaying: true })

		expect(getVideoPlaybackState("aaaaaaaa-0000-0000-0000-000000000000")).toEqual({ currentTime: 12.5, wasPlaying: true })
	})

	it("keeps distinct uuids independent", () => {
		setVideoPlaybackState("a", { currentTime: 1, wasPlaying: true })
		setVideoPlaybackState("b", { currentTime: 2, wasPlaying: false })

		expect(getVideoPlaybackState("a")).toEqual({ currentTime: 1, wasPlaying: true })
		expect(getVideoPlaybackState("b")).toEqual({ currentTime: 2, wasPlaying: false })
	})

	it("overwrites a previous write for the same uuid rather than accumulating", () => {
		setVideoPlaybackState("a", { currentTime: 1, wasPlaying: true })
		setVideoPlaybackState("a", { currentTime: 99, wasPlaying: false })

		expect(getVideoPlaybackState("a")).toEqual({ currentTime: 99, wasPlaying: false })
	})
})

describe("videoContinuity — clear (overlay-session boundary)", () => {
	it("drops every stored position", () => {
		setVideoPlaybackState("a", { currentTime: 1, wasPlaying: true })
		setVideoPlaybackState("b", { currentTime: 2, wasPlaying: false })

		clearVideoPlaybackStates()

		expect(getVideoPlaybackState("a")).toBeUndefined()
		expect(getVideoPlaybackState("b")).toBeUndefined()
	})

	it("is a no-op on an already-empty map", () => {
		clearVideoPlaybackStates()

		expect(getVideoPlaybackState("a")).toBeUndefined()
	})
})
