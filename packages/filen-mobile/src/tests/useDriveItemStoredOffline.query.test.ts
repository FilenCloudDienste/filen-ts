import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockQueryUpdaterSet, mockIsItemStored, cacheUuidToAnyDriveItem } = vi.hoisted(() => {
	const cacheUuidToAnyDriveItem = new Map<string, unknown>()

	return {
		mockQueryUpdaterSet: vi.fn(),
		mockIsItemStored: vi.fn().mockResolvedValue(false),
		cacheUuidToAnyDriveItem
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

import { driveItemStoredOfflineQueryUpdate, fetchData, BASE_QUERY_KEY } from "@/features/drive/queries/useDriveItemStoredOffline.query"

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
