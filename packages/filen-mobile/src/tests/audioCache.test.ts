import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

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

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import { fs, File, Directory } from "@/tests/mocks/expoFileSystem"
import { serialize } from "@/lib/serializer"
import { xxHash32 } from "js-xxhash"
import { type DriveItem, type CacheItem } from "@/types"
import { type Metadata } from "@/features/audio/audioCache"

const fileCache = (await import("@/lib/fileCache")).default
const { parseWebStream } = await import("music-metadata")
const { Image } = await import("expo-image")

function extname(filename: string): string {
	const dot = filename.lastIndexOf(".")

	return dot === -1 ? "" : filename.slice(dot)
}

const AUDIO_BASE_DIR = "file:///shared/group.io.filen.app/audioCache/v2"
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
			undecryptable: false,
			size: 100n
		}
	} as unknown as DriveItem
}

function makeDirItem(uuid: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			decryptedMeta: { name: "test-dir" },
			undecryptable: false
		}
	} as unknown as DriveItem
}

function makeSharedRootFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "sharedRootFile",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900,
				mime: "audio/mpeg"
			},
			undecryptable: false,
			size: 100n
		}
	} as unknown as DriveItem
}

function wrapDrive(item: DriveItem): CacheItem {
	return {
		type: "drive",
		data: item
	}
}

function makeExternalItem(url: string, name: string): CacheItem {
	return {
		type: "external",
		data: {
			url,
			name
		}
	}
}

function externalId(url: string): string {
	return xxHash32(url).toString(16)
}

function setupFileCacheGetFiles(): void {
	vi.mocked(fileCache.getFiles).mockImplementation(((item: CacheItem) => {
		if (item.type === "drive") {
			const driveItem = item.data

			return {
				file: new File(
					`${FILE_CACHE_BASE_DIR}/${driveItem.data.uuid}/${driveItem.data.uuid}${extname(driveItem.data.decryptedMeta!.name)}`
				),
				metadata: new File(`${FILE_CACHE_BASE_DIR}/${driveItem.data.uuid}/${driveItem.data.uuid}.filenmeta`),
				parentDirectory: new Directory(`${FILE_CACHE_BASE_DIR}/${driveItem.data.uuid}`)
			}
		}

		const id = externalId(item.data.url)

		return {
			file: new File(`${FILE_CACHE_BASE_DIR}/${id}/${id}${extname(item.data.name)}`),
			metadata: new File(`${FILE_CACHE_BASE_DIR}/${id}/${id}.filenmeta`),
			parentDirectory: new Directory(`${FILE_CACHE_BASE_DIR}/${id}`)
		}
	}) as any)
}

