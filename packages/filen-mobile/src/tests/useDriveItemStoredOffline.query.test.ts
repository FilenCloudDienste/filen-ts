import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockQueryUpdaterSet, mockIsItemStored, cacheUuidToAnyDriveItem, mockGetAll } = vi.hoisted(() => {
	const cacheUuidToAnyDriveItem = new Map<string, unknown>()

	return {
		mockQueryUpdaterSet: vi.fn(),
		mockIsItemStored: vi.fn().mockResolvedValue(false),
		cacheUuidToAnyDriveItem,
		mockGetAll: vi.fn(() => [] as unknown[])
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => {
	const real = await import("@/tests/mocks/filenUtils")
	const { sortParams } = await import("@filen/utils")

	return {
		...real,
		sortParams
	}
})

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		set: mockQueryUpdaterSet,
		get: vi.fn()
	},
	queryClient: {
		getQueryCache: () => ({
			getAll: mockGetAll
		})
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: cacheUuidToAnyDriveItem
	}
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		isItemStored: mockIsItemStored
	}
}))

vi.mock("@filen/sdk-rs", () => ({}))

import {
	driveItemStoredOfflineQueryUpdate,
	fetchData,
	getStoredOfflineQueryCacheEntries,
	BASE_QUERY_KEY
} from "@/features/drive/queries/useDriveItemStoredOffline.query"

// normalizeTypeForKey is private but its effect is observable via the query key emitted
// by driveItemStoredOfflineQueryUpdate. Two variants that should normalize to the same
// base type must produce identical query keys.
function captureKeyFor(
	type: "file" | "sharedFile" | "sharedRootFile" | "directory" | "sharedDirectory" | "sharedRootDirectory"
): unknown[] {
	driveItemStoredOfflineQueryUpdate({
		params: { uuid: "test-uuid", type },
		updater: false
	})

	const call = mockQueryUpdaterSet.mock.calls.at(-1)!

	return call[0] as unknown[]
}

beforeEach(() => {
	mockQueryUpdaterSet.mockClear()
	mockIsItemStored.mockClear()
	mockIsItemStored.mockResolvedValue(false)
	cacheUuidToAnyDriveItem.clear()
	mockGetAll.mockClear()
})

describe("normalizeTypeForKey (via driveItemStoredOfflineQueryUpdate key)", () => {
	it("normalizes 'file' to 'file'", () => {
		const key = captureKeyFor("file")

		expect(key[0]).toBe(BASE_QUERY_KEY)
		expect((key[1] as Record<string, unknown>)["type"]).toBe("file")
	})

	it("normalizes 'sharedFile' to 'file'", () => {
		const key = captureKeyFor("sharedFile")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("file")
	})

	it("normalizes 'sharedRootFile' to 'file'", () => {
		const key = captureKeyFor("sharedRootFile")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("file")
	})

	it("normalizes 'directory' to 'directory'", () => {
		const key = captureKeyFor("directory")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("directory")
	})

	it("normalizes 'sharedDirectory' to 'directory'", () => {
		const key = captureKeyFor("sharedDirectory")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("directory")
	})

	it("normalizes 'sharedRootDirectory' to 'directory'", () => {
		const key = captureKeyFor("sharedRootDirectory")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("directory")
	})

	it("'file' and 'sharedFile' produce the same query key (shared cache entry)", () => {
		const keyFile = captureKeyFor("file")
		const keySharedFile = captureKeyFor("sharedFile")

		expect(keyFile).toEqual(keySharedFile)
	})

	it("'file' and 'sharedRootFile' produce the same query key", () => {
		const keyFile = captureKeyFor("file")
		const keySharedRootFile = captureKeyFor("sharedRootFile")

		expect(keyFile).toEqual(keySharedRootFile)
	})

	it("'directory' and 'sharedDirectory' produce the same query key", () => {
		const keyDir = captureKeyFor("directory")
		const keySharedDir = captureKeyFor("sharedDirectory")

		expect(keyDir).toEqual(keySharedDir)
	})

	it("'directory' and 'sharedRootDirectory' produce the same query key", () => {
		const keyDir = captureKeyFor("directory")
		const keySharedRootDir = captureKeyFor("sharedRootDirectory")

		expect(keyDir).toEqual(keySharedRootDir)
	})

	it("file-type and directory-type keys are different (no cross-contamination)", () => {
		const keyFile = captureKeyFor("file")
		const keyDir = captureKeyFor("directory")

		expect(keyFile).not.toEqual(keyDir)
	})
})

