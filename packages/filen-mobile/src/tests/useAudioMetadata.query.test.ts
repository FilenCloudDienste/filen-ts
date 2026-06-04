import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockCacheMap, mockAudioCacheGetMetadata } = vi.hoisted(() => ({
	mockCacheMap: new Map<string, unknown>(),
	mockAudioCacheGetMetadata: vi.fn()
}))

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

vi.mock("@/features/audio/audioCache", () => ({
	default: {
		getMetadata: mockAudioCacheGetMetadata
	}
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: vi.fn(),
		set: vi.fn()
	}
}))

import { fetchData } from "@/features/audio/queries/useAudioMetadata.query"
import { type UseAudioMetadataQueryParams } from "@/features/audio/queries/useAudioMetadata.query"

const FAKE_METADATA = {
	title: "Test Track",
	artist: "Test Artist",
	album: "Test Album",
	date: "2024",
	duration: 180,
	pictureUri: null,
	pictureBlurhash: null,
	cachedAt: 1000000
}

function makeFileItem(uuid = "file-uuid-1") {
	return {
		type: "file" as const,
		data: {
			uuid,
			size: 1024n,
			undecryptable: false,
			decryptedMeta: { name: "track.mp3", mime: "audio/mpeg", modified: 1000, created: 1000 }
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
			decryptedMeta: { name: "shared.mp3", mime: "audio/mpeg", modified: 1000, created: 1000 }
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
			decryptedMeta: { name: "root.mp3", mime: "audio/mpeg", modified: 1000, created: 1000 }
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

describe("fetchData (useAudioMetadata.query)", () => {
	beforeEach(() => {
		mockCacheMap.clear()
		mockAudioCacheGetMetadata.mockReset().mockResolvedValue(FAKE_METADATA)
	})

	describe("drive type — error paths", () => {
		it("throws 'Drive item not found or is not a file' when uuid is not in cache", async () => {
			const params: UseAudioMetadataQueryParams = { type: "drive", data: { uuid: "missing-uuid" } }

			await expect(fetchData(params)).rejects.toThrow("Drive item not found or is not a file")
			expect(mockAudioCacheGetMetadata).not.toHaveBeenCalled()
		})

		it("throws when uuid maps to a directory item", async () => {
			const item = makeDirectoryItem("dir-only")
			mockCacheMap.set("dir-only", item)

			const params: UseAudioMetadataQueryParams = { type: "drive", data: { uuid: "dir-only" } }

			await expect(fetchData(params)).rejects.toThrow("Drive item not found or is not a file")
			expect(mockAudioCacheGetMetadata).not.toHaveBeenCalled()
		})
	})

	describe("drive type — file items", () => {
		it("calls audioCache.getMetadata with { item: { type: 'drive', data: item }, signal } and returns its result for a file item", async () => {
			const item = makeFileItem("audio-file-uuid")
			mockCacheMap.set("audio-file-uuid", item)

			const signal = new AbortController().signal
			const params: UseAudioMetadataQueryParams = { type: "drive", data: { uuid: "audio-file-uuid" } }
			const result = await fetchData({ ...params, signal })

			expect(mockAudioCacheGetMetadata).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal
			})
			expect(result).toEqual(FAKE_METADATA)
		})

		it("calls audioCache.getMetadata with sharedFile item wrapped in { type: 'drive', data: item }", async () => {
			const item = makeSharedFileItem("sf-audio-uuid")
			mockCacheMap.set("sf-audio-uuid", item)

			const params: UseAudioMetadataQueryParams = { type: "drive", data: { uuid: "sf-audio-uuid" } }
			await fetchData(params)

			expect(mockAudioCacheGetMetadata).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal: undefined
			})
		})

		it("calls audioCache.getMetadata with sharedRootFile item wrapped in { type: 'drive', data: item }", async () => {
			const item = makeSharedRootFileItem("srf-audio-uuid")
			mockCacheMap.set("srf-audio-uuid", item)

			const params: UseAudioMetadataQueryParams = { type: "drive", data: { uuid: "srf-audio-uuid" } }
			await fetchData(params)

			expect(mockAudioCacheGetMetadata).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal: undefined
			})
		})

		it("forwards signal when provided for drive type", async () => {
			const item = makeFileItem("sig-audio-uuid")
			mockCacheMap.set("sig-audio-uuid", item)

			const signal = new AbortController().signal
			const params: UseAudioMetadataQueryParams = { type: "drive", data: { uuid: "sig-audio-uuid" } }
			await fetchData({ ...params, signal })

			expect(mockAudioCacheGetMetadata).toHaveBeenCalledWith({
				item: { type: "drive", data: item },
				signal
			})
		})
	})

	describe("external type", () => {
		it("calls audioCache.getMetadata with { item: { type: 'external', data: params.data }, signal: params.signal }", async () => {
			const externalData = { url: "https://cdn.example.com/track.mp3", name: "track.mp3" }
			const signal = new AbortController().signal
			const params: UseAudioMetadataQueryParams = { type: "external", data: externalData }
			const result = await fetchData({ ...params, signal })

			expect(mockAudioCacheGetMetadata).toHaveBeenCalledWith({
				item: { type: "external", data: externalData },
				signal
			})
			expect(result).toEqual(FAKE_METADATA)
		})

		it("forwards signal correctly for external type", async () => {
			const signal = new AbortController().signal
			const params: UseAudioMetadataQueryParams = {
				type: "external",
				data: { url: "https://cdn.example.com/song.flac", name: "song.flac" }
			}
			await fetchData({ ...params, signal })

			const callArg = mockAudioCacheGetMetadata.mock.calls[0]?.[0] as { signal: AbortSignal }

			expect(callArg.signal).toBe(signal)
		})

		it("does not access the cache map for external type", async () => {
			const params: UseAudioMetadataQueryParams = {
				type: "external",
				data: { url: "https://cdn.example.com/bypass.mp3", name: "bypass.mp3" }
			}
			await fetchData(params)

			// cache map should never have been consulted — no entries, no errors
			expect(mockCacheMap.size).toBe(0)
			expect(mockAudioCacheGetMetadata).toHaveBeenCalledOnce()
		})
	})
})
