import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Module boundary mocks ───────────────────────────────────────────────────

vi.mock("expo-video", () => ({
	createVideoPlayer: vi.fn(() => ({
		loop: true,
		staysActiveInBackground: true,
		play: vi.fn(),
		pause: vi.fn(),
		release: vi.fn()
	}))
}))

// ─── Actual import ───────────────────────────────────────────────────────────

import { createVideoPlayer } from "expo-video"
import { GalleryVideoPlayers, MAX_GALLERY_VIDEO_PLAYERS } from "@/components/drivePreview/galleryVideoPlayers"

type MockPlayer = {
	loop: boolean
	staysActiveInBackground: boolean
	play: ReturnType<typeof vi.fn>
	pause: ReturnType<typeof vi.fn>
	release: ReturnType<typeof vi.fn>
}

function createdPlayers(): MockPlayer[] {
	return vi.mocked(createVideoPlayer).mock.results.map(result => result.value as MockPlayer)
}

describe("galleryVideoPlayers", () => {
	let manager: GalleryVideoPlayers

	beforeEach(() => {
		vi.clearAllMocks()

		manager = new GalleryVideoPlayers()
	})

	it("creates a configured, autoplaying player once per key", () => {
		const player = manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		}) as unknown as MockPlayer

		expect(createVideoPlayer).toHaveBeenCalledTimes(1)
		expect(createVideoPlayer).toHaveBeenCalledWith("http://localhost/a.mp4")
		expect(player.loop).toBe(false)
		expect(player.staysActiveInBackground).toBe(false)
		expect(player.play).toHaveBeenCalledTimes(1)
	})

	it("returns the SAME player on re-acquire without recreating or replaying", () => {
		const first = manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		})
		const second = manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		})

		expect(second).toBe(first)
		expect(createVideoPlayer).toHaveBeenCalledTimes(1)
		expect((first as unknown as MockPlayer).play).toHaveBeenCalledTimes(1)
	})

	it("pauseAllExcept pauses every player but the given key", () => {
		manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		})
		manager.acquire({
			key: "b",
			fileUrl: "http://localhost/b.mp4"
		})
		manager.acquire({
			key: "c",
			fileUrl: "http://localhost/c.mp4"
		})

		manager.pauseAllExcept("b")

		const [a, b, c] = createdPlayers()

		expect(a?.pause).toHaveBeenCalledTimes(1)
		expect(b?.pause).not.toHaveBeenCalled()
		expect(c?.pause).toHaveBeenCalledTimes(1)
	})

	it("pauseAllExcept(null) pauses everything", () => {
		manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		})
		manager.acquire({
			key: "b",
			fileUrl: "http://localhost/b.mp4"
		})

		manager.pauseAllExcept(null)

		for (const player of createdPlayers()) {
			expect(player.pause).toHaveBeenCalledTimes(1)
		}
	})

	it("releaseAll releases every player and clears the cache", () => {
		const first = manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		}) as unknown as MockPlayer

		manager.releaseAll()

		expect(first.release).toHaveBeenCalledTimes(1)

		const recreated = manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		})

		expect(recreated).not.toBe(first)
		expect(createVideoPlayer).toHaveBeenCalledTimes(2)
	})

	it("releaseAll PAUSES before releasing — release() alone leaves iOS AVPlayer audio playing", () => {
		const player = manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		}) as unknown as MockPlayer

		manager.releaseAll()

		expect(player.pause).toHaveBeenCalledTimes(1)
		expect(player.release).toHaveBeenCalledTimes(1)
		// The pause must land before the release: on iOS the AVPlayer keeps playing until the
		// wrapper deallocs (deferred by lingering native holders), so pausing first is what
		// actually silences it (regression guard for the dismiss-keeps-playing bug).
		const pauseOrder = player.pause.mock.invocationCallOrder[0] ?? Infinity
		const releaseOrder = player.release.mock.invocationCallOrder[0] ?? -Infinity

		expect(pauseOrder).toBeLessThan(releaseOrder)
	})

	it("LRU eviction also pauses before releasing the evicted player", () => {
		for (let i = 0; i < MAX_GALLERY_VIDEO_PLAYERS + 1; i++) {
			manager.acquire({
				key: `key-${i}`,
				fileUrl: `http://localhost/${i}.mp4`
			})
		}

		const evicted = createdPlayers()[0]

		expect(evicted?.pause).toHaveBeenCalledTimes(1)
		expect(evicted?.release).toHaveBeenCalledTimes(1)
	})

	it("evicts and releases the least-recently-used player beyond the cap", () => {
		for (let i = 0; i < MAX_GALLERY_VIDEO_PLAYERS + 1; i++) {
			manager.acquire({
				key: `key-${i}`,
				fileUrl: `http://localhost/${i}.mp4`
			})
		}

		const players = createdPlayers()

		expect(players[0]?.release).toHaveBeenCalledTimes(1)

		for (const player of players.slice(1)) {
			expect(player.release).not.toHaveBeenCalled()
		}

		// The evicted key starts over with a fresh player.
		manager.acquire({
			key: "key-0",
			fileUrl: "http://localhost/0.mp4"
		})

		expect(createVideoPlayer).toHaveBeenCalledTimes(MAX_GALLERY_VIDEO_PLAYERS + 2)
	})

	it("re-acquiring bumps recency so the active player is never evicted", () => {
		for (let i = 0; i < MAX_GALLERY_VIDEO_PLAYERS; i++) {
			manager.acquire({
				key: `key-${i}`,
				fileUrl: `http://localhost/${i}.mp4`
			})
		}

		// key-0 becomes most recent again (e.g. its cell re-rendered).
		manager.acquire({
			key: "key-0",
			fileUrl: "http://localhost/0.mp4"
		})

		manager.acquire({
			key: "key-new",
			fileUrl: "http://localhost/new.mp4"
		})

		const players = createdPlayers()

		expect(players[0]?.release).not.toHaveBeenCalled()
		expect(players[1]?.release).toHaveBeenCalledTimes(1)
	})

	it("survives players that throw on release (already released natively)", () => {
		manager.acquire({
			key: "a",
			fileUrl: "http://localhost/a.mp4"
		})

		const [a] = createdPlayers()

		a?.release.mockImplementation(() => {
			throw new Error("already released")
		})

		expect(() => manager.releaseAll()).not.toThrow()
	})
})
