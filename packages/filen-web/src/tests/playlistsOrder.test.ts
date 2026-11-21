// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"

const { findDirectoryUuid, listDirectory, downloadFileBytes, subscribeToSocket } = vi.hoisted(() => ({
	findDirectoryUuid: vi.fn(),
	listDirectory: vi.fn(),
	downloadFileBytes: vi.fn(),
	subscribeToSocket: vi.fn(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { findDirectoryUuid, listDirectory, downloadFileBytes, subscribeToSocket } }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import {
	comparePlaylistEntries,
	markPlaylistsUnsynced,
	PLAYLISTS_QUERY_KEY,
	playlistsQueryGet,
	playlistsQueryUpsert,
	usePlaylistsQuery,
	type PlaylistEntry
} from "@/features/audio/queries/playlists"
import { forgetPlaylistsDirectory } from "@/features/audio/lib/playlists"
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import { testUuid } from "@/tests/support/uuid"
import type { Playlist } from "@filen/shared"

const DOT_FILEN_UUID = testUuid("dotfilen")
const PLAYLISTS_DIR_UUID = testUuid("playlistsdir")

// Drive file uuid -> the playlist its bytes hold. "b" and "c" tie on `updated` and on the name's natural
// order, so only the uuid can order them.
const PLAYLISTS: Record<string, { uuid: string; name: string; updated: number } | null> = {
	[testUuid("fa")]: { uuid: "pa", name: "Road trip", updated: 300 },
	[testUuid("fb")]: { uuid: "pb", name: "chill", updated: 200 },
	[testUuid("fc")]: { uuid: "pc", name: "Chill", updated: 200 },
	[testUuid("fd")]: { uuid: "pd", name: "Gym", updated: 200 },
	[testUuid("fe")]: null
}

function fakeJsonFile(uuid: UuidStr): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name: `${uuid}.json`, mime: "application/json", modified: 0n, size: 0n, key: "k", version: 2 } },
		parent: PLAYLISTS_DIR_UUID,
		size: 0n,
		favorited: false,
		region: "r",
		bucket: "b",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

function bytesOf(file: SdkFile): Uint8Array {
	const playlist = PLAYLISTS[file.uuid]

	return new TextEncoder().encode(playlist ? JSON.stringify({ ...playlist, created: 1, files: [] }) : "not json")
}

function rowIds(entries: readonly PlaylistEntry[] | undefined): string[] {
	return (entries ?? []).map(entry => (entry.status === "ok" ? entry.playlist.uuid : `degraded:${entry.fileUuid}`))
}

function listingIn(order: readonly string[]): void {
	listDirectory.mockImplementation(() => Promise.resolve({ dirs: [], files: order.map(uuid => fakeJsonFile(uuid as UuidStr)) }))
}

const EXPECTED = ["pa", "pb", "pc", "pd", `degraded:${testUuid("fe")}`]

beforeEach(() => {
	queryClient.clear()
	vi.clearAllMocks()

	findDirectoryUuid.mockImplementation((parentUuid: string | null, name: string) =>
		Promise.resolve(name === "playlists" && parentUuid === DOT_FILEN_UUID ? PLAYLISTS_DIR_UUID : DOT_FILEN_UUID)
	)
	downloadFileBytes.mockImplementation((file: SdkFile) => Promise.resolve(bytesOf(file)))
	forgetPlaylistsDirectory()
	markPlaylistsUnsynced()
	socketAuthenticated()
})

describe("playlists list order", () => {
	it("is the same whatever order the directory listing returns the files in", async () => {
		const files = Object.keys(PLAYLISTS)

		listingIn(files)

		const view = renderHook(() => usePlaylistsQuery(), { wrapper: queryClientWrapper(queryClient) })

		await waitFor(() => {
			expect(view.result.current.isSuccess).toBe(true)
		})

		expect(rowIds(view.result.current.data)).toEqual(EXPECTED)

		// A save elsewhere rewrites a file and the next listing comes back in another order.
		listingIn([...files].reverse())
		markPlaylistsUnsynced()
		await queryClient.refetchQueries({ queryKey: PLAYLISTS_QUERY_KEY })

		expect(listDirectory).toHaveBeenCalledTimes(2)
		expect(rowIds(view.result.current.data)).toEqual(EXPECTED)
	})

	it("an upserted edit takes its place in the order instead of keeping its old row", async () => {
		listingIn(Object.keys(PLAYLISTS))
		renderHook(() => usePlaylistsQuery(), { wrapper: queryClientWrapper(queryClient) })

		await waitFor(() => {
			expect(playlistsQueryGet()).toHaveLength(5)
		})

		const edited: Playlist = { uuid: "pd", name: "Gym", created: 1, updated: 400, files: [] }
		const created: Playlist = { uuid: "pz", name: "New", created: 1, updated: 50, files: [] }

		playlistsQueryUpsert(edited)
		playlistsQueryUpsert(created)

		expect(rowIds(playlistsQueryGet())).toEqual(["pd", "pa", "pb", "pc", "pz", `degraded:${testUuid("fe")}`])
	})

	it("orders every pair the same way both ways round", () => {
		const entries: PlaylistEntry[] = [
			{ status: "ok", playlist: { uuid: "b", name: "x", created: 0, updated: 0, files: [] } },
			{ status: "ok", playlist: { uuid: "a", name: "X", created: 0, updated: 0, files: [] } },
			{ status: "degraded", fileUuid: "d2", name: "same" },
			{ status: "degraded", fileUuid: "d1", name: "same" }
		]

		for (const a of entries) {
			for (const b of entries) {
				expect(Math.sign(comparePlaylistEntries(a, b)) === -Math.sign(comparePlaylistEntries(b, a))).toBe(true)
				expect(comparePlaylistEntries(a, b) === 0).toBe(a === b)
			}
		}
	})
})
