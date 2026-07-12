import { describe, expect, it } from "vitest"
import { parsePlaylist, serializePlaylist } from "@/features/audio/lib/playlistSchema"

function validPlaylistFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		name: "track.mp3",
		mime: "audio/mpeg",
		size: 1234,
		bucket: "bucket-1",
		key: "key-1",
		version: 2,
		chunks: 1,
		region: "region-1",
		playlist: "22222222-2222-2222-2222-222222222222",
		...overrides
	}
}

function validPlaylist(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		uuid: "22222222-2222-2222-2222-222222222222",
		name: "My playlist",
		created: 1_700_000_000_000,
		updated: 1_700_000_000_000,
		files: [validPlaylistFile()],
		...overrides
	}
}

describe("parsePlaylist", () => {
	it("accepts a structurally valid playlist", () => {
		const result = parsePlaylist(validPlaylist())

		expect(result).toEqual(validPlaylist())
	})

	it("accepts an empty files array", () => {
		const result = parsePlaylist(validPlaylist({ files: [] }))

		expect(result).not.toBeNull()
		expect(result?.files).toEqual([])
	})

	it("tolerates unknown extra fields at the playlist level", () => {
		const result = parsePlaylist(validPlaylist({ futureField: "anything", nested: { a: 1 } }))

		expect(result).not.toBeNull()
		expect(result?.uuid).toBe("22222222-2222-2222-2222-222222222222")
	})

	it("tolerates unknown extra fields on a file entry", () => {
		const result = parsePlaylist(validPlaylist({ files: [validPlaylistFile({ coverArtUuid: "future-field" })] }))

		expect(result).not.toBeNull()
		expect(result?.files).toHaveLength(1)
	})

	it.each([
		["null", null],
		["a string", "not an object"],
		["an array", []],
		["missing uuid", validPlaylist({ uuid: undefined })],
		["missing name", validPlaylist({ name: undefined })],
		["a non-number created", validPlaylist({ created: "1700000000000" })],
		["a non-number updated", validPlaylist({ updated: "1700000000000" })],
		["a non-array files", validPlaylist({ files: "not-an-array" })]
	])("rejects the whole playlist — %s", (_label, value) => {
		expect(parsePlaylist(value)).toBeNull()
	})

	it("rejects the whole playlist when ONE file entry is malformed (isolation happens per-playlist, not per-file)", () => {
		const result = parsePlaylist(validPlaylist({ files: [validPlaylistFile(), validPlaylistFile({ size: "not-a-number" })] }))

		expect(result).toBeNull()
	})

	it.each([
		["missing uuid", { uuid: undefined }],
		["missing mime", { mime: undefined }],
		["a non-number size", { size: "1234" }],
		["a non-number version", { version: "2" }],
		["a non-number chunks", { chunks: "1" }],
		["missing playlist owner uuid", { playlist: undefined }]
	])("rejects a playlist whose file entry is malformed — %s", (_label, override) => {
		expect(parsePlaylist(validPlaylist({ files: [validPlaylistFile(override)] }))).toBeNull()
	})
})

describe("serializePlaylist", () => {
	it("round-trips through JSON.parse + parsePlaylist unchanged", () => {
		const playlist = parsePlaylist(validPlaylist())

		if (playlist === null) {
			throw new Error("expected parsePlaylist(validPlaylist()) to succeed")
		}

		const roundTripped = parsePlaylist(JSON.parse(serializePlaylist(playlist)))

		expect(roundTripped).toEqual(playlist)
	})
})
