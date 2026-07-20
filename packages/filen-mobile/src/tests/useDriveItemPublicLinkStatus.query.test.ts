import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { mockGetSdkClients, mockGetFileLinkStatus, mockGetDirLinkStatus, cacheUuidToAnyDriveItem } = vi.hoisted(() => {
	const cacheUuidToAnyDriveItem = new Map<string, unknown>()
	const mockGetFileLinkStatus = vi.fn()
	const mockGetDirLinkStatus = vi.fn()

	return {
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				getFileLinkStatus: mockGetFileLinkStatus,
				getDirLinkStatus: mockGetDirLinkStatus
			}
		}),
		mockGetFileLinkStatus,
		mockGetDirLinkStatus,
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
		set: vi.fn(),
		get: vi.fn()
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: cacheUuidToAnyDriveItem
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@filen/sdk-rs", () => ({}))

import { fetchData, publicLinkStatusQueryKey } from "@/features/drive/queries/useDriveItemPublicLinkStatus.query"
import logger from "@/lib/logger"
import { type DriveItem } from "@/types"

beforeEach(() => {
	mockGetSdkClients.mockReset()
	mockGetFileLinkStatus.mockReset()
	mockGetDirLinkStatus.mockReset()
	cacheUuidToAnyDriveItem.clear()

	mockGetSdkClients.mockResolvedValue({
		authedSdkClient: {
			getFileLinkStatus: mockGetFileLinkStatus,
			getDirLinkStatus: mockGetDirLinkStatus
		}
	})
})

