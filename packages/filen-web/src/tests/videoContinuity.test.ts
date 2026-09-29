import { describe, expect, it, beforeEach } from "vitest"
import { getVideoPosition, setVideoPosition, clearVideoPlaybackStates } from "@/features/preview/lib/videoContinuity"

beforeEach(() => {
	clearVideoPlaybackStates()
})

describe("videoContinuity — write/apply lifecycle", () => {
	it("returns undefined for a uuid with no stored position", () => {
		expect(getVideoPosition("11111111-1111-1111-1111-111111111111")).toBeUndefined()
	})

	it("returns exactly what was written for a uuid", () => {
		setVideoPosition("aaaaaaaa-0000-0000-0000-000000000000", 12.5)

		expect(getVideoPosition("aaaaaaaa-0000-0000-0000-000000000000")).toBe(12.5)
	})

	it("keeps distinct uuids independent", () => {
		setVideoPosition("a", 1)
		setVideoPosition("b", 2)

		expect(getVideoPosition("a")).toBe(1)
		expect(getVideoPosition("b")).toBe(2)
	})

	it("overwrites a previous write for the same uuid rather than accumulating", () => {
		setVideoPosition("a", 1)
		setVideoPosition("a", 99)

		expect(getVideoPosition("a")).toBe(99)
	})
})

describe("videoContinuity — clear (overlay-session boundary)", () => {
	it("drops every stored position", () => {
		setVideoPosition("a", 1)
		setVideoPosition("b", 2)

		clearVideoPlaybackStates()

		expect(getVideoPosition("a")).toBeUndefined()
		expect(getVideoPosition("b")).toBeUndefined()
	})

	it("is a no-op on an already-empty map", () => {
		clearVideoPlaybackStates()

		expect(getVideoPosition("a")).toBeUndefined()
	})
})
