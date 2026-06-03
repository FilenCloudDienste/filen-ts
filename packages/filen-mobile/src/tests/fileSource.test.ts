import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockFileCacheGet, mockCacheMap } = vi.hoisted(() => {
	const mockFileCacheGet = vi.fn()
	const mockCacheMap = new Map<string, unknown>()

	return { mockFileCacheGet, mockCacheMap }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@filen/sdk-rs", () => ({
	AnyFile: {
		File: class {
			tag = "File"
			constructor(public inner: unknown) {}
		},
		Shared: class {
			tag = "Shared"
			constructor(public inner: unknown) {}
		}
	},
	ManagedFuture: { new: vi.fn(() => ({})) }
}))

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: mockCacheMap
	}
}))

vi.mock("@/lib/fileCache", () => ({
	default: {
		get: mockFileCacheGet
	}
}))

// fileSource.ts also imports expo-file-system for the File type; the mock covers that
// It also imports clearBarrier, serializer, storageRoots through fileCache — all via the vi.mock above

import { resolveFile } from "@/queries/fileSource"
import { type FileSource } from "@/queries/fileSource"
import { File as MockFile } from "@/tests/mocks/expoFileSystem"

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

function makeSharedDirectoryItem(uuid = "shared-dir-1") {
	return {
		type: "sharedDirectory" as const,
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta: { name: "shared-dir", color: null }
		}
	}
}

describe("resolveFile", () => {
	beforeEach(() => {
		mockCacheMap.clear()
		mockFileCacheGet.mockReset()
	})

	describe("drive type — file items", () => {
		it("delegates to fileCache.get with { type: 'drive', data: item } when uuid maps to a file", async () => {
			const item = makeFileItem("abc-123")
			mockCacheMap.set("abc-123", item)
			const mockFile = new MockFile("file:///cache/abc-123.bin")
			mockFileCacheGet.mockResolvedValueOnce(mockFile)

			const source: FileSource = { type: "drive", data: { uuid: "abc-123" } }
			const result = await resolveFile(source)

			expect(mockFileCacheGet).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal: undefined
			})
			expect(result).toBe(mockFile)
		})

		it("forwards AbortSignal to fileCache.get for drive type", async () => {
			const item = makeFileItem("sig-uuid")
			mockCacheMap.set("sig-uuid", item)
			const mockFile = new MockFile("file:///cache/sig-uuid.bin")
			mockFileCacheGet.mockResolvedValueOnce(mockFile)

			const signal = new AbortController().signal
			const source: FileSource = { type: "drive", data: { uuid: "sig-uuid" } }
			await resolveFile(source, signal)

			expect(mockFileCacheGet).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal
			})
		})

		it("delegates to fileCache.get with sharedFile item wrapped in { type: 'drive', data: item }", async () => {
			const item = makeSharedFileItem("sf-uuid")
			mockCacheMap.set("sf-uuid", item)
			const mockFile = new MockFile("file:///cache/sf-uuid.bin")
			mockFileCacheGet.mockResolvedValueOnce(mockFile)

			const source: FileSource = { type: "drive", data: { uuid: "sf-uuid" } }
			await resolveFile(source)

			expect(mockFileCacheGet).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal: undefined
			})
		})

		it("delegates to fileCache.get with sharedRootFile item wrapped in { type: 'drive', data: item }", async () => {
			const item = makeSharedRootFileItem("srf-uuid")
			mockCacheMap.set("srf-uuid", item)
			const mockFile = new MockFile("file:///cache/srf-uuid.bin")
			mockFileCacheGet.mockResolvedValueOnce(mockFile)

			const source: FileSource = { type: "drive", data: { uuid: "srf-uuid" } }
			await resolveFile(source)

			expect(mockFileCacheGet).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal: undefined
			})
		})
	})

	describe("drive type — error paths", () => {
		it("throws 'Drive item not found or is not a file' when uuid is not in cache", async () => {
			const source: FileSource = { type: "drive", data: { uuid: "missing-uuid" } }

			await expect(resolveFile(source)).rejects.toThrow("Drive item not found or is not a file")
			expect(mockFileCacheGet).not.toHaveBeenCalled()
		})

		it("throws when uuid maps to a directory item", async () => {
			const item = makeDirectoryItem("dir-only")
			mockCacheMap.set("dir-only", item)

			const source: FileSource = { type: "drive", data: { uuid: "dir-only" } }

			await expect(resolveFile(source)).rejects.toThrow("Drive item not found or is not a file")
			expect(mockFileCacheGet).not.toHaveBeenCalled()
		})

		it("throws when uuid maps to a sharedDirectory item", async () => {
			const item = makeSharedDirectoryItem("shared-dir-only")
			mockCacheMap.set("shared-dir-only", item)

			const source: FileSource = { type: "drive", data: { uuid: "shared-dir-only" } }

			await expect(resolveFile(source)).rejects.toThrow("Drive item not found or is not a file")
			expect(mockFileCacheGet).not.toHaveBeenCalled()
		})
	})

	describe("external type", () => {
		it("passes source directly to fileCache.get as CacheItem { type: 'external', data: { url, name } }", async () => {
			const mockFile = new MockFile("file:///cache/external.bin")
			mockFileCacheGet.mockResolvedValueOnce(mockFile)

			const source: FileSource = { type: "external", data: { url: "https://cdn.example.com/file.bin", name: "file.bin" } }
			const result = await resolveFile(source)

			expect(mockFileCacheGet).toHaveBeenCalledWith({
				item: source,
				signal: undefined
			})
			expect(result).toBe(mockFile)
		})

		it("forwards AbortSignal to fileCache.get for external type", async () => {
			const mockFile = new MockFile("file:///cache/external.bin")
			mockFileCacheGet.mockResolvedValueOnce(mockFile)

			const signal = new AbortController().signal
			const source: FileSource = { type: "external", data: { url: "https://cdn.example.com/x.mp3", name: "x.mp3" } }
			await resolveFile(source, signal)

			expect(mockFileCacheGet).toHaveBeenCalledWith({
				item: source,
				signal
			})
		})
	})
})