describe("fetchData — type dispatch (file vs directory vs other)", () => {
	it("returns null when cache.uuidToAnyDriveItem has no entry", async () => {
		const result = await fetchData({ uuid: "unknown-uuid" })

		expect(result).toBeNull()
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls getFileLinkStatus and returns {type:'file', status} when cached item type is 'file'", async () => {
		const fakeDriveItem = { type: "file", data: { uuid: "file-link-uuid" } }
		const fakeStatus = { enabled: true, uuid: "link-uuid" }

		cacheUuidToAnyDriveItem.set("file-link-uuid", fakeDriveItem)
		mockGetFileLinkStatus.mockResolvedValue(fakeStatus)

		const result = await fetchData({ uuid: "file-link-uuid" })

		expect(mockGetFileLinkStatus).toHaveBeenCalledWith(fakeDriveItem.data, undefined)
		expect(result).toEqual({ type: "file", status: fakeStatus })
	})

	it("calls getDirLinkStatus and returns {type:'directory', status} when cached item type is 'directory'", async () => {
		const fakeDriveItem = { type: "directory", data: { uuid: "dir-link-uuid" } }
		const fakeStatus = { enabled: false, uuid: "dir-link-uuid-2" }

		cacheUuidToAnyDriveItem.set("dir-link-uuid", fakeDriveItem)
		mockGetDirLinkStatus.mockResolvedValue(fakeStatus)

		const result = await fetchData({ uuid: "dir-link-uuid" })

		expect(mockGetDirLinkStatus).toHaveBeenCalledWith(fakeDriveItem.data, undefined)
		expect(result).toEqual({ type: "directory", status: fakeStatus })
	})

	it("returns null and calls neither SDK method when cached item type is 'sharedFile'", async () => {
		const fakeDriveItem = { type: "sharedFile", data: { uuid: "sf-uuid" } }

		cacheUuidToAnyDriveItem.set("sf-uuid", fakeDriveItem)

		const result = await fetchData({ uuid: "sf-uuid" })

		expect(result).toBeNull()
		expect(mockGetFileLinkStatus).not.toHaveBeenCalled()
		expect(mockGetDirLinkStatus).not.toHaveBeenCalled()
	})

	it("returns null when cached item type is 'sharedDirectory'", async () => {
		const fakeDriveItem = { type: "sharedDirectory", data: { uuid: "sd-uuid" } }

		cacheUuidToAnyDriveItem.set("sd-uuid", fakeDriveItem)

		const result = await fetchData({ uuid: "sd-uuid" })

		expect(result).toBeNull()
	})

	it("returns null when cached item type is 'sharedRootFile'", async () => {
		const fakeDriveItem = { type: "sharedRootFile", data: { uuid: "srf-uuid" } }

		cacheUuidToAnyDriveItem.set("srf-uuid", fakeDriveItem)

		const result = await fetchData({ uuid: "srf-uuid" })

		expect(result).toBeNull()
	})

	it("returns null when cached item type is 'sharedRootDirectory'", async () => {
		const fakeDriveItem = { type: "sharedRootDirectory", data: { uuid: "srd-uuid" } }

		cacheUuidToAnyDriveItem.set("srd-uuid", fakeDriveItem)

		const result = await fetchData({ uuid: "srd-uuid" })

		expect(result).toBeNull()
	})

	it("returns null when getFileLinkStatus returns a falsy value", async () => {
		const fakeDriveItem = { type: "file", data: { uuid: "file-falsy" } }

		cacheUuidToAnyDriveItem.set("file-falsy", fakeDriveItem)
		mockGetFileLinkStatus.mockResolvedValue(null)

		const result = await fetchData({ uuid: "file-falsy" })

		expect(result).toBeNull()
	})

	it("returns null when getDirLinkStatus returns a falsy value", async () => {
		const fakeDriveItem = { type: "directory", data: { uuid: "dir-falsy" } }

		cacheUuidToAnyDriveItem.set("dir-falsy", fakeDriveItem)
		mockGetDirLinkStatus.mockResolvedValue(null)

		const result = await fetchData({ uuid: "dir-falsy" })

		expect(result).toBeNull()
	})

	it("does not call getDirLinkStatus when cached item type is 'file'", async () => {
		const fakeDriveItem = { type: "file", data: { uuid: "file-no-dir" } }
		const fakeStatus = { enabled: true }

		cacheUuidToAnyDriveItem.set("file-no-dir", fakeDriveItem)
		mockGetFileLinkStatus.mockResolvedValue(fakeStatus)

		await fetchData({ uuid: "file-no-dir" })

		expect(mockGetDirLinkStatus).not.toHaveBeenCalled()
	})

	it("does not call getFileLinkStatus when cached item type is 'directory'", async () => {
		const fakeDriveItem = { type: "directory", data: { uuid: "dir-no-file" } }
		const fakeStatus = { enabled: false }

		cacheUuidToAnyDriveItem.set("dir-no-file", fakeDriveItem)
		mockGetDirLinkStatus.mockResolvedValue(fakeStatus)

		await fetchData({ uuid: "dir-no-file" })

		expect(mockGetFileLinkStatus).not.toHaveBeenCalled()
	})
})

