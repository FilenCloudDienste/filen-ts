import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockCacheMap, mockHas, mockGet, mockIsOnline, mockOfflineGetLocalFile } = vi.hoisted(() => ({
	mockCacheMap: new Map<string, unknown>(),
	mockHas: vi.fn(() => false),
	mockGet: vi.fn(),
	mockIsOnline: vi.fn().mockReturnValue(true),
	mockOfflineGetLocalFile: vi.fn().mockResolvedValue(null)
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	sortParams: (p: Record<string, unknown>) => p
}))

// The query reaches @/queries/fileSource → @/lib/fileCache → @filen/sdk-rs (whose installer runs at
// import); stub the same three modules useFileUrl.query.test.ts stubs.
vi.mock("@filen/sdk-rs", () => {
	class TaggedUnion {
		tag: string
		inner: unknown[]

		constructor(tag: string, value: unknown) {
			this.tag = tag
			this.inner = [value]
		}
	}

	return {
		AnyFile: {
			File: class extends TaggedUnion {
				constructor(file: unknown) {
					super("File", file)
				}
			},
			Shared: class extends TaggedUnion {
				constructor(file: unknown) {
					super("Shared", file)
				}
			}
		},
		ManagedFuture: { new: vi.fn(() => ({})) }
	}
})

vi.mock("@/lib/fileCache", () => ({
	default: {}
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		getLocalFile: mockOfflineGetLocalFile
	}
}))

vi.mock("@tanstack/react-query", async importOriginal => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>()

	return {
		...actual,
		onlineManager: {
			isOnline: mockIsOnline
		}
	}
})

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: mockCacheMap
	}
}))

vi.mock("@/lib/rawPreviewCache", () => ({
	default: {
		has: mockHas,
		get: mockGet
	}
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {}
}))

import { fetchData, BASE_QUERY_KEY, type UseRawPreviewQueryParams } from "@/queries/useRawPreview.query"
import { File as MockFile, fs } from "@/tests/mocks/expoFileSystem"

function makeRawItem(uuid = "raw-uuid") {
	return {
		type: "file" as const,
		data: {
			uuid,
			size: 24_000_000n,
			canMakeThumbnail: true,
			undecryptable: false,
			decryptedMeta: { name: "shot.cr2", mime: "image/x-canon-cr2", modified: 1000, created: 1000 }
		}
	}
}

const PREVIEW_URI = "file:///shared/group.io.filen.app/rawPreviews/v1/raw-uuid.jpg"

describe("useRawPreviewQuery — fetchData", () => {
	beforeEach(() => {
		fs.clear()
		mockCacheMap.clear()
		mockHas.mockReset().mockReturnValue(false)
		mockGet.mockReset()
		mockIsOnline.mockReset().mockReturnValue(true)
		mockOfflineGetLocalFile.mockReset().mockResolvedValue(null)
	})

	it("keys off a stable base name that is excluded from persistence", () => {
		expect(BASE_QUERY_KEY).toBe("useRawPreviewQuery")
	})

	it("resolves the by-value item and returns the cache's uri", async () => {
		const item = makeRawItem()

		mockGet.mockResolvedValueOnce({ kind: "uri", uri: PREVIEW_URI })

		const params: UseRawPreviewQueryParams = { type: "drive", data: { uuid: "raw-uuid", item: item as never } }

		await expect(fetchData(params)).resolves.toEqual({ kind: "uri", uri: PREVIEW_URI })
		expect(mockGet).toHaveBeenCalledWith({ item, signal: undefined })
	})

	it("falls back to the uuid cache when no item is threaded", async () => {
		const item = makeRawItem()

		mockCacheMap.set("raw-uuid", item)
		mockGet.mockResolvedValueOnce({ kind: "noPreview" })

		await expect(fetchData({ type: "drive", data: { uuid: "raw-uuid" } })).resolves.toEqual({ kind: "noPreview" })
		expect(mockGet).toHaveBeenCalledWith({ item, signal: undefined })
	})

	it("throws when the uuid resolves to nothing or to a directory", async () => {
		await expect(fetchData({ type: "drive", data: { uuid: "ghost" } })).rejects.toThrow("Drive item not found or is not a file")

		mockCacheMap.set("dir", { type: "directory", data: { uuid: "dir" } })

		await expect(fetchData({ type: "drive", data: { uuid: "dir" } })).rejects.toThrow("Drive item not found or is not a file")
		expect(mockGet).not.toHaveBeenCalled()
	})

	it("serves a cached preview offline (hit before the online check)", async () => {
		mockIsOnline.mockReturnValue(false)
		mockHas.mockReturnValue(true)
		mockGet.mockResolvedValueOnce({ kind: "uri", uri: PREVIEW_URI })

		await expect(fetchData({ type: "drive", data: { uuid: "raw-uuid", item: makeRawItem() as never } })).resolves.toEqual({
			kind: "uri",
			uri: PREVIEW_URI
		})
	})

	it("returns offline on a miss while offline with no local copy, without touching the SDK", async () => {
		mockIsOnline.mockReturnValue(false)
		mockHas.mockReturnValue(false)

		await expect(fetchData({ type: "drive", data: { uuid: "raw-uuid", item: makeRawItem() as never } })).resolves.toEqual({
			kind: "offline"
		})
		expect(mockGet).not.toHaveBeenCalled()
	})

	// The cache extracts from a stored-offline container itself, so this must reach it rather than
	// short-circuiting to "not available offline" while the bytes sit on disk.
	it("asks the cache on a miss while offline when the RAW itself is stored offline", async () => {
		mockIsOnline.mockReturnValue(false)
		mockHas.mockReturnValue(false)

		const offlineUri = "file:///document/offline/v2/files/raw-uuid.cr2"

		fs.set(offlineUri, new Uint8Array([1]))
		mockOfflineGetLocalFile.mockResolvedValueOnce(new MockFile(offlineUri))
		mockGet.mockResolvedValueOnce({ kind: "uri", uri: PREVIEW_URI })

		await expect(fetchData({ type: "drive", data: { uuid: "raw-uuid", item: makeRawItem() as never } })).resolves.toEqual({
			kind: "uri",
			uri: PREVIEW_URI
		})
		expect(mockGet).toHaveBeenCalledTimes(1)
	})

	it("rethrows a transport error (query error → overlay with Retry)", async () => {
		mockGet.mockRejectedValueOnce(new Error("network"))

		await expect(fetchData({ type: "drive", data: { uuid: "raw-uuid", item: makeRawItem() as never } })).rejects.toThrow("network")
	})

	it("forwards the abort signal to the cache", async () => {
		const controller = new AbortController()

		mockGet.mockResolvedValueOnce({ kind: "uri", uri: PREVIEW_URI })

		await fetchData({ type: "drive", data: { uuid: "raw-uuid", item: makeRawItem() as never }, signal: controller.signal })

		expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
	})
})
