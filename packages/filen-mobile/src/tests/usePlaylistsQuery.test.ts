import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockCacheSet, mockQueryUpdaterSet } = vi.hoisted(() => ({
	mockCacheSet: vi.fn(),
	mockQueryUpdaterSet: vi.fn((_key: unknown, updater: unknown) =>
		typeof updater === "function" ? (updater as (prev: unknown) => unknown)(undefined) : updater
	)
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: { set: mockQueryUpdaterSet }
}))

vi.mock("@/features/audio/audio", () => ({ default: { getPlaylists: vi.fn() } }))

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: { get: vi.fn(), set: mockCacheSet }
	}
}))

import { playlistsQueryUpdate } from "@/features/audio/queries/usePlaylists.query"

type Updater = Parameters<typeof playlistsQueryUpdate>[0]["updater"]

const makePlaylist = (fileUuids: string[]): unknown => ({
	files: fileUuids.map(uuid => ({ item: { data: { uuid } } }))
})

// A playlist's files reference drive items that the audio metadata query resolves by uuid FROM
// cache.uuidToAnyDriveItem — otherwise seeded ONLY by the list query's fetchData. playlistsQueryUpdate
// must seed the same entries so an optimistically-updated playlist resolves without a refetch first.
describe("playlistsQueryUpdate cache sync", () => {
	beforeEach(() => {
		mockCacheSet.mockClear()
		mockQueryUpdaterSet.mockClear()
	})

	it("seeds cache.uuidToAnyDriveItem for every file in every playlist", () => {
		playlistsQueryUpdate({ updater: [makePlaylist(["a", "b"])] as unknown as Updater })

		expect(mockCacheSet).toHaveBeenCalledWith("a", { data: { uuid: "a" } })
		expect(mockCacheSet).toHaveBeenCalledWith("b", { data: { uuid: "b" } })
	})

	it("seeds files from a playlist added by a function updater", () => {
		playlistsQueryUpdate({ updater: ((prev: unknown[]) => [...prev, makePlaylist(["x"])]) as unknown as Updater })

		expect(mockCacheSet).toHaveBeenCalledWith("x", { data: { uuid: "x" } })
	})
})
