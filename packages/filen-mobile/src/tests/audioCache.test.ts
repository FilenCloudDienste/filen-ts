import { vi, describe, it, expect, beforeEach } from "vitest"

const { UniffiEnum } = vi.hoisted(() => ({
	UniffiEnum: class UniffiEnum {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		protected constructor(..._args: any[]) {}
	}
}))

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/lib/fileCache", () => ({
	default: {
		getFiles: vi.fn(),
		get: vi.fn(),
		has: vi.fn().mockResolvedValue(false)
	}
}))

vi.mock("music-metadata", () => ({
	parseWebStream: vi.fn().mockResolvedValue({
		common: {
			artist: "Test Artist",
			title: "Test Song",
			album: "Test Album",
			date: "2024",
			picture: []
		},
		format: {
			duration: 180.5
		}
	})
}))

vi.mock("expo-image", () => ({
	Image: {
		loadAsync: vi.fn().mockResolvedValue({ release: vi.fn() }),
		generateBlurhashAsync: vi.fn().mockResolvedValue("mock-blurhash")
	}
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app",
	MUSIC_METADATA_SUPPORTED_EXTENSIONS: new Set([".mp3", ".m4a", ".flac", ".ogg", ".wav", ".aac", ".opus"])
}))

// eslint-disable-next-line import/first
import { fs, File, Directory } from "@/tests/mocks/expoFileSystem"
// eslint-disable-next-line import/first
import { pack } from "@/lib/msgpack"
// eslint-disable-next-line import/first
import type { DriveItem } from "@/types"
// eslint-disable-next-line import/first
import type { Metadata } from "@/lib/audioCache"

const fileCache = (await import("@/lib/fileCache")).default
const { parseWebStream } = await import("music-metadata")

const AUDIO_BASE_DIR = "file:///shared/group.io.filen.app/audioCache/v1"
const FILE_CACHE_BASE_DIR = "file:///shared/group.io.filen.app/fileCache/v1"

function makeFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900,
				mime: "audio/mpeg"
			},
			size: 100n
		}
	} as unknown as DriveItem
}

function makeDirItem(uuid: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			decryptedMeta: { name: "test-dir" }
		}
	} as unknown as DriveItem
}

function setupFileCacheGetFiles(): void {
	vi.mocked(fileCache.getFiles).mockImplementation(((item: DriveItem) => ({
		file: new File(`${FILE_CACHE_BASE_DIR}/${item.data.uuid}/${item.data.uuid}`),
		metadata: new File(`${FILE_CACHE_BASE_DIR}/${item.data.uuid}/${item.data.uuid}.filenmeta`),
		parentDirectory: new Directory(`${FILE_CACHE_BASE_DIR}/${item.data.uuid}`)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	})) as any)
}

async function createAudioCache(): Promise<InstanceType<(typeof import("@/lib/audioCache"))["AudioCache"]>> {
	const mod = await import("@/lib/audioCache")
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new (mod.AudioCache as new () => any)()
}

