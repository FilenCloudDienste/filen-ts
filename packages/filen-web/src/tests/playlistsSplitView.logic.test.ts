import { describe, expect, it } from "vitest"
import { playlistArtworkGradient } from "@/features/audio/lib/playlistArtwork"
import { resolveSelectedPlaylist } from "@/features/audio/lib/playlistSelection"
import type { PlaylistEntry } from "@/features/audio/queries/playlists"
import type { Playlist } from "@filen/shared"

const UUIDS = [
	"0b7c3f1e-2a4d-4e8b-9c1f-5d6e7f8a9b0c",
	"1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b",
	"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
	"c0ffee00-1234-4abc-9def-0123456789ab"
]

function hues(gradient: string): number[] {
	return [...gradient.matchAll(/oklch\([\d.]+ [\d.]+ (\d+)\)/g)].map(match => Number(match[1]))
}

describe("playlistArtworkGradient", () => {
	it("is deterministic for a uuid", () => {
		for (const uuid of UUIDS) {
			expect(playlistArtworkGradient(uuid)).toBe(playlistArtworkGradient(uuid))
		}
	})

	it("gives different uuids different artwork", () => {
		expect(new Set(UUIDS.map(playlistArtworkGradient)).size).toBe(UUIDS.length)
	})

	it("pairs two in-range hues 40-119 degrees apart", () => {
		for (const uuid of UUIDS) {
			const [from, to] = hues(playlistArtworkGradient(uuid))

			expect(from).toBeGreaterThanOrEqual(0)
			expect(from).toBeLessThan(360)
			expect(to).toBeGreaterThanOrEqual(0)
			expect(to).toBeLessThan(360)

			const gap = ((to ?? 0) - (from ?? 0) + 360) % 360

			expect(gap).toBeGreaterThanOrEqual(40)
			expect(gap).toBeLessThan(120)
		}
	})
})

function playlist(uuid: string): Playlist {
	return { uuid, name: uuid, created: 0, updated: 0, files: [] }
}

describe("resolveSelectedPlaylist", () => {
	const entries: PlaylistEntry[] = [
		{ status: "degraded", fileUuid: "d1", name: "Broken" },
		{ status: "ok", playlist: playlist("a") },
		{ status: "ok", playlist: playlist("b") }
	]

	it("returns the playlist the uuid names", () => {
		expect(resolveSelectedPlaylist(entries, "b")?.uuid).toBe("b")
	})

	it("falls back to the first ok playlist without a uuid, or for a stale or degraded one", () => {
		expect(resolveSelectedPlaylist(entries, undefined)?.uuid).toBe("a")
		expect(resolveSelectedPlaylist(entries, "gone")?.uuid).toBe("a")
		expect(resolveSelectedPlaylist(entries, "d1")?.uuid).toBe("a")
	})

	it("returns null when nothing parsed", () => {
		expect(resolveSelectedPlaylist([], "a")).toBeNull()
		expect(resolveSelectedPlaylist([{ status: "degraded", fileUuid: "d1", name: "Broken" }], undefined)).toBeNull()
	})
})
