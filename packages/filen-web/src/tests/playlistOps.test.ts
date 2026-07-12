import { describe, expect, it } from "vitest"
import {
	addTracksToPlaylist,
	createPlaylist,
	moveArrayItem,
	pruneDeadTracks,
	removeTracksFromPlaylist,
	renamePlaylist,
	reorderPlaylistFile
} from "@/features/audio/lib/playlistOps"
import type { Playlist, PlaylistFile } from "@/features/audio/lib/playlistSchema"

function file(uuid: string, overrides: Partial<PlaylistFile> = {}): PlaylistFile {
	return {
		uuid,
		name: `${uuid}.mp3`,
		mime: "audio/mpeg",
		size: 100,
		bucket: "bucket",
		key: "key",
		version: 2,
		chunks: 1,
		region: "region",
		playlist: "playlist-uuid",
		...overrides
	}
}

function playlist(files: PlaylistFile[], overrides: Partial<Playlist> = {}): Playlist {
	return { uuid: "playlist-uuid", name: "My playlist", created: 1000, updated: 1000, files, ...overrides }
}

describe("createPlaylist", () => {
	it("builds an empty playlist stamped with the given uuid/name/timestamps", () => {
		expect(createPlaylist("p-1", "Road trip", 5000)).toEqual({
			uuid: "p-1",
			name: "Road trip",
			created: 5000,
			updated: 5000,
			files: []
		})
	})
})

describe("renamePlaylist", () => {
	it("replaces the name and bumps updated, leaving files untouched", () => {
		const current = playlist([file("a")])
		const renamed = renamePlaylist(current, "New name", 9000)

		expect(renamed).toEqual({ ...current, name: "New name", updated: 9000 })
	})
})

describe("addTracksToPlaylist", () => {
	it("appends new tracks and restamps their playlist field to the current playlist's uuid", () => {
		const current = playlist([])
		const incoming = [file("a", { playlist: "some-other-playlist" })]

		const { next, added } = addTracksToPlaylist(current, incoming, 2000)

		expect(added).toBe(1)
		expect(next?.files).toEqual([file("a", { playlist: "playlist-uuid" })])
		expect(next?.updated).toBe(2000)
	})

	it("dedupes against tracks already present by uuid", () => {
		const current = playlist([file("a")])
		const { next, added } = addTracksToPlaylist(current, [file("a"), file("b")], 2000)

		expect(added).toBe(1)
		expect(next?.files.map(f => f.uuid)).toEqual(["a", "b"])
	})

	it("returns next: null and added: 0 when every incoming track is already present (a no-op skips the upload)", () => {
		const current = playlist([file("a")])
		const { next, added } = addTracksToPlaylist(current, [file("a")], 2000)

		expect(next).toBeNull()
		expect(added).toBe(0)
	})
})

describe("removeTracksFromPlaylist", () => {
	it("removes the given uuids, leaving the rest in order", () => {
		const current = playlist([file("a"), file("b"), file("c")])
		const next = removeTracksFromPlaylist(current, ["b"])

		expect(next?.files.map(f => f.uuid)).toEqual(["a", "c"])
	})

	it("returns null when nothing matches (no-op)", () => {
		expect(removeTracksFromPlaylist(playlist([file("a")]), ["nonexistent"])).toBeNull()
	})

	it("returns null for an empty uuid list", () => {
		expect(removeTracksFromPlaylist(playlist([file("a")]), [])).toBeNull()
	})
})

describe("reorderPlaylistFile", () => {
	it("moves a track from one index to another", () => {
		const current = playlist([file("a"), file("b"), file("c")])
		const next = reorderPlaylistFile(current, 0, 2)

		expect(next?.files.map(f => f.uuid)).toEqual(["b", "c", "a"])
	})

	it("moving backwards works symmetrically", () => {
		const current = playlist([file("a"), file("b"), file("c")])
		const next = reorderPlaylistFile(current, 2, 0)

		expect(next?.files.map(f => f.uuid)).toEqual(["c", "a", "b"])
	})

	it("is a no-op when from equals to", () => {
		expect(reorderPlaylistFile(playlist([file("a"), file("b")]), 1, 1)).toBeNull()
	})

	it.each([
		[-1, 0],
		[0, -1],
		[2, 0],
		[0, 2]
	])("is a no-op for an out-of-range index pair (%i -> %i) against a 2-track playlist", (from, to) => {
		expect(reorderPlaylistFile(playlist([file("a"), file("b")]), from, to)).toBeNull()
	})
})

describe("pruneDeadTracks", () => {
	it("drops only the dead-uuid entries", () => {
		const current = playlist([file("a"), file("b"), file("c")])
		const next = pruneDeadTracks(current, new Set(["b"]))

		expect(next?.files.map(f => f.uuid)).toEqual(["a", "c"])
	})

	it("returns null when the dead set is empty", () => {
		expect(pruneDeadTracks(playlist([file("a")]), new Set())).toBeNull()
	})

	it("returns null when none of the dead uuids are actually present", () => {
		expect(pruneDeadTracks(playlist([file("a")]), new Set(["nonexistent"]))).toBeNull()
	})
})

describe("moveArrayItem", () => {
	it("moves an element forward", () => {
		expect(moveArrayItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
	})

	it("moves an element backward", () => {
		expect(moveArrayItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"])
	})

	it("returns an unchanged copy when from equals to", () => {
		const input = ["a", "b"]
		const result = moveArrayItem(input, 1, 1)

		expect(result).toEqual(input)
		expect(result).not.toBe(input)
	})

	it("returns an unchanged copy for an out-of-range index", () => {
		expect(moveArrayItem(["a", "b"], 0, 5)).toEqual(["a", "b"])
	})
})