describe("fetchData — signal forwarding", () => {
	it("forwards the signal to getFileLinkStatus as {signal} when a signal is provided for a 'file' item", async () => {
		const fakeDriveItem = { type: "file", data: { uuid: "file-signal-uuid" } }
		const fakeStatus = { enabled: true, uuid: "link-uuid" }
		const controller = new AbortController()

		cacheUuidToAnyDriveItem.set("file-signal-uuid", fakeDriveItem)
		mockGetFileLinkStatus.mockResolvedValue(fakeStatus)

		const result = await fetchData({ uuid: "file-signal-uuid", signal: controller.signal })

		expect(mockGetFileLinkStatus).toHaveBeenCalledWith(fakeDriveItem.data, { signal: controller.signal })
		expect(result).toEqual({ type: "file", status: fakeStatus })
	})

	it("forwards the signal to getDirLinkStatus as {signal} when a signal is provided for a 'directory' item", async () => {
		const fakeDriveItem = { type: "directory", data: { uuid: "dir-signal-uuid" } }
		const fakeStatus = { enabled: false, uuid: "dir-link-uuid" }
		const controller = new AbortController()

		cacheUuidToAnyDriveItem.set("dir-signal-uuid", fakeDriveItem)
		mockGetDirLinkStatus.mockResolvedValue(fakeStatus)

		const result = await fetchData({ uuid: "dir-signal-uuid", signal: controller.signal })

		expect(mockGetDirLinkStatus).toHaveBeenCalledWith(fakeDriveItem.data, { signal: controller.signal })
		expect(result).toEqual({ type: "directory", status: fakeStatus })
	})

	it("passes undefined (not {signal:undefined}) to getFileLinkStatus when no signal is provided", async () => {
		const fakeDriveItem = { type: "file", data: { uuid: "file-nosig-uuid" } }
		const fakeStatus = { enabled: true }

		cacheUuidToAnyDriveItem.set("file-nosig-uuid", fakeDriveItem)
		mockGetFileLinkStatus.mockResolvedValue(fakeStatus)

		await fetchData({ uuid: "file-nosig-uuid" })

		expect(mockGetFileLinkStatus).toHaveBeenCalledWith(fakeDriveItem.data, undefined)
	})

	it("passes undefined (not {signal:undefined}) to getDirLinkStatus when no signal is provided", async () => {
		const fakeDriveItem = { type: "directory", data: { uuid: "dir-nosig-uuid" } }
		const fakeStatus = { enabled: false }

		cacheUuidToAnyDriveItem.set("dir-nosig-uuid", fakeDriveItem)
		mockGetDirLinkStatus.mockResolvedValue(fakeStatus)

		await fetchData({ uuid: "dir-nosig-uuid" })

		expect(mockGetDirLinkStatus).toHaveBeenCalledWith(fakeDriveItem.data, undefined)
	})
})

describe("fetchData — by-value item (bypasses the cache)", () => {
	it("resolves the by-value item and returns a status with no cache entry present", async () => {
		const item = { type: "file", data: { uuid: "byval-file" } }
		const fakeStatus = { enabled: true, uuid: "link-uuid" }

		mockGetFileLinkStatus.mockResolvedValue(fakeStatus)

		const result = await fetchData({ uuid: "byval-file", item: item as unknown as DriveItem })

		// Cache was never seeded — resolution came from the by-value item.
		expect(cacheUuidToAnyDriveItem.has("byval-file")).toBe(false)
		expect(mockGetFileLinkStatus).toHaveBeenCalledWith(item.data, undefined)
		expect(result).toEqual({ type: "file", status: fakeStatus })
	})

	it("prefers the by-value item over a stale cache entry for the same uuid", async () => {
		const cachedItem = { type: "directory", data: { uuid: "byval-pref" } }
		const byValueItem = { type: "file", data: { uuid: "byval-pref" } }
		const fakeStatus = { enabled: true }

		cacheUuidToAnyDriveItem.set("byval-pref", cachedItem)
		mockGetFileLinkStatus.mockResolvedValue(fakeStatus)

		const result = await fetchData({ uuid: "byval-pref", item: byValueItem as unknown as DriveItem })

		expect(mockGetFileLinkStatus).toHaveBeenCalledWith(byValueItem.data, undefined)
		expect(mockGetDirLinkStatus).not.toHaveBeenCalled()
		expect(result).toEqual({ type: "file", status: fakeStatus })
	})
})

describe("fetchData — double miss (no item, no cache)", () => {
	it("returns null and logs a warning when neither a by-value item nor a cache entry resolves", async () => {
		vi.mocked(logger.warn).mockClear()

		const result = await fetchData({ uuid: "totally-unknown" })

		expect(result).toBeNull()
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(logger.warn).toHaveBeenCalledWith(
			"drive",
			expect.stringContaining("item not in cache"),
			expect.objectContaining({ uuid: "totally-unknown" })
		)
	})
})

describe("publicLinkStatusQueryKey — by-value item excluded from the key", () => {
	it("produces the same key whether or not a by-value item is supplied", () => {
		const withItem = publicLinkStatusQueryKey({
			uuid: "u1",
			item: { type: "file", data: { uuid: "u1" } } as unknown as DriveItem
		})
		const withoutItem = publicLinkStatusQueryKey({ uuid: "u1" })

		expect(withItem).toEqual(withoutItem)
		expect(withItem).toEqual({ uuid: "u1" })
	})
})
