import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockDriveItemDisplayName } = vi.hoisted(() => {
	const mockDriveItemDisplayName = vi.fn((item: unknown) => `undecryptable:${(item as { data: { uuid: string } }).data.uuid}`)

	return { mockDriveItemDisplayName }
})

vi.mock("@/lib/decryption", () => ({
	driveItemDisplayName: mockDriveItemDisplayName
}))

// ---------------------------------------------------------------------------
// Real module under test
// ---------------------------------------------------------------------------

import { resolveAudioTrackLabels, type AudioTrackLabels } from "@/features/audio/utils"
import type { QueueItem } from "@/features/audio/audio"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LABELS = {
	notPlaying: "Not playing",
	unknownTitle: "Unknown title",
	unknownArtist: "Unknown artist"
}

function makeQueueItem(overrides: {
	uuid?: string
	undecryptable?: boolean
	decryptedName?: string | null
}): QueueItem {
	const { uuid = "test-uuid", undecryptable = false, decryptedName = null } = overrides

	return {
		playlistUuid: "playlist-1",
		item: {
			type: "file",
			data: {
				uuid,
				undecryptable,
				decryptedMeta: decryptedName !== null ? ({ name: decryptedName } as never) : null
			} as never
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveAudioTrackLabels", () => {
	beforeEach(() => {
		mockDriveItemDisplayName.mockClear()
	})

	describe("no active track (queueItem = null)", () => {
		it("returns notPlaying for both title and artist", () => {
			const result = resolveAudioTrackLabels(null, false, undefined, undefined, LABELS)

			expect(result.titleLabel).toBe("Not playing")
			expect(result.artistLabel).toBe("Not playing")
		})

		it("returns notPlaying even when metadata is loaded (edge: queueItem cleared mid-load)", () => {
			const result = resolveAudioTrackLabels(null, true, "Some Title", "Some Artist", LABELS)

			expect(result.titleLabel).toBe("Not playing")
			expect(result.artistLabel).toBe("Not playing")
		})
	})

	describe("active track — metadata loaded (status === success)", () => {
		it("shows metadata title and artist when both are present", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: "track.mp3" })
			const result = resolveAudioTrackLabels(queueItem, true, "My Song", "My Artist", LABELS)

			expect(result.titleLabel).toBe("My Song")
			expect(result.artistLabel).toBe("My Artist")
		})

		it("falls back to decryptedMeta.name when metadata title is null", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: "track.mp3" })
			const result = resolveAudioTrackLabels(queueItem, true, null, null, LABELS)

			expect(result.titleLabel).toBe("track.mp3")
			expect(result.artistLabel).toBe("Unknown artist")
		})

		it("falls back to unknownTitle when metadata title and decryptedMeta are both null", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: null })
			const result = resolveAudioTrackLabels(queueItem, true, undefined, undefined, LABELS)

			expect(result.titleLabel).toBe("Unknown title")
			expect(result.artistLabel).toBe("Unknown artist")
		})

		it("uses driveItemDisplayName for undecryptable items (success branch)", () => {
			const queueItem = makeQueueItem({ uuid: "enc-uuid", undecryptable: true })
			const result = resolveAudioTrackLabels(queueItem, true, "ignored", "Artist", LABELS)

			expect(mockDriveItemDisplayName).toHaveBeenCalledWith(queueItem.item)
			expect(result.titleLabel).toBe("undecryptable:enc-uuid")
			expect(result.artistLabel).toBe("Artist")
		})
	})

	describe("active track — metadata still loading (status !== success) — the bug case", () => {
		it("does NOT return notPlaying when a track is active but metadata is loading", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: "my-song.mp3" })
			const result = resolveAudioTrackLabels(queueItem, false, undefined, undefined, LABELS)

			expect(result.titleLabel).not.toBe("Not playing")
			expect(result.artistLabel).not.toBe("Not playing")
		})

		it("shows decryptedMeta.name as title while metadata loads", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: "my-song.mp3" })
			const result = resolveAudioTrackLabels(queueItem, false, undefined, undefined, LABELS)

			expect(result.titleLabel).toBe("my-song.mp3")
		})

		it("shows unknownArtist while metadata loads (no premature artist info)", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: "my-song.mp3" })
			const result = resolveAudioTrackLabels(queueItem, false, undefined, undefined, LABELS)

			expect(result.artistLabel).toBe("Unknown artist")
		})

		it("falls back to unknownTitle when decryptedMeta is null and metadata not yet loaded", () => {
			const queueItem = makeQueueItem({ uuid: "abc", decryptedName: null })
			const result = resolveAudioTrackLabels(queueItem, false, undefined, undefined, LABELS)

			expect(result.titleLabel).toBe("Unknown title")
			expect(result.artistLabel).toBe("Unknown artist")
		})

		it("uses driveItemDisplayName for undecryptable items while loading", () => {
			const queueItem = makeQueueItem({ uuid: "enc-uuid", undecryptable: true })
			const result = resolveAudioTrackLabels(queueItem, false, undefined, undefined, LABELS)

			expect(mockDriveItemDisplayName).toHaveBeenCalledWith(queueItem.item)
			expect(result.titleLabel).toBe("undecryptable:enc-uuid")
			expect(result.artistLabel).toBe("Unknown artist")
		})
	})

	describe("label object shape", () => {
		it("always returns an object with titleLabel and artistLabel string properties", () => {
			const cases: Array<Parameters<typeof resolveAudioTrackLabels>> = [
				[null, false, undefined, undefined, LABELS],
				[makeQueueItem({ decryptedName: "a.mp3" }), false, undefined, undefined, LABELS],
				[makeQueueItem({ decryptedName: "a.mp3" }), true, "T", "A", LABELS]
			]

			for (const args of cases) {
				const result: AudioTrackLabels = resolveAudioTrackLabels(...args)

				expect(typeof result.titleLabel).toBe("string")
				expect(typeof result.artistLabel).toBe("string")
			}
		})
	})
})