describe("AudioCache", () => {
	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
		setupFileCacheGetFiles()
	})

	describe("constructor", () => {
		it("creates the parent directory on construction", async () => {
			await createAudioCache()

			expect(fs.get(AUDIO_BASE_DIR)).toBe("dir")
		})
	})

	describe("getFiles", () => {
		it("returns audio file from fileCache and own metadata file", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-1", "song.mp3")

			const files = cache.getFiles(item)

			expect(files.audio.uri).toBe(`${FILE_CACHE_BASE_DIR}/uuid-1/uuid-1`)
			expect(files.metadata.uri).toBe(`${AUDIO_BASE_DIR}/uuid-1.filenmeta`)
		})
	})

	describe("has", () => {
		it("returns true when audio and metadata exist and metadata is non-empty", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-2", "song.mp3")

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-2/uuid-2`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-2.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Test Artist",
				title: "Test Song",
				album: null,
				date: null,
				duration: 180,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(pack(metadata)))

			const result = await cache.has(item)

			expect(result).toBe(true)
		})

		it("returns false for non-file items", async () => {
			const cache = await createAudioCache()
			const item = makeDirItem("uuid-3")

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when audio file doesn't exist", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-4", "song.mp3")

			const metaPath = `${AUDIO_BASE_DIR}/uuid-4.filenmeta`
			const metadata: Metadata = {
				artist: "Test",
				title: "Test",
				album: null,
				date: null,
				duration: 100,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(pack(metadata)))

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata doesn't exist", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-5", "song.mp3")

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-5/uuid-5`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata is empty/null", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-6", "song.mp3")

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-6/uuid-6`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-6.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			fs.set(metaPath, new Uint8Array(pack(null)))

			const result = await cache.has(item)

			expect(result).toBe(false)
		})
	})

	describe("get", () => {
		it("returns cached audio and metadata when both exist (cache hit)", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-7", "song.mp3")

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-7/uuid-7`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-7.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Cached Artist",
				title: "Cached Song",
				album: "Cached Album",
				date: "2024",
				duration: 200,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(pack(metadata)))

			const result = await cache.get({ item })

			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Cached Artist")
			expect(result.metadata!.title).toBe("Cached Song")
			expect(fileCache.get).not.toHaveBeenCalled()
		})

		it("downloads via fileCache and parses metadata for supported extension (cache miss)", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-8"
			const name = "song.mp3"
			const item = makeFileItem(uuid, name)

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const result = await cache.get({ item })

			expect(fileCache.get).toHaveBeenCalledWith({ item, signal: undefined })
			expect(parseWebStream).toHaveBeenCalled()
			expect(result.audio.uri).toBe(mockAudioFile.uri)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Test Artist")
			expect(result.metadata!.title).toBe("Test Song")
			expect(result.metadata!.duration).toBe(181)

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			expect(fs.has(metaPath)).toBe(true)
		})

		it("returns null metadata for unsupported extension", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-9"
			const name = "document.pdf"
			const item = makeFileItem(uuid, name)

			const mockFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}`)

			fs.set(mockFile.uri, new Uint8Array([1, 2, 3]))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockFile as any)

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()
			expect(parseWebStream).not.toHaveBeenCalled()
		})

		it("throws for non-file items", async () => {
			const cache = await createAudioCache()
			const item = makeDirItem("uuid-10")

			await expect(cache.get({ item })).rejects.toThrow("Item must be a file or shared file")
		})

		it("throws when decryptedMeta is null", async () => {
			const cache = await createAudioCache()
			const item = {
				type: "file",
				data: {
					uuid: "uuid-11",
					decryptedMeta: null,
					size: 100n
				}
			} as unknown as DriveItem

			await expect(cache.get({ item })).rejects.toThrow("Item metadata is not decrypted")
		})

		it("deletes metadata file on parse error", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-12"
			const name = "song.mp3"
			const item = makeFileItem(uuid, name)

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)
			vi.mocked(parseWebStream).mockRejectedValueOnce(new Error("Parse failed"))

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()
			expect(fs.has(metaPath)).toBe(false)
		})

		it("reads existing metadata file instead of re-parsing", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-13"
			const name = "song.mp3"
			const item = makeFileItem(uuid, name)

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`
			const existingMeta: Metadata = {
				artist: "Existing Artist",
				title: "Existing Song",
				album: null,
				date: null,
				duration: 300,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(pack(existingMeta)))

			const result = await cache.get({ item })

			expect(parseWebStream).not.toHaveBeenCalled()
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Existing Artist")
		})

		it("treats empty existing metadata as null", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-14"
			const name = "song.mp3"
			const item = makeFileItem(uuid, name)

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			fs.set(metaPath, new Uint8Array(pack(null)))

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()
		})
	})

	describe("getMetadata", () => {
		it("delegates to get and returns only metadata", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-15", "song.mp3")

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-15/uuid-15`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-15.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Meta Artist",
				title: "Meta Song",
				album: null,
				date: null,
				duration: 120,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(pack(metadata)))

			const result = await cache.getMetadata({ item })

			expect(result).not.toBeNull()
			expect(result!.artist).toBe("Meta Artist")
			expect(result!.title).toBe("Meta Song")
		})
	})

	describe("remove", () => {
		it("deletes only the metadata file", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-16", "song.mp3")

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-16/uuid-16`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-16.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			fs.set(metaPath, new Uint8Array(pack({ artist: "X", cachedAt: Date.now() })))

			await cache.remove(item)

			expect(fs.has(metaPath)).toBe(false)
			expect(fs.has(audioPath)).toBe(true)
		})

		it("throws for non-file items", async () => {
			const cache = await createAudioCache()
			const item = makeDirItem("uuid-17")

			await expect(cache.remove(item)).rejects.toThrow("Item must be a file or shared file")
		})

		it("does not throw when metadata doesn't exist", async () => {
			const cache = await createAudioCache()
			const item = makeFileItem("uuid-18", "song.mp3")

			await expect(cache.remove(item)).resolves.toBeUndefined()
		})
	})

	describe("gc", () => {
		it("deletes expired metadata files", async () => {
			const cache = await createAudioCache()
			const now = Date.now()
			const expiredMeta: Metadata = {
				artist: "Old",
				title: "Old Song",
				album: null,
				date: null,
				duration: 100,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: now - 86400 * 1000 - 1
			}

			const metaPath = `${AUDIO_BASE_DIR}/expired-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(pack(expiredMeta)))

			await cache.gc()

			expect(fs.has(metaPath)).toBe(false)
		})

		it("keeps fresh metadata files", async () => {
			const cache = await createAudioCache()
			const freshMeta: Metadata = {
				artist: "Fresh",
				title: "Fresh Song",
				album: null,
				date: null,
				duration: 100,
				pictureBase64: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			const metaPath = `${AUDIO_BASE_DIR}/fresh-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(pack(freshMeta)))

			await cache.gc()

			expect(fs.has(metaPath)).toBe(true)
		})

		it("deletes empty/null metadata files", async () => {
			const cache = await createAudioCache()

			const metaPath = `${AUDIO_BASE_DIR}/empty-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(pack(null)))

			await cache.gc()

			expect(fs.has(metaPath)).toBe(false)
		})
	})
})
