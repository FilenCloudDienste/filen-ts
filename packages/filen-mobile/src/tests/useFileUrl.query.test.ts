import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockCacheMap,
	mockFileCacheHas,
	mockFileCacheGet,
	mockOfflineGetLocalFile,
	mockIsOnline,
	mockHttpStoreState,
	mockGetFileUrl
} = vi.hoisted(() => {
	const mockGetFileUrl = vi.fn((file: { tag?: string; inner?: unknown }) => {
		return `http://localhost:8080/file/${(file as { inner?: [{ uuid?: string }] }).inner?.[0]?.uuid ?? "unknown"}`
	})

	const mockHttpStoreState: { getFileUrl: typeof mockGetFileUrl | null } = {
		getFileUrl: mockGetFileUrl
	}

	return {
		mockCacheMap: new Map<string, unknown>(),
		mockFileCacheHas: vi.fn().mockResolvedValue(false),
		mockFileCacheGet: vi.fn().mockResolvedValue(null),
		mockOfflineGetLocalFile: vi.fn().mockResolvedValue(null),
		mockIsOnline: vi.fn().mockReturnValue(true),
		mockHttpStoreState,
		mockGetFileUrl
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...await import("@/tests/mocks/filenUtils"),
	sortParams: (p: Record<string, unknown>) => {
		const keys = Object.keys(p).sort()
		const result: Record<string, unknown> = {}

		for (const k of keys) {
			result[k] = p[k]
		}

		return result
	}
}))

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

vi.mock("@/lib/fileCache", () => ({
	default: {
		has: mockFileCacheHas,
		get: mockFileCacheGet
	}
}))

vi.mock("@/lib/offline", () => ({
	default: {
		getLocalFile: mockOfflineGetLocalFile
	}
}))

vi.mock("@/stores/useHttp.store", () => ({
	default: {
		getState: () => mockHttpStoreState,
		subscribe: vi.fn(() => () => {})
	}
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForExpo: vi.fn((path: string) => (path.startsWith("file://") ? path : `file://${path}`)),
	normalizeFilePathForSdk: vi.fn((path: string) => path.replace("file://", "")),
	wrapAbortSignalForSdk: vi.fn(() => ({}))
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: vi.fn(),
		set: vi.fn()
	}
}))

import { fetchData } from "@/queries/useFileUrl.query"
import { type UseFileUrlQueryParams } from "@/queries/useFileUrl.query"
import { File as MockFile, fs } from "@/tests/mocks/expoFileSystem"

function makeFileItem(uuid = "file-uuid-1") {
	return {
		type: "file" as const,
		data: {
			uuid,
			size: 1024n,
			undecryptable: false,
			decryptedMeta: { name: "test.txt", mime: "text/plain", modified: 1000, created: 1000 }
		}
	}
}

function makeSharedFileItem(uuid = "shared-uuid-1") {
	return {
		type: "sharedFile" as const,
		data: {
			uuid,
			size: 512n,
			undecryptable: false,
			decryptedMeta: { name: "shared.txt", mime: "text/plain", modified: 1000, created: 1000 }
		}
	}
}

function makeSharedRootFileItem(uuid = "root-uuid-1") {
	return {
		type: "sharedRootFile" as const,
		data: {
			uuid,
			size: 256n,
			undecryptable: false,
			decryptedMeta: { name: "root.txt", mime: "text/plain", modified: 1000, created: 1000 }
		}
	}
}

function makeDirectoryItem(uuid = "dir-uuid-1") {
	return {
		type: "directory" as const,
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta: { name: "my-dir", color: null }
		}
	}
}

