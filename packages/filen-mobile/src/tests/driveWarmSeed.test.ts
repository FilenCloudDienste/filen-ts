import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockGetAll, mockCacheDriveItem, mockCacheDriveItemReference, mockUuidMap } = vi.hoisted(() => ({
	mockGetAll: vi.fn((): unknown[] => []),
	mockCacheDriveItem: vi.fn(),
	mockCacheDriveItemReference: vi.fn(),
	mockUuidMap: new Map<string, unknown>()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

vi.mock("@/queries/client", () => ({
	queryClient: {
		getQueryCache: () => ({
			getAll: mockGetAll
		})
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		cacheDriveItem: mockCacheDriveItem,
		cacheDriveItemReference: mockCacheDriveItemReference,
		uuidToAnyDriveItem: mockUuidMap
	}
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({ BASE_QUERY_KEY: "useDriveItemsQuery" }))

vi.mock("@/features/audio/queries/usePlaylists.query", () => ({ BASE_QUERY_KEY: "usePlaylistsQuery" }))

import { warmSeedDriveCaches } from "@/features/drive/driveWarmSeed"
import logger from "@/lib/logger"

const item = (uuid: string): unknown => ({ type: "file", data: { uuid } })

const driveRow = (pathType: string | undefined, data: unknown, dataUpdatedAt: number): unknown => ({
	queryKey: ["useDriveItemsQuery", pathType === undefined ? {} : { path: { type: pathType } }],
	state: { data, dataUpdatedAt }
})

const playlistRow = (fileUuids: string[]): unknown => ({
	queryKey: ["usePlaylistsQuery"],
	state: { data: [{ files: fileUuids.map(uuid => ({ item: item(uuid) })) }], dataUpdatedAt: 1 }
})

describe("warmSeedDriveCaches", () => {
	beforeEach(() => {
		mockGetAll.mockReset()
		mockGetAll.mockReturnValue([])
		mockCacheDriveItem.mockReset()
		mockCacheDriveItemReference.mockReset()
		mockUuidMap.clear()
		vi.mocked(logger.warn).mockClear()
		vi.mocked(logger.debug).mockClear()
	})

	it("seeds drive rows via cacheDriveItem, offline rows via cacheDriveItemReference, and skips linked rows", async () => {
		mockGetAll.mockReturnValue([
			driveRow("drive", [item("a")], 1),
			driveRow("offline", [item("b")], 2),
			driveRow("linked", [item("c")], 3)
		])

		await warmSeedDriveCaches()

		expect(mockCacheDriveItem).toHaveBeenCalledWith({ type: "file", data: { uuid: "a" } }, { sharedOut: false })
		expect(mockCacheDriveItemReference).toHaveBeenCalledWith({ type: "file", data: { uuid: "b" } })

		// The linked row is skipped entirely — it never reaches either cache helper.
		expect(mockCacheDriveItem).toHaveBeenCalledTimes(1)
		expect(mockCacheDriveItemReference).toHaveBeenCalledTimes(1)
	})

	it("passes { sharedOut: true } exactly for sharedOut rows", async () => {
		mockGetAll.mockReturnValue([driveRow("sharedOut", [item("s")], 1), driveRow("drive", [item("d")], 2)])

		await warmSeedDriveCaches()

		expect(mockCacheDriveItem).toHaveBeenCalledWith(expect.objectContaining({ data: { uuid: "s" } }), { sharedOut: true })
		expect(mockCacheDriveItem).toHaveBeenCalledWith(expect.objectContaining({ data: { uuid: "d" } }), { sharedOut: false })
	})

	it("processes rows in ascending dataUpdatedAt order so the freshest listing wins duplicate uuids", async () => {
		// Both rows seed uuid "dup"; the newer (sharedOut, dataUpdatedAt 5) appears first in key order
		// but must be applied LAST so it wins.
		mockGetAll.mockReturnValue([driveRow("sharedOut", [item("dup")], 5), driveRow("drive", [item("dup")], 1)])

		await warmSeedDriveCaches()

		const calls = mockCacheDriveItem.mock.calls

		expect(calls).toHaveLength(2)
		expect(calls[0]).toEqual([expect.objectContaining({ data: { uuid: "dup" } }), { sharedOut: false }])
		expect(calls[1]).toEqual([expect.objectContaining({ data: { uuid: "dup" } }), { sharedOut: true }])
	})

	it("seeds playlist file items into the uuid map", async () => {
		mockGetAll.mockReturnValue([playlistRow(["p1", "p2"])])

		await warmSeedDriveCaches()

		expect(mockUuidMap.get("p1")).toEqual({ type: "file", data: { uuid: "p1" } })
		expect(mockUuidMap.get("p2")).toEqual({ type: "file", data: { uuid: "p2" } })
	})

	it("isolates a throwing row, keeps seeding the rest, logs a warning, and ignores non-array data", async () => {
		// The first cacheDriveItem call throws; the ascending sort processes "throws" (1) before "ok" (2).
		mockCacheDriveItem.mockImplementationOnce(() => {
			throw new Error("boom")
		})

		mockGetAll.mockReturnValue([
			driveRow("drive", [item("throws")], 1),
			driveRow("drive", [item("ok")], 2),
			driveRow("drive", "not-an-array", 3)
		])

		await warmSeedDriveCaches()

		// "ok" still seeded despite the earlier row throwing; the non-array row contributed nothing.
		expect(mockCacheDriveItem).toHaveBeenCalledTimes(2)
		expect(mockCacheDriveItem).toHaveBeenCalledWith(expect.objectContaining({ data: { uuid: "ok" } }), { sharedOut: false })
		expect(logger.warn).toHaveBeenCalled()
	})

	it("never rejects even when getAll throws", async () => {
		mockGetAll.mockImplementation(() => {
			throw new Error("getAll boom")
		})

		await expect(warmSeedDriveCaches()).resolves.toBeUndefined()
		expect(logger.warn).toHaveBeenCalledWith("drive-warm-seed", "Warm seed pass failed", expect.anything())
	})
})
