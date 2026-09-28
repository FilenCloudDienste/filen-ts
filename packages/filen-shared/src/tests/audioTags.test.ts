import { describe, it, expect } from "vitest"
import { normalizeTrackTags } from "@filen/shared"

describe("normalizeTrackTags", () => {
	it("keeps real tags and rounds the duration to whole seconds", () => {
		expect(
			normalizeTrackTags({
				common: { title: "Song", artist: "Band", album: "Record", date: "1999" },
				format: { duration: 201.6 }
			})
		).toEqual({ title: "Song", artist: "Band", album: "Record", date: "1999", durationSec: 202 })
	})

	it("strips NUL terminators and whitespace, and reads a blank frame as no tag", () => {
		expect(normalizeTrackTags({ common: { title: "Song\u0000\u0000", artist: "  ", album: "\u0000" }, format: {} })).toEqual({
			title: "Song",
			artist: null,
			album: null,
			date: null,
			durationSec: null
		})
	})

	it("reads a null field as no tag", () => {
		expect(normalizeTrackTags({ common: { title: null, album: null, date: null }, format: { duration: null } })).toEqual({
			title: null,
			artist: null,
			album: null,
			date: null,
			durationSec: null
		})
	})

	it("falls back to the album artist when the track artist is missing or blank", () => {
		expect(normalizeTrackTags({ common: { artist: " ", albumartist: "Various" }, format: {} }).artist).toBe("Various")
		expect(normalizeTrackTags({ common: { albumartist: "Various" }, format: {} }).artist).toBe("Various")
		expect(normalizeTrackTags({ common: { artist: "Solo", albumartist: "Various" }, format: {} }).artist).toBe("Solo")
	})

	it("drops a missing, zero, negative or non-finite duration and keeps a sub-second clip at 1s", () => {
		expect(normalizeTrackTags({ common: {}, format: {} }).durationSec).toBeNull()
		expect(normalizeTrackTags({ common: {}, format: { duration: 0 } }).durationSec).toBeNull()
		expect(normalizeTrackTags({ common: {}, format: { duration: -3 } }).durationSec).toBeNull()
		expect(normalizeTrackTags({ common: {}, format: { duration: Number.NaN } }).durationSec).toBeNull()
		expect(normalizeTrackTags({ common: {}, format: { duration: Number.POSITIVE_INFINITY } }).durationSec).toBeNull()
		expect(normalizeTrackTags({ common: {}, format: { duration: 0.2 } }).durationSec).toBe(1)
	})
})