describe("fetchData", () => {
	const fakeDriveItem = { type: "file", uuid: "abc-123" }

	it("returns false when the item is not in cache", async () => {
		// cache is empty — no entry for the requested uuid
		const result = await fetchData({ uuid: "abc-123", type: "file" })

		expect(result).toBe(false)
		expect(mockIsItemStored).not.toHaveBeenCalled()
	})

	it("returns true when item is in cache and isItemStored returns true", async () => {
		cacheUuidToAnyDriveItem.set("abc-123", fakeDriveItem)
		mockIsItemStored.mockResolvedValue(true)

		const result = await fetchData({ uuid: "abc-123", type: "file" })

		expect(result).toBe(true)
		expect(mockIsItemStored).toHaveBeenCalledOnce()
		expect(mockIsItemStored).toHaveBeenCalledWith(fakeDriveItem)
	})

	it("returns false when item is in cache but isItemStored returns false", async () => {
		cacheUuidToAnyDriveItem.set("abc-123", fakeDriveItem)
		mockIsItemStored.mockResolvedValue(false)

		const result = await fetchData({ uuid: "abc-123", type: "file" })

		expect(result).toBe(false)
		expect(mockIsItemStored).toHaveBeenCalledOnce()
		expect(mockIsItemStored).toHaveBeenCalledWith(fakeDriveItem)
	})

	it("propagates errors thrown by isItemStored", async () => {
		const testError = new Error("storage check failed")
		cacheUuidToAnyDriveItem.set("abc-123", fakeDriveItem)
		mockIsItemStored.mockRejectedValue(testError)

		await expect(fetchData({ uuid: "abc-123", type: "file" })).rejects.toThrow("storage check failed")
	})

	it("passes the correct item from cache to isItemStored (directory variant)", async () => {
		const fakeDirItem = { type: "directory", uuid: "dir-456" }
		cacheUuidToAnyDriveItem.set("dir-456", fakeDirItem)
		mockIsItemStored.mockResolvedValue(true)

		await fetchData({ uuid: "dir-456", type: "directory" })

		expect(mockIsItemStored).toHaveBeenCalledWith(fakeDirItem)
	})

	it("uses uuid-based lookup regardless of the type variant (sharedFile normalizes to file in key but uuid lookup is direct)", async () => {
		const sharedFileDriveItem = { type: "sharedFile", uuid: "sf-789" }
		cacheUuidToAnyDriveItem.set("sf-789", sharedFileDriveItem)
		mockIsItemStored.mockResolvedValue(true)

		const result = await fetchData({ uuid: "sf-789", type: "sharedFile" })

		expect(result).toBe(true)
		expect(mockIsItemStored).toHaveBeenCalledWith(sharedFileDriveItem)
	})
})

describe("getStoredOfflineQueryCacheEntries", () => {
	it("keeps every entry whose key starts with BASE_QUERY_KEY and drops the rest", () => {
		const mine = {
			queryKey: [BASE_QUERY_KEY, { type: "file", uuid: "11111111-1111-1111-1111-111111111111" }],
			state: { data: true }
		}
		const alsoMine = {
			queryKey: [BASE_QUERY_KEY, { type: "directory", uuid: "22222222-2222-2222-2222-222222222222" }],
			state: { data: false }
		}
		const foreign = {
			queryKey: ["useDriveItemsQuery", { path: { type: "drive", uuid: null } }],
			state: { data: [] }
		}

		mockGetAll.mockReturnValueOnce([foreign, mine, alsoMine])

		const result = getStoredOfflineQueryCacheEntries()

		expect(result).toHaveLength(2)
		expect(result[0]).toBe(mine)
		expect(result[1]).toBe(alsoMine)
	})

	// The key HEAD must match. A "contains" test would sweep in unrelated queries, and
	// findStaleStoredOfflineEntries would then broadcast `false` over their data.
	it("does not match a key that only carries BASE_QUERY_KEY in a later position", () => {
		mockGetAll.mockReturnValueOnce([
			{
				queryKey: ["somethingElse", BASE_QUERY_KEY],
				state: { data: true }
			}
		])

		expect(getStoredOfflineQueryCacheEntries()).toEqual([])
	})

	it("returns an empty array when nothing is cached", () => {
		expect(getStoredOfflineQueryCacheEntries()).toEqual([])
	})
})