async function createAudioCache(): Promise<InstanceType<(typeof import("@/features/audio/audioCache"))["AudioCache"]>> {
	const mod = await import("@/features/audio/audioCache")
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
			const item = wrapDrive(makeFileItem("uuid-1", "song.mp3"))

			const files = cache.getFiles(item)

			expect(files.audio.uri).toBe(`${FILE_CACHE_BASE_DIR}/uuid-1/uuid-1.mp3`)
			expect(files.metadata.uri).toBe(`${AUDIO_BASE_DIR}/uuid-1.filenmeta`)
		})

		it("returns hashed metadata path for external items", async () => {
			const cache = await createAudioCache()
			const url = "https://example.com/song.mp3"
			const item = makeExternalItem(url, "song.mp3")
			const id = externalId(url)

			const files = cache.getFiles(item)

			expect(files.audio.uri).toBe(`${FILE_CACHE_BASE_DIR}/${id}/${id}.mp3`)
			expect(files.metadata.uri).toBe(`${AUDIO_BASE_DIR}/${id}.filenmeta`)
		})
	})

	describe("get", () => {
		it("returns cached audio and metadata when both exist (cache hit)", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeFileItem("uuid-7", "song.mp3"))

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-7/uuid-7.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-7.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Cached Artist",
				title: "Cached Song",
				album: "Cached Album",
				date: "2024",
				duration: 200,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			const result = await cache.get({ item })

			// Verify fast-path: no download, cached metadata is returned verbatim
			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Cached Artist")
			expect(result.metadata!.title).toBe("Cached Song")
			expect(result.metadata!.album).toBe("Cached Album")
			expect(fileCache.get).not.toHaveBeenCalled()
			expect(parseWebStream).not.toHaveBeenCalled()
		})

		it("recovers from a corrupt fast-path metadata sidecar instead of throwing", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-corrupt-fast"
			const name = "song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const audioPath = `${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			// Audio + non-empty metadata sidecar both exist (passes the fast-path guard),
			// but the sidecar contains invalid JSON so deserialize() throws.
			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			fs.set(metaPath, new Uint8Array(new TextEncoder().encode("{this is not valid json}")))

			const mockAudioFile = new File(audioPath)

			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const result = await cache.get({ item })

			// Falls through to fileCache.get() + re-parse rather than propagating the parse error.
			expect(fileCache.get).toHaveBeenCalledWith({ item, signal: undefined })
			expect(parseWebStream).toHaveBeenCalled()
			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Test Artist")
			expect(fs.has(metaPath)).toBe(true)
		})

		it("downloads via fileCache and parses metadata for supported extension (cache miss)", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-8"
			const name = "song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
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

		it("writes the metadata sidecar atomically (temp file + single overwriting move)", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-atomic-sidecar"
			const name = "atomic.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const moveSpy = vi.spyOn(File.prototype, "moveSync")
			let moveCalls: unknown[][] = []

			try {
				await cache.get({ item })
			} finally {
				// mockRestore clears the recorded calls — snapshot them first.
				moveCalls = [...moveSpy.mock.calls]

				moveSpy.mockRestore()
			}

			// The sidecar landed via an overwriting move of a temp sibling, never a direct write.
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`
			const sidecarMove = moveCalls.find(call => (call[0] as File).uri === metaPath)

			expect(sidecarMove).toBeDefined()
			expect(sidecarMove?.[1]).toEqual({ overwrite: true })
			expect(fs.has(metaPath)).toBe(true)

			// No temp file leaked into filen-tmp.
			for (const key of fs.keys()) {
				expect(key.includes("/filen-tmp/.tmp-")).toBe(false)
			}
		})

		it("skips metadata parsing for files larger than the parse-size cap", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-large"
			const name = "huge.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			// Mock cap is 1024 bytes — make the on-disk audio file exceed it.
			fs.set(mockAudioFile.uri, new Uint8Array(2048))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const result = await cache.get({ item })

			// Parse is skipped to protect the JS thread; the track is still returned for playback.
			expect(parseWebStream).not.toHaveBeenCalled()
			expect(result.metadata).toBeNull()
			expect(result.audio.uri).toBe(mockAudioFile.uri)

			// No sidecar is written when parsing is skipped.
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			expect(fs.has(metaPath)).toBe(false)
		})

		it("parses metadata for a file exactly at the parse-size cap (boundary)", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-at-cap"
			const name = "atcap.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			// Exactly at the cap (1024) still parses — the gate skips only when strictly greater.
			fs.set(mockAudioFile.uri, new Uint8Array(1024))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const result = await cache.get({ item })

			expect(parseWebStream).toHaveBeenCalled()
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Test Artist")
		})

		it("serializes parsing across different items via the global semaphore without deadlocking", async () => {
			const cache = await createAudioCache()

			const itemA = wrapDrive(makeFileItem("uuid-par-a", "a.mp3"))
			const itemB = wrapDrive(makeFileItem("uuid-par-b", "b.mp3"))

			const fileA = new File(`${FILE_CACHE_BASE_DIR}/uuid-par-a/uuid-par-a.mp3`)
			const fileB = new File(`${FILE_CACHE_BASE_DIR}/uuid-par-b/uuid-par-b.mp3`)

			fs.set(fileA.uri, new Uint8Array([1, 2, 3]))
			fs.set(fileB.uri, new Uint8Array([4, 5, 6]))

			// Return the matching audio file per item, independent of call order.
			vi.mocked(fileCache.get).mockImplementation((async ({ item }: { item: CacheItem }) =>
				item.type === "drive" && item.data.data.uuid === "uuid-par-a" ? fileA : fileB) as any)

			// Both fire concurrently — with the N=1 parse semaphore they must still both
			// resolve (the deferred release runs on every exit path, so no hang).
			const [resA, resB] = await Promise.all([cache.get({ item: itemA }), cache.get({ item: itemB })])

			expect(resA.metadata).not.toBeNull()
			expect(resB.metadata).not.toBeNull()
			expect(parseWebStream).toHaveBeenCalledTimes(2)
		})

		it("returns null metadata for unsupported extension", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-9"
			const name = "document.pdf"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			fs.set(mockFile.uri, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockFile as any)

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()
			expect(parseWebStream).not.toHaveBeenCalled()
		})

		it("throws for non-file items", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeDirItem("uuid-10"))

			await expect(cache.get({ item })).rejects.toThrow("Item must be a file or shared file")
		})

		it("throws when decryptedMeta is null", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive({
				type: "file",
				data: {
					uuid: "uuid-11",
					decryptedMeta: null,
					undecryptable: false,
					size: 100n
				}
			} as unknown as DriveItem)

			await expect(cache.get({ item })).rejects.toThrow("Item metadata is not decrypted")
		})

		it("deletes metadata file on parse error", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-12"
			const name = "song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)
			vi.mocked(parseWebStream).mockRejectedValueOnce(new Error("Parse failed"))

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()
			expect(fs.has(metaPath)).toBe(false)
		})

		it("treats empty existing metadata as null", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-14"
			const name = "song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			fs.set(mockAudioFile.uri, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(null))))

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()
		})

		it("returns null metadata when audio file does not exist after download", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-dl-noexist"
			const name = "song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const mockAudioFile = new File(`${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}${extname(name)}`)

			// Return a File that does NOT exist in the mock FS
			vi.mocked(fileCache.get).mockImplementationOnce(async () => mockAudioFile as any)

			const result = await cache.get({ item })

			expect(result.metadata).toBeNull()

			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			expect(fs.has(metaPath)).toBe(false)
		})

		it("works with sharedFile type items", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-shared"
			const name = "shared-song.mp3"
			const item = wrapDrive({
				type: "sharedFile" as const,
				data: {
					uuid,
					decryptedMeta: {
						name,
						size: 100n,
						modified: 1000,
						created: 900,
						mime: "audio/mpeg"
					},
					undecryptable: false,
					size: 100n
				}
			} as unknown as DriveItem)

			const audioPath = `${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Shared Artist",
				title: "Shared Song",
				album: null,
				date: null,
				duration: 150,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			const result = await cache.get({ item })

			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Shared Artist")
		})

		it("works with sharedRootFile type items (cache hit)", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-shared-root-get"
			const name = "root-song.mp3"
			const item = wrapDrive(makeSharedRootFileItem(uuid, name))

			const audioPath = `${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Root Artist",
				title: "Root Song",
				album: null,
				date: null,
				duration: 130,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			const result = await cache.get({ item })

			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Root Artist")
			expect(result.metadata!.title).toBe("Root Song")
			expect(fileCache.get).not.toHaveBeenCalled()
		})

		it("works with external items (cache hit by hashed url id)", async () => {
			const cache = await createAudioCache()
			const url = "https://example.com/track.mp3"
			const item = makeExternalItem(url, "track.mp3")
			const id = externalId(url)

			const audioPath = `${FILE_CACHE_BASE_DIR}/${id}/${id}.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/${id}.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "External Artist",
				title: "External Song",
				album: null,
				date: null,
				duration: 240,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			const result = await cache.get({ item })

			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("External Artist")
			expect(fileCache.get).not.toHaveBeenCalled()
		})

		it("downloads external item via fileCache on cache miss and writes metadata sidecar", async () => {
			const cache = await createAudioCache()
			const url = "https://cdn.example.com/stream.mp3"
			const item = makeExternalItem(url, "stream.mp3")
			const id = externalId(url)

			const audioPath = `${FILE_CACHE_BASE_DIR}/${id}/${id}.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/${id}.filenmeta`

			const mockAudioFile = new File(audioPath)

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			const result = await cache.get({ item })

			// Confirm hashed id was used and fileCache was called for the external item
			expect(fileCache.get).toHaveBeenCalledWith({ item, signal: undefined })
			expect(parseWebStream).toHaveBeenCalled()
			expect(result.audio.uri).toBe(audioPath)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.artist).toBe("Test Artist")
			// Metadata must be persisted under the hashed id, not the URL
			expect(fs.has(metaPath)).toBe(true)
		})

		it("writes picture file and calls Image.loadAsync + Image.generateBlurhashAsync when picture data is present", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-with-picture"
			const name = "picture-song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const audioPath = `${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			const mockAudioFile = new File(audioPath)

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			// Return a picture in the parsed metadata
			const pictureData = new Uint8Array([0xff, 0xd8, 0xff]) // minimal JPEG header bytes
			vi.mocked(parseWebStream).mockResolvedValueOnce({
				common: {
					artist: "Picture Artist",
					title: "Picture Song",
					album: null,
					date: null,
					picture: [{ format: "image/jpeg", data: pictureData, type: "Cover (front)", description: "" }]
				},
				format: { duration: 99.0 }
			} as any)

			const result = await cache.get({ item })

			// Picture file must be written under PARENT_DIRECTORY with the correct uuid name
			const expectedPicturePath = `${AUDIO_BASE_DIR}/${uuid}.jpg`

			expect(fs.has(expectedPicturePath)).toBe(true)
			expect(fs.get(expectedPicturePath)).toEqual(pictureData)

			// Image was loaded and blurhash generated
			expect(Image.loadAsync).toHaveBeenCalledWith(expectedPicturePath)
			expect(Image.generateBlurhashAsync).toHaveBeenCalled()

			// Metadata sidecar stores the picture URI and blurhash
			expect(fs.has(metaPath)).toBe(true)
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.pictureUri).toBe(expectedPicturePath)
			expect(result.metadata!.pictureBlurhash).toBe("mock-blurhash")
			expect(result.metadata!.artist).toBe("Picture Artist")
		})

		it("releases the ImageRef even when blurhash generation throws", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-blurhash-fail"
			const name = "fail-song.mp3"
			const item = wrapDrive(makeFileItem(uuid, name))

			const audioPath = `${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}.mp3`

			const mockAudioFile = new File(audioPath)
			const mockRelease = vi.fn()

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCache.get).mockResolvedValueOnce(mockAudioFile as any)

			vi.mocked(parseWebStream).mockResolvedValueOnce({
				common: {
					artist: "Fail Artist",
					title: "Fail Song",
					album: null,
					date: null,
					picture: [{ format: "image/jpeg", data: new Uint8Array([1]), type: "Cover (front)", description: "" }]
				},
				format: { duration: 10.0 }
			} as any)

			// loadAsync succeeds but generateBlurhashAsync throws
			vi.mocked(Image.loadAsync).mockResolvedValueOnce({ release: mockRelease } as any)
			vi.mocked(Image.generateBlurhashAsync).mockRejectedValueOnce(new Error("Blurhash failed"))

			const result = await cache.get({ item })

			// The error must be swallowed; pictureBlurhash is null but the rest succeeds
			expect(result.metadata).not.toBeNull()
			expect(result.metadata!.pictureBlurhash).toBeNull()
			expect(result.metadata!.artist).toBe("Fail Artist")

			// The finally block must have released the image reference
			expect(mockRelease).toHaveBeenCalled()
		})
	})

	describe("getMetadata", () => {
		it("delegates to get and returns only metadata", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeFileItem("uuid-15", "song.mp3"))

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-15/uuid-15.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-15.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))

			const metadata: Metadata = {
				artist: "Meta Artist",
				title: "Meta Song",
				album: null,
				date: null,
				duration: 120,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			const result = await cache.getMetadata({ item })

			expect(result).not.toBeNull()
			expect(result!.artist).toBe("Meta Artist")
			expect(result!.title).toBe("Meta Song")
		})

		it("returns the cached sidecar WITHOUT re-downloading when the audio bytes were evicted (AU-08)", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeFileItem("uuid-meta-only", "song.mp3"))
			const metaPath = `${AUDIO_BASE_DIR}/uuid-meta-only.filenmeta`

			// Sidecar present, audio BYTES absent — the steady state, since the metadata sidecar and the
			// full audio bytes (fileCache, 250MB cap) evict independently. A metadata-only read must NOT
			// fall through to a full fileCache.get() re-download just to render a title/cover.
			const metadata: Metadata = {
				artist: "Solo Artist",
				title: "Solo Song",
				album: "Solo Album",
				date: "2024",
				duration: 100,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			const result = await cache.getMetadata({ item })

			expect(result).not.toBeNull()
			expect(result!.title).toBe("Solo Song")
			expect(fileCache.get).not.toHaveBeenCalled()
		})
	})

	describe("remove", () => {
		it("deletes only the metadata file when no pictureUri is stored", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeFileItem("uuid-16", "song.mp3"))

			const audioPath = `${FILE_CACHE_BASE_DIR}/uuid-16/uuid-16.mp3`
			const metaPath = `${AUDIO_BASE_DIR}/uuid-16.filenmeta`

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize({ artist: "X", cachedAt: Date.now() }))))

			await cache.remove(item)

			// Only sidecar is deleted; audio in fileCache is untouched
			expect(fs.has(metaPath)).toBe(false)
			expect(fs.has(audioPath)).toBe(true)
		})

		it("also deletes the picture file when pictureUri is stored in metadata", async () => {
			const cache = await createAudioCache()
			const uuid = "uuid-remove-picture"
			const item = wrapDrive(makeFileItem(uuid, "song.mp3"))

			const audioPath = `${FILE_CACHE_BASE_DIR}/${uuid}/${uuid}.mp3`
			const picturePath = `${AUDIO_BASE_DIR}/${uuid}.jpg`
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			const metadata: Metadata = {
				artist: "PicArtist",
				title: "PicSong",
				album: null,
				date: null,
				duration: 60,
				pictureUri: picturePath,
				pictureBlurhash: "some-blurhash",
				cachedAt: Date.now()
			}

			fs.set(audioPath, new Uint8Array([1, 2, 3]))
			fs.set(picturePath, new Uint8Array([0xff, 0xd8]))
			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(metadata))))

			await cache.remove(item)

			// Both sidecar and picture file are deleted; audio in fileCache stays
			expect(fs.has(metaPath)).toBe(false)
			expect(fs.has(picturePath)).toBe(false)
			expect(fs.has(audioPath)).toBe(true)
		})

		it("throws for non-file items", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeDirItem("uuid-17"))

			await expect(cache.remove(item)).rejects.toThrow("Item must be a file or shared file")
		})

		it("does not throw when metadata doesn't exist", async () => {
			const cache = await createAudioCache()
			const item = wrapDrive(makeFileItem("uuid-18", "song.mp3"))

			await expect(cache.remove(item)).resolves.toBeUndefined()
		})

		it("throws for sharedRootFile items that reference directories", async () => {
			// Verify the guard: remove() must accept sharedRootFile types (not throw "must be file")
			const cache = await createAudioCache()
			const uuid = "uuid-remove-shared-root"
			const item = wrapDrive(makeSharedRootFileItem(uuid, "song.mp3"))
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize({ artist: "R", cachedAt: Date.now() }))))

			// remove() should succeed (not throw) for sharedRootFile
			await expect(cache.remove(item)).resolves.toBeUndefined()
			expect(fs.has(metaPath)).toBe(false)
		})
	})

	describe("gc", () => {
		it("returns early without throwing when PARENT_DIRECTORY does not exist", async () => {
			const cache = await createAudioCache()

			// Wipe the directory that was created in the constructor
			fs.delete(AUDIO_BASE_DIR)

			// gc() must not throw and must not create the directory
			await expect(cache.gc()).resolves.toBeUndefined()
			expect(fs.has(AUDIO_BASE_DIR)).toBe(false)
		})

		it("deletes expired metadata files", async () => {
			const cache = await createAudioCache()
			const now = Date.now()
			const expiredMeta: Metadata = {
				artist: "Old",
				title: "Old Song",
				album: null,
				date: null,
				duration: 100,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: now - 86400 * 1000 - 1
			}

			const metaPath = `${AUDIO_BASE_DIR}/expired-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(expiredMeta))))

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
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			const metaPath = `${AUDIO_BASE_DIR}/fresh-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(freshMeta))))

			await cache.gc()

			expect(fs.has(metaPath)).toBe(true)
		})

		it("deletes a 0-byte metadata file via the size===0 guard before deserialization", async () => {
			const cache = await createAudioCache()
			// A genuinely empty (0-byte) file hits metadata.size === 0 in has() and
			// Object.keys({}).length === 0 in gc() — distinct from a null-serialized file.
			const metaPath = `${AUDIO_BASE_DIR}/zerobyte-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(0))

			await cache.gc()

			expect(fs.has(metaPath)).toBe(false)
		})

		it("tolerates a corrupted sidecar and still sweeps the rest", async () => {
			const cache = await createAudioCache()
			const expiredMeta: Metadata = {
				artist: "Old",
				title: "Old Song",
				album: null,
				date: null,
				duration: 1,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now() - 86400 * 1000 - 1
			}

			const goodPath = `${AUDIO_BASE_DIR}/good-uuid.filenmeta`
			const corruptPath = `${AUDIO_BASE_DIR}/corrupt-uuid.filenmeta`

			fs.set(goodPath, new Uint8Array(new TextEncoder().encode(serialize(expiredMeta))))
			fs.set(corruptPath, new Uint8Array(new TextEncoder().encode("not valid msgpackr at all")))

			await expect(cache.gc()).resolves.toBeUndefined()

			expect(fs.has(goodPath)).toBe(false)
			expect(fs.has(corruptPath)).toBe(false)
		})

		it("wipes everything when called with age=0", async () => {
			const cache = await createAudioCache()
			const freshMeta: Metadata = {
				artist: "Fresh",
				title: "Fresh Song",
				album: null,
				date: null,
				duration: 100,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			const metaPath = `${AUDIO_BASE_DIR}/fresh-uuid.filenmeta`

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(freshMeta))))

			await cache.gc(0)

			expect(fs.has(metaPath)).toBe(false)
		})

		it("sweeps an orphan picture file whose sidecar does not exist", async () => {
			const cache = await createAudioCache()
			const orphanJpg = `${AUDIO_BASE_DIR}/orphan-uuid.jpg`

			fs.set(orphanJpg, new Uint8Array([1, 2, 3]))

			await cache.gc()

			expect(fs.has(orphanJpg)).toBe(false)
		})

		it("keeps a picture whose fresh sidecar exists", async () => {
			const cache = await createAudioCache()
			const uuid = "kept-uuid"
			const picturePath = `${AUDIO_BASE_DIR}/${uuid}.jpg`
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`
			const freshMeta: Metadata = {
				artist: "Fresh",
				title: "Fresh",
				album: null,
				date: null,
				duration: 1,
				pictureUri: picturePath,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}

			fs.set(picturePath, new Uint8Array([1, 2, 3]))
			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(freshMeta))))

			await cache.gc()

			expect(fs.has(picturePath)).toBe(true)
			expect(fs.has(metaPath)).toBe(true)
		})

		it("skips deletion when the sidecar becomes fresh between Pass 1's read and the mutex re-check", async () => {
			const cache = await createAudioCache()
			const uuid = "race-uuid"
			const metaPath = `${AUDIO_BASE_DIR}/${uuid}.filenmeta`
			const expiredTime = Date.now() - 86400 * 1000 - 1
			const staleMeta: Metadata = {
				artist: "Old",
				title: "Old",
				album: null,
				date: null,
				duration: 1,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: expiredTime
			}
			const freshMeta: Metadata = {
				artist: "New",
				title: "New",
				album: null,
				date: null,
				duration: 1,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: Date.now()
			}
			const freshBytes = new Uint8Array(new TextEncoder().encode(serialize(freshMeta)))

			fs.set(metaPath, new Uint8Array(new TextEncoder().encode(serialize(staleMeta))))

			// Simulate a concurrent get() that finishes writing a fresh sidecar
			// between Pass 1's unprotected read and Pass 2's mutex-guarded re-read.
			// The first .text() on the target sidecar returns the stale bytes
			// (because we capture them before swapping), then the fs entry is
			// swapped to fresh for any subsequent read.
			let metaReads = 0
			const spy = vi.spyOn(File.prototype, "text").mockImplementation(async function (this: File): Promise<string> {
				const bytes = fs.get(this.uri)

				if (!(bytes instanceof Uint8Array)) {
					throw new Error(`File not found: ${this.uri}`)
				}

				const result = new TextDecoder().decode(bytes)

				if (this.uri === metaPath) {
					metaReads++

					if (metaReads === 1) {
						fs.set(metaPath, freshBytes)
					}
				}

				return result
			})

			try {
				await cache.gc()
			} finally {
				spy.mockRestore()
			}

			// The mutex re-check must have fired (at least two reads) and the
			// sidecar must survive — the entry was fresh by the time the
			// deletion phase committed.
			expect(metaReads).toBeGreaterThanOrEqual(2)
			expect(fs.has(metaPath)).toBe(true)
		})

		it("AU-09: bounds Pass-1 fan-out concurrency instead of reading every sidecar at once", async () => {
			const cache = await createAudioCache()
			const now = Date.now()

			// Many fresh sidecars so Pass 1 inspects all of them (none expire / evict).
			for (let i = 0; i < 30; i++) {
				const meta: Metadata = {
					artist: "A",
					title: `T${i}`,
					album: null,
					date: null,
					duration: 100,
					pictureUri: null,
					pictureBlurhash: null,
					cachedAt: now
				}

				fs.set(`${AUDIO_BASE_DIR}/bound-${i}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize(meta))))
			}

			let inFlight = 0
			let peak = 0
			const originalText = File.prototype.text
			const spy = vi.spyOn(File.prototype, "text").mockImplementation(async function (this: File): Promise<string> {
				inFlight++
				peak = Math.max(peak, inFlight)

				try {
					// Hold each sidecar read open a tick so overlapping inspections are observable.
					await new Promise<void>(resolve => setTimeout(resolve, 0))

					return await originalText.call(this)
				} finally {
					inFlight--
				}
			})

			try {
				await cache.gc()
			} finally {
				spy.mockRestore()
			}

			// The pre-fix Promise.all over every sidecar would peak at ~30 concurrent reads; the gc
			// semaphore caps it at GC_CONCURRENCY (8). peak>1 confirms the work is still concurrent.
			expect(peak).toBeGreaterThan(1)
			expect(peak).toBeLessThanOrEqual(8)
		})

		it("AU-11: a concurrent clear() waits for an in-flight gc to finish (gc holds the ClearBarrier)", async () => {
			const cache = await createAudioCache()
			const now = Date.now()
			const meta: Metadata = {
				artist: "A",
				title: "T",
				album: null,
				date: null,
				duration: 100,
				pictureUri: null,
				pictureBlurhash: null,
				cachedAt: now
			}

			fs.set(`${AUDIO_BASE_DIR}/barrier-1.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize(meta))))

			// Gate gc's Pass-1 sidecar read so gc is parked mid-pass while holding the barrier.
			let releaseRead!: () => void
			const readGate = new Promise<void>(resolve => {
				releaseRead = resolve
			})
			const originalText = File.prototype.text
			const spy = vi.spyOn(File.prototype, "text").mockImplementation(async function (this: File): Promise<string> {
				await readGate

				return originalText.call(this)
			})

			let clearDone = false
			const gcPromise = cache.gc()

			await new Promise<void>(resolve => setTimeout(resolve, 0))

			const clearPromise = cache.clear().then(() => {
				clearDone = true
			})

			await new Promise<void>(resolve => setTimeout(resolve, 0))

			// clear() must NOT have completed — gc is in-flight inside the barrier.
			expect(clearDone).toBe(false)

			releaseRead()

			await gcPromise
			await clearPromise
			spy.mockRestore()

			expect(clearDone).toBe(true)
		})
	})

	describe("clear", () => {
		it("removes every metadata file and recreates an empty parent directory", async () => {
			const cache = await createAudioCache()

			fs.set(`${AUDIO_BASE_DIR}/a.filenmeta`, new Uint8Array([1, 2]))
			fs.set(`${AUDIO_BASE_DIR}/b.filenmeta`, new Uint8Array([3, 4, 5]))

			await cache.clear()

			expect(fs.has(AUDIO_BASE_DIR)).toBe(true)
			expect(fs.get(AUDIO_BASE_DIR)).toBe("dir")
			expect(fs.has(`${AUDIO_BASE_DIR}/a.filenmeta`)).toBe(false)
			expect(fs.has(`${AUDIO_BASE_DIR}/b.filenmeta`)).toBe(false)
		})

		it("is idempotent — calling twice does not throw", async () => {
			const cache = await createAudioCache()

			await cache.clear()
			await expect(cache.clear()).resolves.toBeUndefined()
			expect(fs.has(AUDIO_BASE_DIR)).toBe(true)
		})
	})

	describe("size", () => {
		it("returns 0 when the parent directory is empty", async () => {
			const cache = await createAudioCache()

			expect(cache.size()).toBe(0)
		})

		it("sums sidecar metadata file sizes", async () => {
			const cache = await createAudioCache()

			fs.set(`${AUDIO_BASE_DIR}/a.filenmeta`, new Uint8Array(new Array(5).fill(0)))
			fs.set(`${AUDIO_BASE_DIR}/b.filenmeta`, new Uint8Array(new Array(11).fill(0)))

			expect(cache.size()).toBe(5 + 11)
		})

		it("ignores stray subdirectories", async () => {
			const cache = await createAudioCache()

			fs.set(`${AUDIO_BASE_DIR}/some-dir`, "dir")
			fs.set(`${AUDIO_BASE_DIR}/some-dir/nested`, new Uint8Array([1, 2, 3]))
			fs.set(`${AUDIO_BASE_DIR}/a.filenmeta`, new Uint8Array([4]))

			expect(cache.size()).toBe(1)
		})

		it("includes picture jpg files in total size", async () => {
			const cache = await createAudioCache()

			// size() sums ALL files under PARENT_DIRECTORY, not only .filenmeta files
			fs.set(`${AUDIO_BASE_DIR}/uuid-pic.filenmeta`, new Uint8Array(new Array(8).fill(0)))
			fs.set(`${AUDIO_BASE_DIR}/uuid-pic.jpg`, new Uint8Array(new Array(200).fill(0)))

			expect(cache.size()).toBe(8 + 200)
		})
	})
})