describe("fetchData (useFileUrl.query)", () => {
	beforeEach(() => {
		mockCacheMap.clear()
		fs.clear()
		mockFileCacheHas.mockReset().mockResolvedValue(false)
		mockFileCacheGet.mockReset().mockResolvedValue(null)
		mockOfflineGetLocalFile.mockReset().mockResolvedValue(null)
		mockIsOnline.mockReset().mockReturnValue(true)
		mockGetFileUrl.mockReset().mockImplementation(
			(file: { tag?: string; inner?: unknown }) =>
				`http://localhost:8080/file/${(file as { inner?: [{ uuid?: string }] }).inner?.[0]?.uuid ?? "unknown"}`
		)
		mockHttpStoreState.getFileUrl = mockGetFileUrl
	})

	describe("external type", () => {
		it("returns params.data.url directly without touching cache or fileCache", async () => {
			const params: UseFileUrlQueryParams = {
				type: "external",
				data: { url: "https://cdn.example.com/audio.mp3", name: "audio.mp3" }
			}

			const result = await fetchData(params)

			expect(result).toBe("https://cdn.example.com/audio.mp3")
			expect(mockFileCacheHas).not.toHaveBeenCalled()
			expect(mockFileCacheGet).not.toHaveBeenCalled()
		})
	})

	describe("drive type — missing / non-file items", () => {
		it("returns null when uuid is not in cache", async () => {
			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "ghost-uuid" } }

			const result = await fetchData(params)

			expect(result).toBeNull()
		})

		it("returns null when uuid maps to a directory item", async () => {
			const item = makeDirectoryItem("dir-uuid")
			mockCacheMap.set("dir-uuid", item)

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "dir-uuid" } }

			const result = await fetchData(params)

			expect(result).toBeNull()
		})
	})

	describe("drive type — fileCache hit path", () => {
		it("returns normalizeFilePathForExpo(uri) when fileCache.has is true and fileCacheFile.exists is true", async () => {
			const item = makeFileItem("hit-uuid")
			mockCacheMap.set("hit-uuid", item)

			const cachedUri = "file:///cache/filen/hit-uuid.bin"
			const cachedFile = new MockFile(cachedUri)
			fs.set(cachedUri, new Uint8Array([1, 2, 3]))

			mockFileCacheHas.mockResolvedValueOnce(true)
			mockFileCacheGet.mockResolvedValueOnce(cachedFile)

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "hit-uuid" } }
			const result = await fetchData(params)

			expect(mockOfflineGetLocalFile).not.toHaveBeenCalled()
			// The mock normalizeFilePathForExpo passes through "file://…" paths unchanged
			expect(result).toBe(cachedUri)
		})

		it("falls through to offline check when fileCache.has is true but file does not exist on disk", async () => {
			const item = makeFileItem("stale-uuid")
			mockCacheMap.set("stale-uuid", item)

			// File object returned but not in the in-memory fs → exists === false
			const staleFile = new MockFile("file:///cache/filen/stale-uuid.bin")
			// do NOT add to fs → staleFile.exists === false

			mockFileCacheHas.mockResolvedValueOnce(true)
			mockFileCacheGet.mockResolvedValueOnce(staleFile)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "stale-uuid" } }
			const result = await fetchData(params)

			expect(mockOfflineGetLocalFile).toHaveBeenCalled()
			// no local file and online, but getFileUrl → expect HTTP URL
			expect(result).not.toBeNull()
		})
	})

	describe("drive type — offline file fallback", () => {
		it("returns normalizeFilePathForExpo(uri) when offline file exists", async () => {
			const item = makeFileItem("offline-uuid")
			mockCacheMap.set("offline-uuid", item)

			const offlineUri = "file:///document/filen-offline/offline-uuid.bin"
			const offlineFile = new MockFile(offlineUri)
			fs.set(offlineUri, new Uint8Array([9, 8, 7]))

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(offlineFile)

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "offline-uuid" } }
			const result = await fetchData(params)

			// The mock normalizeFilePathForExpo passes through "file://…" paths unchanged
			expect(result).toBe(offlineUri)
			// Should NOT reach the online check
			expect(mockIsOnline).not.toHaveBeenCalled()
		})
	})

	describe("drive type — online gating", () => {
		it("returns null when no local copy and onlineManager.isOnline() is false", async () => {
			const item = makeFileItem("net-uuid")
			mockCacheMap.set("net-uuid", item)

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)
			mockIsOnline.mockReturnValue(false)

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "net-uuid" } }
			const result = await fetchData(params)

			expect(result).toBeNull()
			expect(mockGetFileUrl).not.toHaveBeenCalled()
		})

		it("returns null when online but useHttpStore.getFileUrl is null", async () => {
			const item = makeFileItem("no-provider-uuid")
			mockCacheMap.set("no-provider-uuid", item)

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)
			mockIsOnline.mockReturnValue(true)
			mockHttpStoreState.getFileUrl = null

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "no-provider-uuid" } }
			const result = await fetchData(params)

			expect(result).toBeNull()
		})
	})

	describe("drive type — HTTP provider URL path (via getFileUrlForItem)", () => {
		it("calls getFileUrl with AnyFile.File instance for item.type === 'file' and returns the URL", async () => {
			const item = makeFileItem("file-http-uuid")
			mockCacheMap.set("file-http-uuid", item)

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)
			mockIsOnline.mockReturnValue(true)
			mockHttpStoreState.getFileUrl = mockGetFileUrl

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "file-http-uuid" } }
			const result = await fetchData(params)

			expect(mockGetFileUrl).toHaveBeenCalledOnce()
			const calledArg = mockGetFileUrl.mock.calls[0]?.[0] as { tag: string; inner: unknown[] }

			expect(calledArg.tag).toBe("File")
			expect(calledArg.inner[0]).toBe(item.data)
			expect(result).toBe(`http://localhost:8080/file/${item.data.uuid}`)
		})

		it("calls getFileUrl with AnyFile.Shared instance for item.type === 'sharedFile'", async () => {
			const item = makeSharedFileItem("sf-http-uuid")
			mockCacheMap.set("sf-http-uuid", item)

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)
			mockIsOnline.mockReturnValue(true)
			mockHttpStoreState.getFileUrl = mockGetFileUrl

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "sf-http-uuid" } }
			const result = await fetchData(params)

			const calledArg = mockGetFileUrl.mock.calls[0]?.[0] as { tag: string; inner: unknown[] }

			expect(calledArg.tag).toBe("Shared")
			expect(calledArg.inner[0]).toBe(item.data)
			expect(result).not.toBeNull()
		})

		it("calls getFileUrl with AnyFile.Shared instance for item.type === 'sharedRootFile'", async () => {
			const item = makeSharedRootFileItem("srf-http-uuid")
			mockCacheMap.set("srf-http-uuid", item)

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)
			mockIsOnline.mockReturnValue(true)
			mockHttpStoreState.getFileUrl = mockGetFileUrl

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "srf-http-uuid" } }
			const result = await fetchData(params)

			const calledArg = mockGetFileUrl.mock.calls[0]?.[0] as { tag: string; inner: unknown[] }

			expect(calledArg.tag).toBe("Shared")
			expect(calledArg.inner[0]).toBe(item.data)
			expect(result).not.toBeNull()
		})

		it("returns null when getFileUrl throws (error-catch path in getFileUrlForItem)", async () => {
			const item = makeFileItem("throws-uuid")
			mockCacheMap.set("throws-uuid", item)

			mockFileCacheHas.mockResolvedValueOnce(false)
			mockOfflineGetLocalFile.mockResolvedValueOnce(null)
			mockIsOnline.mockReturnValue(true)
			mockHttpStoreState.getFileUrl = vi.fn().mockImplementation(() => {
				throw new Error("provider error")
			})

			const params: UseFileUrlQueryParams = { type: "drive", data: { uuid: "throws-uuid" } }
			const result = await fetchData(params)

			expect(result).toBeNull()
		})
	})
})
