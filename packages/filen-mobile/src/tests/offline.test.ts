import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		download: vi.fn().mockResolvedValue({
			files: [],
			directories: []
		})
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				listDir: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
				listSharedDir: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
				listInSharedRoot: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
				listOutShared: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
				listDirRecursiveWithPaths: vi.fn().mockResolvedValue({ files: [], dirs: [] })
			}
		})
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: new Map()
	}
}))

// fsUtils (imported by offline.ts) now pulls VERSION from sibling lib modules.
// Mock them with just the VERSION export so their full transitive deps
// (expo-image via thumbnails, etc.) don't load in this test.
vi.mock("@/lib/fileCache", () => ({ VERSION: 1 }))
vi.mock("@/features/audio/audioCache", () => ({ VERSION: 1 }))
vi.mock("@/lib/thumbnails", () => ({ VERSION: 2 }))

// "Wi-Fi only" offline-sync gate dependencies. Default get → null = setting off, so sync()'s
// gate is skipped and the existing sync() tests are unaffected. NetInfo is only reached when the
// setting is on; mock it anyway so an accidental fetch never hits native.
vi.mock("@/lib/secureStore", () => ({ default: { get: vi.fn().mockResolvedValue(null) } }))
vi.mock("@react-native-community/netinfo", () => ({ default: { fetch: vi.fn().mockResolvedValue({ type: "wifi" }) } }))

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: vi.fn()
	}
}))

vi.mock("@/features/offline/store/useOffline.store", () => ({
	default: {
		getState: vi.fn().mockReturnValue({
			setSyncing: vi.fn()
		})
	}
}))

vi.mock("@/features/drive/queries/useDriveItemStoredOffline.query", () => ({
	driveItemStoredOfflineQueryUpdate: vi.fn(),
	getStoredOfflineQueryCacheEntries: vi.fn(() => [])
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: vi.fn()
}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (p: string) =>
		p
			.trim()
			.replace(/^file:\/+/, "/")
			.replace(/\/+/g, "/")
			.replace(/\/$/, "")
}))

vi.mock("@/lib/utils", () => ({
	normalizeModificationTimestampForComparison: (timestamp: number) => Math.floor(timestamp / 1000)
}))

// Minimal stubs for @/lib/sdkUnwrap. These only handle the concrete shapes
// that offline.ts exercises at test time (SDK objects with tag:"Decoded" from
// mocked listDir/listSharedDir results). They do NOT re-implement the real
// tag-switching logic — see finding #166. Each stub reads exactly the fields
// that offline.ts reads from the return value, nothing more.
vi.mock("@/lib/sdkUnwrap", () => ({
	// offline.ts reads: result.meta (null check), result.meta.name, result.meta.modified,
	// result.file.uuid. Shape: { file, meta: DecryptedFileMeta | null, undecryptable }.
	unwrapFileMeta: vi.fn((file: unknown) => {
		const f = file as any
		const decoded = f?.meta?.tag === "Decoded" ? (f.meta.inner?.[0] ?? null) : null

		return {
			file: f,
			meta: decoded ?? null,
			undecryptable: decoded === null,
			shared: false,
			root: false
		}
	}),
	// offline.ts reads: result (uuid string | null).
	// Normal.Dir path: dir.inner[0].inner[0].uuid
	unwrapAnyDirUuid: vi.fn((dir: any) => {
		if (!dir || typeof dir !== "object") {
			return null
		}

		// Normal Dir / Root: inner[0] is AnyNormalDir, inner[0].inner[0] is the Dir/Root object
		return dir.inner?.[0]?.inner?.[0]?.uuid ?? null
	}),
	// offline.ts reads: result.meta (null check), result.meta.name, result.uuid.
	// Shape: { dir, uuid, meta: DecryptedDirMeta | null, undecryptable }.
	unwrapDirMeta: vi.fn((dir: unknown) => {
		const d = dir as any
		const decoded = d?.meta?.tag === "Decoded" ? (d.meta.inner?.[0] ?? null) : null

		return {
			dir: d,
			uuid: d?.uuid ?? "unknown",
			meta: decoded ?? null,
			undecryptable: decoded === null,
			shared: false
		}
	}),
	// offline.ts reads: result.type, result.data.uuid, result.data.decryptedMeta.
	// Mirrors the real unwrappedFileIntoDriveItem return shape (type:"file").
	unwrappedFileIntoDriveItem: vi.fn(
		(unwrapped: { file: { uuid?: string }; meta: { name: string; size?: bigint; modified?: number; created?: number } | null }) => ({
			type: "file" as const,
			data: {
				uuid: unwrapped.file?.uuid ?? "file-uuid",
				decryptedMeta: unwrapped.meta
					? {
							name: unwrapped.meta.name,
							size: unwrapped.meta.size ?? 100n,
							modified: unwrapped.meta.modified ?? 1000,
							created: unwrapped.meta.created ?? 900
						}
					: null,
				undecryptable: unwrapped.meta === null
			}
		})
	),
	// offline.ts reads: result.type, result.data.uuid, result.data.decryptedMeta.
	// Mirrors the real unwrappedDirIntoDriveItem return shape (type:"directory").
	unwrappedDirIntoDriveItem: vi.fn((unwrapped: { dir: { uuid?: string }; uuid: string; meta: { name: string } | null }) => ({
		type: "directory" as const,
		data: {
			uuid: unwrapped.uuid ?? unwrapped.dir?.uuid ?? "dir-uuid",
			decryptedMeta: unwrapped.meta ? { name: unwrapped.meta.name, size: 0n, modified: 1000, created: 900 } : null,
			undecryptable: unwrapped.meta === null
		}
	})),
	unwrapParentUuid: vi.fn(() => null)
}))

vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: vi.fn(() => null)
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyDirWithContext: {
		Normal: class {
			tag = "Normal"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Shared: class {
			tag = "Shared"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnyNormalDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnyDirWithContext_Tags: {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	},
	AnySharedDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnyNormalDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnyLinkedDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnySharedDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnySharedDirWithContext: {
		new: (opts: unknown) => opts
	},
	SharingRole_Tags: {
		Sharer: "Sharer",
		Receiver: "Receiver"
	},
	NonRootDir_Tags: {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	},
	ErrorKind: {
		FolderNotFound: "FolderNotFound"
	}
}))

vi.mock("@/lib/uuid", () => ({
	validateUuid: (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}))

import { type Index, type FileOrDirectoryOfflineMeta, type DirectoryOfflineMeta } from "@/features/offline/offline"
import { serialize, deserialize } from "@/lib/serializer"
import { fs, File } from "@/tests/mocks/expoFileSystem"
import type { DriveItem } from "@/types"
import { AnyDirWithContext, AnyNormalDir, SharingRole_Tags, NonRootDir_Tags, type Dir } from "@filen/sdk-rs"
import transfers from "@/features/transfers/transfers"
import {
	driveItemStoredOfflineQueryUpdate,
	getStoredOfflineQueryCacheEntries
} from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import auth from "@/lib/auth"
import cache from "@/lib/cache"

type OfflineInstance = any

import { VERSION as OFFLINE_VERSION } from "@/features/offline/offline"
import {
	findStaleStoredOfflineEntries,
	shouldSkipOfflineSyncForConnection,
	type StoredOfflineQueryCacheEntry
} from "@/features/offline/offlineHelpers"

const BASE_DIR_URI = `file:///shared/group.io.filen.app/offline/v${OFFLINE_VERSION}`
const FILES_DIR_URI = `${BASE_DIR_URI}/files`
const DIRECTORIES_DIR_URI = `${BASE_DIR_URI}/directories`
const INDEX_FILE_URI = `${BASE_DIR_URI}/index`

function makeFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

function makeDirItem(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 0n,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

function makeFileItemWithSize(uuid: string, name: string, size: bigint): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

function makeParent(uuid: string): InstanceType<typeof AnyDirWithContext.Normal> {
	return new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid } as unknown as Dir))
}

// Builds a v2 entries map (uuid-keyed, raw root-relative `path` values with a leading "/")
// from a readable path → item literal. Keys in the input are the RAW listing paths.
function makeEntries(byPath: Record<string, DriveItem>): DirectoryOfflineMeta["entries"] {
	const entries: DirectoryOfflineMeta["entries"] = {}

	for (const path in byPath) {
		const item = byPath[path]

		if (!item) {
			continue
		}

		entries[item.data.uuid] = {
			item,
			path
		}
	}

	return entries
}

// Shapes a remote file entry the way listDirRecursiveWithPaths returns it (path WITHOUT a
// leading slash — root-relative). The mocked unwrapFileMeta/unwrappedFileIntoDriveItem read
// exactly these fields.
function makeListingFile(uuid: string, path: string, name: string, size: bigint) {
	return {
		file: {
			uuid,
			meta: {
				tag: "Decoded",
				inner: [{ name, size, modified: 1000, created: 900 }]
			}
		},
		path
	}
}

function makeListingDir(uuid: string, path: string, name: string) {
	return {
		dir: {
			tag: NonRootDir_Tags.Normal,
			inner: [
				{
					uuid,
					meta: {
						tag: "Decoded",
						inner: [{ name }]
					}
				}
			]
		},
		path
	}
}

// Queues a one-shot SDK client whose recursive listing returns the given dirs/files.
function mockListing({ files = [], dirs = [] }: { files?: unknown[]; dirs?: unknown[] }): void {
	vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
		authedSdkClient: {
			listDirRecursiveWithPaths: vi.fn().mockResolvedValue({ files, dirs })
		}
	} as any)
}

// Queues a one-shot SDK client whose recursive listing fires a scan error before returning the
// given dirs/files — a DEGRADED listing (entries can be silently absent from it).
function mockDegradedListing({ files = [], dirs = [] }: { files?: unknown[]; dirs?: unknown[] }): void {
	vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
		authedSdkClient: {
			listDirRecursiveWithPaths: vi
				.fn()
				.mockImplementation(async (_dir: unknown, _progress: unknown, errorCb: { onErrors: (e: unknown[]) => void }) => {
					errorCb.onErrors([new Error("could not decrypt nested meta")])

					return { files, dirs }
				})
		}
	} as any)
}

// A listed file whose meta cannot be decoded (the unwrapFileMeta stub yields meta: null) — the
// reconcile must drop it from the remote map AND degrade the pass.
function makeListingFileUndecodable(uuid: string, path: string) {
	return {
		file: {
			uuid,
			meta: {
				tag: "Undecodable"
			}
		},
		path
	}
}

function writeIndex(index: Index): void {
	fs.set(INDEX_FILE_URI, new Uint8Array(new TextEncoder().encode(serialize(index))))
}

function readIndex(): Index {
	const bytes = fs.get(INDEX_FILE_URI) as Uint8Array

	return deserialize(new TextDecoder().decode(bytes)) as Index
}

function writeFileMeta(uuid: string, meta: FileOrDirectoryOfflineMeta): void {
	const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
	const dirUri = `${FILES_DIR_URI}/${uuid}`

	fs.set(dirUri, "dir")
	fs.set(metaUri, new Uint8Array(new TextEncoder().encode(serialize(meta))))
}

function writeFileData(uuid: string, name: string, data: Uint8Array = new Uint8Array([1, 2, 3])): void {
	const fileUri = `${FILES_DIR_URI}/${uuid}/${name}`
	const dirUri = `${FILES_DIR_URI}/${uuid}`

	fs.set(dirUri, "dir")
	fs.set(fileUri, data)
}

function writeDirectoryMeta(uuid: string, meta: DirectoryOfflineMeta): void {
	const metaUri = `${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`
	const dirUri = `${DIRECTORIES_DIR_URI}/${uuid}`

	fs.set(dirUri, "dir")
	fs.set(metaUri, new Uint8Array(new TextEncoder().encode(serialize(meta))))
}

function readDirectoryMetaFromDisk(uuid: string): DirectoryOfflineMeta | null {
	const raw = fs.get(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`)

	if (!(raw instanceof Uint8Array)) {
		return null
	}

	return deserialize(new TextDecoder().decode(raw)) as DirectoryOfflineMeta
}

async function createOffline(): Promise<OfflineInstance> {
	const mod = await import("@/features/offline/offline")

	return new (mod.Offline as new () => OfflineInstance)()
}

describe("Offline", () => {
	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
	})

	describe("constructor", () => {
		it("creates the directory structure on construction", async () => {
			await createOffline()

			expect(fs.get(BASE_DIR_URI)).toBe("dir")
			expect(fs.get(FILES_DIR_URI)).toBe("dir")
			expect(fs.get(DIRECTORIES_DIR_URI)).toBe("dir")
		})

		it("does not throw if directories already exist", async () => {
			fs.set(BASE_DIR_URI, "dir")
			fs.set(FILES_DIR_URI, "dir")
			fs.set(DIRECTORIES_DIR_URI, "dir")

			await expect(createOffline()).resolves.toBeDefined()
		})
	})

	describe("atomicWrite", () => {
		it("writes index file atomically (no .tmp files left)", async () => {
			const offline = await createOffline()
			const fileItem = makeFileItem("11111111-1111-1111-1111-111111111111", "photo.jpg")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData("11111111-1111-1111-1111-111111111111", "photo.jpg")
			writeFileMeta("11111111-1111-1111-1111-111111111111", {
				item: fileItem,
				parent
			})

			await offline.updateIndex()

			// Index file should exist
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)

			// No .tmp files should be left
			const tmpFiles: string[] = []

			for (const key of fs.keys()) {
				if (key.endsWith(".tmp")) {
					tmpFiles.push(key)
				}
			}

			expect(tmpFiles).toHaveLength(0)
		})
	})

	describe("readIndex", () => {
		it("returns empty index when no index file exists", async () => {
			const offline = await createOffline()
			const stored = await offline.isItemStored(makeFileItem("11111111-1111-1111-1111-111111111111", "test.txt"))

			expect(stored).toBe(false)
		})

		it("reads a valid index from disk", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "test.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: {
					[uuid]: { item: fileItem, parent }
				},
				directories: {}
			})

			const offline = await createOffline()
			const stored = await offline.isItemStored(fileItem)

			expect(stored).toBe(true)
		})

		it("recovers from corrupted index file", async () => {
			// Write garbage data to the index file
			fs.set(BASE_DIR_URI, "dir")
			fs.set(FILES_DIR_URI, "dir")
			fs.set(DIRECTORIES_DIR_URI, "dir")
			fs.set(INDEX_FILE_URI, new Uint8Array([0xff, 0xfe, 0x00, 0x01]))

			const offline = await createOffline()

			// Should not throw — should recover gracefully
			const stored = await offline.isItemStored(makeFileItem("11111111-1111-1111-1111-111111111111", "test.txt"))

			expect(stored).toBe(false)

			// Corrupt file should be deleted
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})
	})

	describe("isItemStored", () => {
		it("returns true for a stored file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "doc.pdf")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()

			expect(await offline.isItemStored(fileItem)).toBe(true)
		})

		it("returns true for a stored directory", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Photos")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: {},
				directories: { [uuid]: { item: dirItem, parent } }
			})

			const offline = await createOffline()

			expect(await offline.isItemStored(dirItem)).toBe(true)
		})

		it("returns false for an item not in the index", async () => {
			writeIndex({ files: {}, directories: {} })

			const offline = await createOffline()
			const stored = await offline.isItemStored(makeFileItem("99999999-9999-9999-9999-999999999999", "missing.txt"))

			expect(stored).toBe(false)
		})

		it("caches results (second call does not re-read index)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "cached.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()

			expect(await offline.isItemStored(fileItem)).toBe(true)

			// Delete index from disk — cached result should still work
			fs.delete(INDEX_FILE_URI)

			expect(await offline.isItemStored(fileItem)).toBe(true)
		})
	})

	describe("listFiles", () => {
		it("returns empty array when no offline files exist", async () => {
			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toEqual([])
		})

		it("lists stored files from filesystem", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "report.pdf")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "report.pdf")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toHaveLength(1)
			expect(files[0].item.data.uuid).toBe(uuid)
		})

		it("skips directories without valid UUID names", async () => {
			fs.set(`${FILES_DIR_URI}/not-a-uuid`, "dir")
			fs.set(`${FILES_DIR_URI}/not-a-uuid/test.txt`, new Uint8Array([1]))

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toEqual([])
		})

		it("lists entries whose data file is missing (meta intact) — the sync pass heals the bytes", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "gone.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Only write meta, not the data file. The listing is meta-keyed: the entry must still
			// appear so the sync decision flow sees it (remote-alive → redownload heal, remote-gone
			// → removal) instead of the dir being invisible forever.
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toHaveLength(1)
			expect(files[0].item.data.uuid).toBe(uuid)
		})

		it("caches results on second call", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "cached-file.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "cached-file.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			const first = await offline.listFiles()
			const second = await offline.listFiles()

			expect(first).toBe(second) // Same reference
		})
	})

	describe("updateIndex", () => {
		it("builds index from filesystem and writes it to disk", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "indexed.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "indexed.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			const index = readIndex()

			expect(index.files[uuid]).toBeDefined()
			expect(index.files[uuid]!.item.data.uuid).toBe(uuid)
		})

		it("invalidates all caches when updating index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "will-cache.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "will-cache.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			// Populate list cache
			const firstList = await offline.listFiles()

			expect(firstList).toHaveLength(1)

			// Remove the file from disk
			const fileDir = `${FILES_DIR_URI}/${uuid}`

			for (const key of [...fs.keys()]) {
				if (key.startsWith(fileDir)) {
					fs.delete(key)
				}
			}

			// Update index — should clear caches
			await offline.updateIndex()

			const secondList = await offline.listFiles()

			expect(secondList).toHaveLength(0)
		})
	})

	describe("removeItem", () => {
		it("removes a stored file and updates the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "delete-me.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "delete-me.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(fileItem)).toBe(true)

			await offline.removeItem(fileItem)

			// File directory should be deleted
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("removes a stored directory and updates the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Vacation")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const dirMeta: DirectoryOfflineMeta = {
				item: dirItem,
				parent,
				entries: {}
			}

			writeDirectoryMeta(uuid, dirMeta)

			const offline = await createOffline()

			await offline.updateIndex()

			await offline.removeItem(dirItem)

			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("does not throw when removing an item that does not exist", async () => {
			const offline = await createOffline()
			const missingItem = makeFileItem("99999999-9999-9999-9999-999999999999", "ghost.txt")

			await expect(offline.removeItem(missingItem)).resolves.not.toThrow()
		})

		it("calls updateIndex only once even for multiple matching directories", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Photos")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			// Count how many times the index file is written during removeItem
			let writeCount = 0
			const originalSet = fs.set.bind(fs)

			fs.set = (...args: Parameters<typeof originalSet>) => {
				if (typeof args[0] === "string" && args[0] === INDEX_FILE_URI) {
					writeCount++
				}

				return originalSet(...args)
			}

			await offline.removeItem(dirItem)

			// Should be exactly 1 updateIndex call — atomicWrite writes to INDEX_FILE_URI exactly once
			// (via tmp.move → copy to final destination), not N times from inside Promise.all
			expect(writeCount).toBe(1)

			fs.set = originalSet
		})
	})

	describe("listDirectories", () => {
		it("returns empty result when no offline directories exist", async () => {
			const offline = await createOffline()
			const result = await offline.listDirectories()

			expect(result.files).toEqual([])
			expect(result.directories).toEqual([])
		})

		it("lists top-level directories", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Documents")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()
			const result = await offline.listDirectories()

			expect(result.directories).toHaveLength(1)
			expect(result.directories[0].item.data.uuid).toBe(uuid)
		})

		it("caches results for the same parent", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "CachedDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			const first = await offline.listDirectories()
			const second = await offline.listDirectories()

			expect(first).toBe(second)
		})
	})

	describe("listDirectoriesRecursive", () => {
		it("returns all directories and files from all stored directory metas", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(dirUuid, "Project")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const subDirItem = makeDirItem("33333333-3333-3333-3333-333333333333", "SubDir")
			const subFileItem = makeFileItem("44444444-4444-4444-4444-444444444444", "readme.md")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/SubDir": subDirItem,
					"/SubDir/readme.md": subFileItem
				})
			})

			const offline = await createOffline()
			const result = await offline.listDirectoriesRecursive()

			// Top-level directory + SubDir
			expect(result.directories.length).toBeGreaterThanOrEqual(2)

			// readme.md
			expect(result.files.length).toBeGreaterThanOrEqual(1)
		})

		it("caches results on second call", async () => {
			const offline = await createOffline()

			const first = await offline.listDirectoriesRecursive()
			const second = await offline.listDirectoriesRecursive()

			expect(first).toBe(second)
		})
	})

	describe("itemSize", () => {
		it("returns size for a stored file from the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "big.zip")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()
			const size = await offline.itemSize(fileItem)

			expect(size.size).toBe(100)
			expect(size.files).toBe(1)
			expect(size.dirs).toBe(0)
		})

		// Ref #167: a zero-byte file (size 0n) must count as one file while reporting size 0.
		// Number(0n) === 0, which is falsy, but the aggregation is a sum — not a truthiness
		// check — so the result is {size: 0, files: 1, dirs: 0}.
		it("returns size 0 with files count 1 for a stored zero-byte file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItemWithSize(uuid, "empty.bin", 0n)
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()
			const size = await offline.itemSize(fileItem)

			// size is 0 (Number(0n) === 0) but the file IS counted
			expect(size.size).toBe(0)
			expect(size.files).toBe(1)
			expect(size.dirs).toBe(0)
		})

		it("returns zero for a file not in the index", async () => {
			writeIndex({ files: {}, directories: {} })

			const offline = await createOffline()
			const size = await offline.itemSize(makeFileItem("99999999-9999-9999-9999-999999999999", "missing.txt"))

			expect(size).toEqual({ size: 0, files: 0, dirs: 0 })
		})

		it("returns aggregated size for a stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(dirUuid, "Archive")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const file1 = makeFileItem("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "a.txt")

			;(file1 as { data: { decryptedMeta: { size: bigint } } }).data.decryptedMeta.size = 500n

			const file2 = makeFileItem("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "b.txt")

			;(file2 as { data: { decryptedMeta: { size: bigint } } }).data.decryptedMeta.size = 300n

			const subDir = makeDirItem("cccccccc-cccc-cccc-cccc-cccccccccccc", "SubDir")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/a.txt": file1,
					"/SubDir": subDir,
					"/SubDir/b.txt": file2
				})
			})

			const offline = await createOffline()
			const size = await offline.itemSize(dirItem)

			expect(size.size).toBe(800)
			expect(size.files).toBe(2)
			expect(size.dirs).toBe(1)
		})

		it("returns zero for a directory not stored", async () => {
			const offline = await createOffline()
			const size = await offline.itemSize(makeDirItem("99999999-9999-9999-9999-999999999999", "missing"))

			expect(size).toEqual({ size: 0, files: 0, dirs: 0 })
		})

		it("caches size results", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "cached-size.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()

			const first = await offline.itemSize(fileItem)

			// Modify index on disk — cached result should still be the same
			fs.delete(INDEX_FILE_URI)

			const second = await offline.itemSize(fileItem)

			expect(first).toBe(second) // Same reference
		})
	})

	describe("getLocalFile", () => {
		it("returns the local file for a stored file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "local.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			writeFileData(uuid, "local.txt")

			const offline = await createOffline()
			const file = await offline.getLocalFile(fileItem)

			expect(file).not.toBeNull()
			expect(file?.uri).toContain(uuid)
		})

		it("returns null for a file not stored offline", async () => {
			writeIndex({ files: {}, directories: {} })

			const offline = await createOffline()
			const file = await offline.getLocalFile(makeFileItem("99999999-9999-9999-9999-999999999999", "missing.txt"))

			expect(file).toBeNull()
		})

		it("returns null for a directory item", async () => {
			const offline = await createOffline()
			const file = await offline.getLocalFile(makeDirItem("11111111-1111-1111-1111-111111111111", "not-a-file"))

			expect(file).toBeNull()
		})

		it("finds a file inside a stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "Project")
			const fileItem = makeFileItem(fileUuid, "readme.md")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			writeIndex({
				files: { [fileUuid]: { item: fileItem, parent } },
				directories: { [dirUuid]: { item: dirItem, parent } }
			})

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/readme.md": fileItem
				})
			})

			// Write the actual file inside the directory structure
			const filePath = `${DIRECTORIES_DIR_URI}/${dirUuid}/readme.md`

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}`, "dir")
			fs.set(filePath, new Uint8Array([1, 2, 3]))

			const offline = await createOffline()
			const file = await offline.getLocalFile(fileItem)

			expect(file).not.toBeNull()
			expect(file?.uri).toContain(dirUuid)
		})

		it("caches the result on subsequent calls", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "cached.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			writeFileData(uuid, "cached.txt")

			const offline = await createOffline()

			const first = await offline.getLocalFile(fileItem)
			const second = await offline.getLocalFile(fileItem)

			expect(first).toBe(second)
		})
	})

	describe("getLocalDirectory", () => {
		it("returns the local directory for a stored top-level directory", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Offline")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			// Ensure the directory exists on disk
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")

			// Need to build index for listDirectories to work
			writeIndex({
				files: {},
				directories: { [uuid]: { item: dirItem, parent } }
			})

			const offline = await createOffline()
			const dir = await offline.getLocalDirectory(dirItem)

			expect(dir).not.toBeNull()
			expect(dir?.uri).toContain(uuid)
		})

		it("returns null for a file item", async () => {
			const offline = await createOffline()
			const dir = await offline.getLocalDirectory(makeFileItem("11111111-1111-1111-1111-111111111111", "file.txt"))

			expect(dir).toBeNull()
		})

		it("returns null for a directory not stored offline", async () => {
			const offline = await createOffline()
			const dir = await offline.getLocalDirectory(makeDirItem("99999999-9999-9999-9999-999999999999", "missing"))

			expect(dir).toBeNull()
		})

		it("caches the result", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "CachedDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")

			writeIndex({
				files: {},
				directories: { [uuid]: { item: dirItem, parent } }
			})

			const offline = await createOffline()

			const first = await offline.getLocalDirectory(dirItem)
			const second = await offline.getLocalDirectory(dirItem)

			expect(first).toBe(second)
		})
	})

	describe("ensureDirectories optimization", () => {
		it("only checks filesystem once after construction", async () => {
			const offline = await createOffline()

			// Delete directories from disk
			fs.delete(BASE_DIR_URI)
			fs.delete(FILES_DIR_URI)
			fs.delete(DIRECTORIES_DIR_URI)

			// Calling isItemStored should use cached flag and not recreate dirs
			writeIndex({ files: {}, directories: {} })

			const stored = await offline.isItemStored(makeFileItem("11111111-1111-1111-1111-111111111111", "test.txt"))

			expect(stored).toBe(false)

			// Directories should NOT be recreated (flag says they're ensured)
			expect(fs.has(BASE_DIR_URI)).toBe(false)
		})

		it("re-checks after invalidateCaches (via updateIndex)", async () => {
			const offline = await createOffline()

			// Delete directories
			fs.delete(BASE_DIR_URI)
			fs.delete(FILES_DIR_URI)
			fs.delete(DIRECTORIES_DIR_URI)

			// updateIndex calls invalidateCaches which resets the flag
			await offline.updateIndex()

			// Directories should be recreated
			expect(fs.get(BASE_DIR_URI)).toBe("dir")
			expect(fs.get(FILES_DIR_URI)).toBe("dir")
			expect(fs.get(DIRECTORIES_DIR_URI)).toBe("dir")
		})
	})

	describe("readDirectoryMeta", () => {
		it("caches directory meta across multiple method calls", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Shared")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/file.txt": makeFileItem("33333333-3333-3333-3333-333333333333", "file.txt")
				})
			})

			const offline = await createOffline()

			// First call populates cache
			const result1 = await offline.listDirectories()

			// Corrupt the meta file on disk — cached value should still be used
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`, new Uint8Array([0xff]))

			const result2 = await offline.listDirectories()

			expect(result1.directories).toHaveLength(1)
			expect(result2.directories).toHaveLength(1)
		})
	})

	describe("buildUuidToTopLevelIndex", () => {
		it("maps nested entry UUIDs to their top-level directory", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const nestedFileUuid = "22222222-2222-2222-2222-222222222222"
			const nestedDirUuid = "33333333-3333-3333-3333-333333333333"
			const topDirItem = makeDirItem(topUuid, "Root")
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: makeEntries({
					"/sub": makeDirItem(nestedDirUuid, "sub"),
					"/sub/file.txt": makeFileItem(nestedFileUuid, "file.txt")
				})
			})

			const offline = await createOffline()

			// getLocalFile internally uses buildUuidToTopLevelIndex
			// If the nested file UUID resolves to the correct top-level, it works
			const fileItem = makeFileItem(nestedFileUuid, "file.txt")

			writeIndex({
				files: { [nestedFileUuid]: { item: fileItem, parent } },
				directories: { [topUuid]: { item: topDirItem, parent } }
			})

			// Write the actual nested file
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}/sub`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}/sub/file.txt`, new Uint8Array([1]))

			const file = await offline.getLocalFile(fileItem)

			expect(file).not.toBeNull()
			expect(file?.uri).toContain(topUuid)
		})
	})

	describe("storeFile", () => {
		it("downloads the file, writes meta, and updates the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "download.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Mock download to write data to the destination file
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([10, 20, 30]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent })).resolves.toBe(true)

			// Data file should exist
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/download.txt`)).toBeInstanceOf(Uint8Array)

			// Meta file should exist
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)

			// Index should contain the file
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)
			const index = deserialize(new TextDecoder().decode(fs.get(INDEX_FILE_URI) as Uint8Array)) as Index

			expect(index.files[uuid]).toBeDefined()
		})

		it("passes background: false to transfers.download when background is omitted", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "bg-false.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([1]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await offline.storeFile({ file: fileItem, parent })

			expect(transfers.download).toHaveBeenCalledWith(expect.objectContaining({ background: false }))
		})

		it("passes background: true to transfers.download when background is true", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "bg-true.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([1]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await offline.storeFile({ file: fileItem, parent, background: true })

			expect(transfers.download).toHaveBeenCalledWith(expect.objectContaining({ background: true }))
		})

		it("throws if item is not a file type", async () => {
			const offline = await createOffline()
			const dirItem = makeDirItem("11111111-1111-1111-1111-111111111111", "not-a-file")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			await expect(offline.storeFile({ file: dirItem, parent })).rejects.toThrow("Item not of type file")
		})

		it("throws if decryptedMeta is missing", async () => {
			const offline = await createOffline()
			const fileItem = {
				type: "file",
				data: {
					uuid: "11111111-1111-1111-1111-111111111111",
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			await expect(offline.storeFile({ file: fileItem, parent })).rejects.toThrow("File missing decrypted meta")
		})

		it("skips download if file is already stored", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "already.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Pre-populate index so isItemStored returns true
			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()

			// Already stored counts as stored — the guard short-circuits with true.
			await expect(offline.storeFile({ file: fileItem, parent })).resolves.toBe(true)

			// Download should not have been called
			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("cleans up on download failure", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "fail.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Network error"))

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent })).rejects.toThrow("Network error")

			// Parent directory should be cleaned up
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("respects skipIndexUpdate option", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "no-index.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([1]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent, skipIndexUpdate: true })).resolves.toBe(true)

			// Meta file should exist (store completed)
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)

			// Index should NOT have been written
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})

		it("resolves false on an aborted download (null result) — no meta, no index, no residue dir", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "aborted.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// transfers.download resolves null on abort (pause/cancel) without throwing.
			vi.mocked(transfers.download).mockResolvedValueOnce(null as any)

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent })).resolves.toBe(false)

			// Nothing committed: no meta, no index — and no empty meta-less files/{uuid}/ residue
			// (callers like the sync version adoption rely on false ⟹ old copy must be kept).
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})

		// Regression (ref #35): two concurrent storeFile calls for the same UUID must not race.
		// Without per-UUID serialization, both pass the cold-cache isItemStored guard, both reach the
		// destructive `dataFile.parentDirectory.delete()`, and call B wipes call A's in-flight download
		// target mid-transfer. The per-UUID lock serializes them: the download runs exactly once and the
		// second call short-circuits (already stored) instead of deleting the first's directory.
		it("serializes two concurrent storeFile calls for the same UUID (no in-flight wipe)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "race.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const dataDirUri = `${FILES_DIR_URI}/${uuid}`

			let releaseFirstDownload!: () => void
			const firstDownloadGate = new Promise<void>(resolve => {
				releaseFirstDownload = resolve
			})

			let downloadStarted!: () => void
			const firstDownloadStarted = new Promise<void>(resolve => {
				downloadStarted = resolve
			})

			vi.mocked(transfers.download).mockImplementation(async ({ destination }) => {
				// First (and, with the fix, only) download blocks until released so we can probe
				// the in-flight directory state from a second concurrent call.
				downloadStarted()

				await firstDownloadGate

				if (destination instanceof File) {
					destination.write(new Uint8Array([1, 2, 3]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			const first = offline.storeFile({ file: fileItem, parent })

			// Wait until the first download is in flight (lock + directory created, transfer awaiting gate).
			await firstDownloadStarted

			// Start the second concurrent call for the same UUID. It must block on the per-UUID lock
			// rather than entering the body and deleting the first call's in-flight directory.
			const second = offline.storeFile({ file: fileItem, parent })

			// Give the second call a chance to (wrongly) run its destructive delete if unserialized.
			await Promise.resolve()
			await Promise.resolve()

			// The first call's in-flight directory must still be present (not wiped by the second call).
			expect(fs.get(dataDirUri)).toBe("dir")

			// Release the first download and let both settle. Both report stored: the first did the
			// work, the second short-circuited on the already-stored guard.
			releaseFirstDownload()

			await expect(Promise.all([first, second])).resolves.toEqual([true, true])

			// Download ran exactly once — the second call saw the item stored and skipped.
			expect(transfers.download).toHaveBeenCalledTimes(1)

			// Final state is intact: data + meta written once.
			expect(fs.get(`${dataDirUri}/race.txt`)).toBeInstanceOf(Uint8Array)
			expect(fs.get(`${dataDirUri}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)
		})
	})

	describe("storeDirectory", () => {
		it("downloads the directory, builds uuid-keyed entries from the listing, writes meta, and updates the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const readmeUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const mainUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
			const srcUuid = "cccccccc-cccc-cccc-cccc-cccccccccccc"
			const dirItem = makeDirItem(uuid, "Project")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const dataDirectoryUri = `${DIRECTORIES_DIR_URI}/${uuid}`

			// Entries come from the remote LISTING (raw root-relative paths, no leading slash from the SDK).
			mockListing({
				files: [makeListingFile(readmeUuid, "readme.md", "readme.md", 2n), makeListingFile(mainUuid, "src/main.ts", "main.ts", 2n)],
				dirs: [makeListingDir(srcUuid, "src", "src")]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				// Simulate the in-place download writing the missing entries into the live dir.
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/readme.md`, new Uint8Array([1, 2]))
				fs.set(`${destUri}/src`, "dir")
				fs.set(`${destUri}/src/main.ts`, new Uint8Array([3, 4]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent })

			// Meta file should exist
			const metaUri = `${dataDirectoryUri}/${uuid}.filenmeta`

			expect(fs.get(metaUri)).toBeInstanceOf(Uint8Array)

			// Entries are uuid-keyed with raw root-relative paths (leading "/").
			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as DirectoryOfflineMeta

			expect(Object.keys(meta.entries).sort()).toEqual([readmeUuid, mainUuid, srcUuid].sort())
			expect(meta.entries[readmeUuid]?.path).toBe("/readme.md")
			expect(meta.entries[readmeUuid]?.item.data.uuid).toBe(readmeUuid)
			expect(meta.entries[mainUuid]?.path).toBe("/src/main.ts")
			expect(meta.entries[srcUuid]?.path).toBe("/src")

			// Index should be updated
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)
		})

		// Fix: a degraded listing (permanent scan error) must not make the initial store fail
		// forever — the pass commits the union (= the listing, on a first store) and SUCCEEDS.
		it("succeeds without throwing when the initial store's listing is degraded — meta committed from the listing", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "Degraded")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const dataDirectoryUri = `${DIRECTORIES_DIR_URI}/${uuid}`

			mockDegradedListing({
				files: [makeListingFile(fileUuid, "a.txt", "a.txt", 2n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/a.txt`, new Uint8Array([1, 2]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const offline = await createOffline()

			// Resolves (no throw) and RETURNS the degraded markers so the caller can surface them.
			const storeErrors = await offline.storeDirectory({ directory: dirItem, parent })

			expect(storeErrors).toHaveLength(1)
			expect(storeErrors[0]?.degraded).toBe(true)

			const metaUri = `${dataDirectoryUri}/${uuid}.filenmeta`

			expect(fs.get(metaUri)).toBeInstanceOf(Uint8Array)

			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as DirectoryOfflineMeta

			expect(meta.entries[fileUuid]?.path).toBe("/a.txt")
			expect(fs.has(`${dataDirectoryUri}/a.txt`)).toBe(true)
		})

		it("throws if item is not a directory type", async () => {
			const offline = await createOffline()
			const fileItem = makeFileItem("11111111-1111-1111-1111-111111111111", "not-a-dir.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			await expect(offline.storeDirectory({ directory: fileItem, parent })).rejects.toThrow("Item not of type directory")
		})

		it("throws if decryptedMeta is missing", async () => {
			const offline = await createOffline()
			const dirItem = {
				type: "directory",
				data: {
					uuid: "11111111-1111-1111-1111-111111111111",
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			await expect(offline.storeDirectory({ directory: dirItem, parent })).rejects.toThrow("Directory missing decrypted meta")
		})

		it("skips download if directory is already stored", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Already")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: {},
				directories: { [uuid]: { item: dirItem, parent } }
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent })

			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("cleans up on download failure", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "FailDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// One missing remote entry so the initial store actually attempts the download.
			mockListing({
				files: [makeListingFile("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "a.txt", "a.txt", 1n)]
			})

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Disk full"))

			const offline = await createOffline()

			await expect(offline.storeDirectory({ directory: dirItem, parent })).rejects.toThrow("Disk full")

			// Data directory should be cleaned up
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("throws and cleans up when the download reports per-entry errors (initial store)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "EntryErrors")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			mockListing({
				files: [makeListingFile(fileUuid, "broken.txt", "broken.txt", 3n)]
			})

			// The directory download resolves but surfaces a per-entry failure — the offline layer
			// must treat that as the failure signal (no meta, no index, partial tree deleted).
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				return {
					files: [],
					directories: [],
					errors: [
						{
							error: { message: () => "Entry download failed", kind: () => "IO" },
							path: `${(destination as { uri: string }).uri.replace(/^file:\/+/, "/")}/broken.txt`,
							item: {}
						}
					]
				}
			})

			const offline = await createOffline()

			await expect(offline.storeDirectory({ directory: dirItem, parent })).rejects.toThrow("Entry download failed")

			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(false)
		})

		it("throws and cleans up when a downloaded entry fails verification (initial store)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "VerifyFail")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			mockListing({
				files: [makeListingFile(fileUuid, "ghost.txt", "ghost.txt", 3n)]
			})

			// Download "succeeds" without errors but never materializes the file on disk.
			vi.mocked(transfers.download).mockImplementationOnce(async (): Promise<any> => {
				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const offline = await createOffline()

			await expect(offline.storeDirectory({ directory: dirItem, parent })).rejects.toThrow("Missing on disk after sync")

			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
		})

		// Meta sizes are client-supplied and can drift from the actual remote content (e.g. a
		// crashed upload left fewer chunks than the meta claims). The SDK downloads what exists and
		// reports success — such files must COMMIT (recording the delivered size) with a degraded
		// warning instead of failing the whole tree forever.
		it("commits a size-drifted file with a recorded diskSize and a degraded warning (initial store)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "Drifted")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Meta claims 10 bytes; the SDK delivers 4 (everything the server has).
			mockListing({
				files: [makeListingFile(fileUuid, "short.exe", "short.exe", 10n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/short.exe`, new Uint8Array([1, 2, 3, 4]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const offline = await createOffline()
			const errors = await offline.storeDirectory({ directory: dirItem, parent })

			// Store succeeded — degraded warning only, no throw, tree committed.
			expect(errors).toHaveLength(1)
			expect(errors[0]?.degraded).toBe(true)
			expect(errors[0]?.message).toContain("size mismatch")

			const meta = readDirectoryMetaFromDisk(uuid)

			expect(meta?.entries?.[fileUuid]?.diskSize).toBe(4)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}/short.exe`)).toBe(true)
		})

		// The recorded delivered size must BLESS the bytes on later thorough passes: no re-download,
		// no repeated warning — the loop the record exists to break.
		it("does not re-download or re-warn a recorded size-drifted file on a thorough reconcile", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "Drifted")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const fileItem = makeFileItemWithSize(fileUuid, "short.exe", 10n)

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {
					[fileUuid]: {
						item: fileItem,
						path: "/short.exe",
						diskSize: 4
					}
				}
			})
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/short.exe`, new Uint8Array([1, 2, 3, 4]))

			mockListing({
				files: [makeListingFile(fileUuid, "short.exe", "short.exe", 10n)]
			})

			const offline = await createOffline()
			const errors = await offline.reconcileTree({ directory: dirItem, parent, thorough: true })

			expect(errors).toHaveLength(0)
			expect(transfers.download).not.toHaveBeenCalled()

			const meta = readDirectoryMetaFromDisk(uuid)

			expect(meta?.entries?.[fileUuid]?.diskSize).toBe(4)
		})

		// Regression: two concurrent storeDirectory calls for the same uuid both pass the read-only
		// guards (they run before the locks); call A commits a full tree; call B then enters the lock
		// and fails. B must NOT delete A's committed tree — the failure is surfaced by throwing, with
		// zero deletions.
		it("surfaces the failure WITHOUT deleting when an initial store fails over an existing committed meta", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "Committed")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const fileItem = makeFileItemWithSize(fileUuid, "a.txt", 1n)

			// A concurrent call already committed this tree (readable meta + healthy bytes on disk) —
			// but the index is cold, so this call passed the isItemStored guard before the lock.
			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: makeEntries({ "/a.txt": fileItem })
			})
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/a.txt`, new Uint8Array([1]))

			const metaBefore = fs.get(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`)

			// This pass fails: the listing reports a new entry whose download rejects.
			mockListing({
				files: [
					makeListingFile(fileUuid, "a.txt", "a.txt", 1n),
					makeListingFile("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "b.txt", "b.txt", 1n)
				]
			})

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Network error"))

			const offline = await createOffline()

			await expect(offline.storeDirectory({ directory: dirItem, parent, skipIndexUpdate: true })).rejects.toThrow("Network error")

			// The committed tree and its meta survive — only the error is surfaced.
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(true)
			expect(fs.get(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(metaBefore)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}/a.txt`)).toBe(true)
		})

		it("skips linked directories in entries", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "WithLinked")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const dataDirectoryUri = `${DIRECTORIES_DIR_URI}/${uuid}`

			mockListing({
				dirs: [
					{
						dir: { tag: NonRootDir_Tags.Linked, inner: [{ uuid: "linked-uuid" }] },
						path: "linked"
					}
				]
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent })

			const metaUri = `${dataDirectoryUri}/${uuid}.filenmeta`
			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as DirectoryOfflineMeta

			// Linked directory should be excluded from entries — and with nothing to fetch, the
			// download must not run at all.
			expect(Object.keys(meta.entries)).toHaveLength(0)
			expect(transfers.download).not.toHaveBeenCalled()
		})
	})

	describe("listDirectories with parent", () => {
		it("lists direct children of a stored directory", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const subDirUuid = "22222222-2222-2222-2222-222222222222"
			const fileUuid = "33333333-3333-3333-3333-333333333333"
			const deepFileUuid = "44444444-4444-4444-4444-444444444444"
			const topDirItem = makeDirItem(topUuid, "Root")
			const parent = makeParent("55555555-5555-5555-5555-555555555555")

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: makeEntries({
					"/docs": makeDirItem(subDirUuid, "docs"),
					"/readme.md": makeFileItem(fileUuid, "readme.md"),
					"/docs/deep.txt": makeFileItem(deepFileUuid, "deep.txt")
				})
			})

			const offline = await createOffline()

			// List children of the top-level directory
			const topParent = new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid: topUuid } as unknown as Dir))
			const result = await offline.listDirectories(topParent)

			// Should contain the direct children: /docs (dir) and /readme.md (file)
			expect(result.directories).toHaveLength(1)
			expect(result.directories[0].item.data.uuid).toBe(subDirUuid)
			expect(result.files).toHaveLength(1)
			expect(result.files[0].item.data.uuid).toBe(fileUuid)
		})

		it("does not include grandchildren", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const subDirUuid = "22222222-2222-2222-2222-222222222222"
			const deepFileUuid = "33333333-3333-3333-3333-333333333333"
			const topDirItem = makeDirItem(topUuid, "Root")
			const parent = makeParent("55555555-5555-5555-5555-555555555555")

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: makeEntries({
					"/sub": makeDirItem(subDirUuid, "sub"),
					"/sub/nested.txt": makeFileItem(deepFileUuid, "nested.txt")
				})
			})

			const offline = await createOffline()

			// List children of the top-level
			const topParent = new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid: topUuid } as unknown as Dir))
			const result = await offline.listDirectories(topParent)

			// Only /sub should appear, not /sub/nested.txt
			expect(result.directories).toHaveLength(1)
			expect(result.files).toHaveLength(0)
		})

		it("lists contents of a subdirectory", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const subDirUuid = "22222222-2222-2222-2222-222222222222"
			const fileInSubUuid = "33333333-3333-3333-3333-333333333333"
			const topDirItem = makeDirItem(topUuid, "Root")
			const parent = makeParent("55555555-5555-5555-5555-555555555555")

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: makeEntries({
					"/sub": makeDirItem(subDirUuid, "sub"),
					"/sub/file.txt": makeFileItem(fileInSubUuid, "file.txt")
				})
			})

			const offline = await createOffline()

			// List children of /sub
			const subParent = new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid: subDirUuid } as unknown as Dir))
			const result = await offline.listDirectories(subParent)

			expect(result.files).toHaveLength(1)
			expect(result.files[0].item.data.uuid).toBe(fileInSubUuid)
			expect(result.directories).toHaveLength(0)
		})

		it("returns empty for unknown parent", async () => {
			const offline = await createOffline()
			const unknownParent = new AnyDirWithContext.Normal(
				new AnyNormalDir.Dir({ uuid: "99999999-9999-9999-9999-999999999999" } as unknown as Dir)
			)
			const result = await offline.listDirectories(unknownParent)

			expect(result.files).toHaveLength(0)
			expect(result.directories).toHaveLength(0)
		})
	})

	describe("readDirectoryMeta error recovery", () => {
		it("returns null when meta file is corrupted", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"

			// Write a corrupt meta file
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`, new Uint8Array([0xff, 0xfe, 0x00]))

			const offline = await createOffline()
			const result = await offline.listDirectories()

			// Corrupt directory should not appear in the listing
			expect(result.directories).toHaveLength(0)
		})

		// Regression (bug #4): after the old sync() rename branch wrote {item, parent} only,
		// readDirectoryMeta would happily return this entries-less object, causing
		// Object.values(meta.entries) to throw in clearAll and for...in undefined to silently
		// skip all nested items in listDirectories/listDirectoriesRecursive.
		// The hardened readDirectoryMeta must now reject such metas (treat as corrupt).
		it("returns null when meta has a directory item type but no entries field", async () => {
			const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(uuid, "NeedsEntries")
			const parent = makeParent("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

			// Simulate the corrupt write from the old sync() rename branch: {item, parent} only
			const noEntriesMeta = { item: dirItem, parent }

			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize(noEntriesMeta))))

			const offline = await createOffline()
			const result = await offline.listDirectories()

			// This directory should NOT appear in the listing because its meta is corrupt
			expect(result.directories).toHaveLength(0)
		})
	})

	describe("updateIndex query updates", () => {
		it("sets query cache to true for each standalone file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "standalone.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "standalone.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()

			await offline.updateIndex()

			expect(driveItemStoredOfflineQueryUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					updater: true,
					params: expect.objectContaining({ uuid, type: "file" })
				})
			)
		})

		it("sets query cache to true for top-level directory and its nested entries", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const nestedFileUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "my-dir")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			const nestedFile = makeFileItem(nestedFileUuid, "nested.txt")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/nested.txt": nestedFile
				})
			})

			// Write data file so listDirectoriesRecursive finds it
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/nested.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()

			await offline.updateIndex()

			const calls = vi.mocked(driveItemStoredOfflineQueryUpdate).mock.calls
			const updatedUuids = calls.filter(([arg]) => arg.updater === true).map(([arg]) => arg.params.uuid)

			expect(updatedUuids).toContain(dirUuid)
			expect(updatedUuids).toContain(nestedFileUuid)
		})
	})

	describe("updateIndex stale storedOffline query reconciliation", () => {
		const GHOST_UUID = "99999999-9999-9999-9999-999999999999"

		it("broadcasts false for a cached true entry whose uuid is not in the rebuilt index", async () => {
			const storedUuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(storedUuid, "kept.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(storedUuid, "kept.txt")
			writeFileMeta(storedUuid, { item: fileItem, parent })

			const offline = await createOffline()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()
			vi.mocked(getStoredOfflineQueryCacheEntries).mockReturnValueOnce([
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "directory",
							uuid: GHOST_UUID
						}
					],
					state: {
						data: true
					}
				}
			])

			await offline.updateIndex()

			expect(driveItemStoredOfflineQueryUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					updater: false,
					params: expect.objectContaining({
						uuid: GHOST_UUID,
						type: "directory"
					})
				})
			)
		})

		it("does not broadcast false for a cached true entry whose uuid is in the rebuilt index", async () => {
			const storedUuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(storedUuid, "kept.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(storedUuid, "kept.txt")
			writeFileMeta(storedUuid, { item: fileItem, parent })

			const offline = await createOffline()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()
			vi.mocked(getStoredOfflineQueryCacheEntries).mockReturnValueOnce([
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "file",
							uuid: storedUuid
						}
					],
					state: {
						data: true
					}
				}
			])

			await offline.updateIndex()

			const falseCalls = vi.mocked(driveItemStoredOfflineQueryUpdate).mock.calls.filter(([arg]) => arg.updater === false)

			expect(falseCalls).toHaveLength(0)

			// The regular per-item loop still broadcast true for it.
			expect(driveItemStoredOfflineQueryUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					updater: true,
					params: expect.objectContaining({
						uuid: storedUuid,
						type: "file"
					})
				})
			)
		})

		it("skips malformed cache keys without throwing and still reconciles valid ones", async () => {
			const offline = await createOffline()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()
			vi.mocked(getStoredOfflineQueryCacheEntries).mockReturnValueOnce([
				// Missing uuid.
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "directory"
						}
					],
					state: {
						data: true
					}
				},
				// Missing params object entirely.
				{
					queryKey: ["useDriveItemStoredOfflineQuery"],
					state: {
						data: true
					}
				},
				// Unknown (non-normalized) type value.
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "banana",
							uuid: GHOST_UUID
						}
					],
					state: {
						data: true
					}
				},
				// Valid ghost entry.
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "file",
							uuid: GHOST_UUID
						}
					],
					state: {
						data: true
					}
				}
			])

			await expect(offline.updateIndex()).resolves.toBeUndefined()

			const falseCalls = vi.mocked(driveItemStoredOfflineQueryUpdate).mock.calls.filter(([arg]) => arg.updater === false)

			expect(falseCalls).toHaveLength(1)
			expect(falseCalls[0]?.[0]?.params).toEqual(
				expect.objectContaining({
					uuid: GHOST_UUID,
					type: "file"
				})
			)
		})

		it("does not broadcast false for cached entries whose data is not true", async () => {
			const offline = await createOffline()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()
			vi.mocked(getStoredOfflineQueryCacheEntries).mockReturnValueOnce([
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "file",
							uuid: GHOST_UUID
						}
					],
					state: {
						data: false
					}
				},
				{
					queryKey: [
						"useDriveItemStoredOfflineQuery",
						{
							type: "directory",
							uuid: GHOST_UUID
						}
					],
					state: {
						data: undefined
					}
				}
			])

			await offline.updateIndex()

			const falseCalls = vi.mocked(driveItemStoredOfflineQueryUpdate).mock.calls.filter(([arg]) => arg.updater === false)

			expect(falseCalls).toHaveLength(0)
		})
	})

	describe("removeItem query updates", () => {
		it("calls driveItemStoredOfflineQueryUpdate when removing a file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "tracked.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "tracked.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()

			await offline.removeItem(fileItem)

			// Should be called with updater: false for the removed item
			expect(driveItemStoredOfflineQueryUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					updater: false,
					params: expect.objectContaining({ uuid })
				})
			)
		})

		it("calls driveItemStoredOfflineQueryUpdate even when item is not found", async () => {
			const offline = await createOffline()
			const missingItem = makeFileItem("99999999-9999-9999-9999-999999999999", "ghost.txt")

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()

			await offline.removeItem(missingItem)

			expect(driveItemStoredOfflineQueryUpdate).toHaveBeenCalledWith(expect.objectContaining({ updater: false }))
		})

		it("invalidates query cache for all nested entries when removing a directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const nestedFileUuid = "22222222-2222-2222-2222-222222222222"
			const nestedSubdirUuid = "33333333-3333-3333-3333-333333333333"
			const dirItem = makeDirItem(dirUuid, "my-dir")
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			const nestedFile = makeFileItem(nestedFileUuid, "nested.txt")
			const nestedSubdir = makeDirItem(nestedSubdirUuid, "sub-dir")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/nested.txt": nestedFile,
					"/sub-dir": nestedSubdir
				})
			})

			// Write some data so the directory "exists"
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()

			await offline.removeItem(dirItem)

			const calls = vi.mocked(driveItemStoredOfflineQueryUpdate).mock.calls

			// Should have invalidated: nested file, nested subdir, and the top-level dir itself
			const invalidatedUuids = calls.filter(([arg]) => arg.updater === false).map(([arg]) => arg.params.uuid)

			expect(invalidatedUuids).toContain(nestedFileUuid)
			expect(invalidatedUuids).toContain(nestedSubdirUuid)
			expect(invalidatedUuids).toContain(dirUuid)
		})

		it("optimistically prunes the /offline virtual-root listing when removing a stored file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "tracked.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const survivorUuid = "33333333-3333-3333-3333-333333333333"
			const survivorItem = makeFileItem(survivorUuid, "survivor.txt")

			writeFileData(uuid, "tracked.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(driveItemsQueryUpdate).mockClear()

			await offline.removeItem(fileItem)

			// The optimistic update targets the offline virtual-root path.
			const offlineRootCalls = vi
				.mocked(driveItemsQueryUpdate)
				.mock.calls.filter(([arg]) => arg.params.path.type === "offline" && arg.params.path.uuid === null)

			expect(offlineRootCalls).toHaveLength(1)

			// The updater must remove only the targeted uuid, leaving everything else intact,
			// and pass through non-array prev untouched (e.g., uninitialized cache).
			const [{ updater }] = offlineRootCalls[0]!

			if (typeof updater !== "function") {
				throw new Error("Expected updater to be a function")
			}

			const seeded: DriveItem[] = [fileItem, survivorItem]
			const pruned = updater(seeded) as DriveItem[]

			expect(pruned).toEqual([survivorItem])
			expect(updater(undefined as unknown as DriveItem[])).toBeUndefined()
		})

		it("optimistically prunes the /offline virtual-root listing when removing a stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(dirUuid, "my-dir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const survivorUuid = "33333333-3333-3333-3333-333333333333"
			const survivorItem = makeFileItem(survivorUuid, "survivor.txt")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {}
			})
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(driveItemsQueryUpdate).mockClear()

			await offline.removeItem(dirItem)

			const offlineRootCalls = vi
				.mocked(driveItemsQueryUpdate)
				.mock.calls.filter(([arg]) => arg.params.path.type === "offline" && arg.params.path.uuid === null)

			expect(offlineRootCalls).toHaveLength(1)

			const [{ updater }] = offlineRootCalls[0]!

			if (typeof updater !== "function") {
				throw new Error("Expected updater to be a function")
			}

			const seeded: DriveItem[] = [dirItem, survivorItem]

			expect(updater(seeded) as DriveItem[]).toEqual([survivorItem])
		})
	})

	describe("isItemTopLevelStoredSync after updateIndex", () => {
		it("returns true for a top-level standalone file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "standalone.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "standalone.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// After updateIndex, both indexCache and uuidToTopLevelCache must be warm.
			// Before the fix, uuidToTopLevelCache was lazy-built and this returned undefined.
			expect(offline.isItemTopLevelStoredSync(fileItem)).toBe(true)
		})

		it("returns true for a top-level stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(dirUuid, "my-dir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {}
			})
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			expect(offline.isItemTopLevelStoredSync(dirItem)).toBe(true)
		})

		it("returns false for a nested file inside a stored directory (cannot be individually removed)", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const nestedFileUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "my-dir")
			const nestedFile = makeFileItem(nestedFileUuid, "nested.txt")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/nested.txt": nestedFile
				})
			})
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/nested.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			// Nested children are flattened into index.files by updateIndex,
			// but isItemTopLevelStoredSync correctly distinguishes them via
			// uuidToTopLevelCache. The "Remove offline" menu entry must stay hidden
			// for nested items in /drive, /favorites etc.
			expect(offline.isItemTopLevelStoredSync(nestedFile)).toBe(false)
			// The owning top-level directory still reports true.
			expect(offline.isItemTopLevelStoredSync(dirItem)).toBe(true)
		})

		it("returns false for a nested directory inside a stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const nestedSubdirUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "my-dir")
			const nestedSubdir = makeDirItem(nestedSubdirUuid, "sub-dir")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/sub-dir": nestedSubdir
				})
			})
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			expect(offline.isItemTopLevelStoredSync(nestedSubdir)).toBe(false)
		})

		it("returns false for an item that is not stored at all", async () => {
			const offline = await createOffline()

			await offline.updateIndex()

			const unstoredFile = makeFileItem("99999999-9999-9999-9999-999999999999", "nope.txt")

			expect(offline.isItemTopLevelStoredSync(unstoredFile)).toBe(false)
		})

		it("returns the correct value after isItemStored() warms the caches (no updateIndex needed)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "standalone.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "standalone.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			// Pre-seed an index on disk so isItemStored has something to read.
			writeIndex({
				files: {
					[uuid]: { item: fileItem, parent }
				},
				directories: {}
			})

			const offline = await createOffline()

			// Defensive warming: isItemStored() now also primes uuidToTopLevelCache.
			// Without that warm path, the sync top-level check would return undefined
			// until something else (e.g. updateIndex) ran.
			await offline.isItemStored(fileItem)

			expect(offline.isItemTopLevelStoredSync(fileItem)).toBe(true)
		})
	})

	describe("storeDirectory skipIndexUpdate", () => {
		it("stores directory without updating the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "NoIndex")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const offline = await createOffline()

			// Empty remote tree — nothing to download, the commit still writes the meta.
			await offline.storeDirectory({ directory: dirItem, parent, skipIndexUpdate: true })

			// Meta should be written
			expect(fs.get(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)

			// Index should NOT exist
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})
	})

	describe("multiple top-level directories", () => {
		it("lists all stored top-level directories", async () => {
			const dirs = [
				{ uuid: "11111111-1111-1111-1111-111111111111", name: "Photos" },
				{ uuid: "22222222-2222-2222-2222-222222222222", name: "Documents" },
				{ uuid: "33333333-3333-3333-3333-333333333333", name: "Music" }
			]

			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			for (const { uuid, name } of dirs) {
				writeDirectoryMeta(uuid, {
					item: makeDirItem(uuid, name),
					parent,
					entries: {}
				})
			}

			const offline = await createOffline()
			const result = await offline.listDirectories()

			expect(result.directories).toHaveLength(3)

			const uuids = result.directories.map((d: { item: DriveItem }) => d.item.data.uuid)

			expect(uuids).toContain(dirs[0]!.uuid)
			expect(uuids).toContain(dirs[1]!.uuid)
			expect(uuids).toContain(dirs[2]!.uuid)
		})

		it("includes files from all directories in listDirectoriesRecursive", async () => {
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			writeDirectoryMeta("11111111-1111-1111-1111-111111111111", {
				item: makeDirItem("11111111-1111-1111-1111-111111111111", "Dir1"),
				parent,
				entries: makeEntries({
					"/a.txt": makeFileItem("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "a.txt")
				})
			})

			writeDirectoryMeta("22222222-2222-2222-2222-222222222222", {
				item: makeDirItem("22222222-2222-2222-2222-222222222222", "Dir2"),
				parent,
				entries: makeEntries({
					"/b.txt": makeFileItem("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "b.txt")
				})
			})

			const offline = await createOffline()
			const result = await offline.listDirectoriesRecursive()

			expect(result.directories).toHaveLength(2)
			expect(result.files).toHaveLength(2)
		})
	})

	describe("itemSize for nested subdirectory", () => {
		it("returns size scoped to a nested subdirectory", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const subDirUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("55555555-5555-5555-5555-555555555555")

			writeDirectoryMeta(topUuid, {
				item: makeDirItem(topUuid, "Root"),
				parent,
				entries: makeEntries({
					"/root-file.txt": makeFileItemWithSize("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "root-file.txt", 200n),
					"/sub": makeDirItem(subDirUuid, "sub"),
					"/sub/inner.txt": makeFileItemWithSize("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "inner.txt", 300n),
					"/sub/deep": makeDirItem("cccccccc-cccc-cccc-cccc-cccccccccccc", "deep"),
					"/sub/deep/deep.txt": makeFileItemWithSize("dddddddd-dddd-dddd-dddd-dddddddddddd", "deep.txt", 400n)
				})
			})

			const offline = await createOffline()

			// Size of the nested /sub directory (should include /sub/inner.txt, /sub/deep, /sub/deep/deep.txt but NOT /root-file.txt)
			const subDirItem = makeDirItem(subDirUuid, "sub")
			const size = await offline.itemSize(subDirItem)

			expect(size.size).toBe(700) // 300 + 400
			expect(size.files).toBe(2) // inner.txt + deep.txt
			expect(size.dirs).toBe(1) // deep
		})
	})

	describe("getLocalDirectory for nested directory", () => {
		it("finds a nested directory inside a stored directory tree", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const nestedDirUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			writeDirectoryMeta(topUuid, {
				item: makeDirItem(topUuid, "Root"),
				parent,
				entries: makeEntries({
					"/nested": makeDirItem(nestedDirUuid, "nested")
				})
			})

			// Create the nested directory on disk
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}/nested`, "dir")

			const offline = await createOffline()
			const nestedDirItem = makeDirItem(nestedDirUuid, "nested")
			const dir = await offline.getLocalDirectory(nestedDirItem)

			expect(dir).not.toBeNull()
			expect(dir?.uri).toContain(topUuid)
			expect(dir?.uri).toContain("nested")
		})
	})

	describe("integration: file lifecycle", () => {
		it("store → verify stored → get local → remove → verify removed", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "lifecycle.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([1, 2, 3, 4, 5]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			// 1. Store the file
			await offline.storeFile({ file: fileItem, parent })

			// 2. Verify it is stored
			expect(await offline.isItemStored(fileItem)).toBe(true)

			// 3. Get the local file
			const localFile = await offline.getLocalFile(fileItem)

			expect(localFile).not.toBeNull()
			expect(localFile?.exists).toBe(true)

			// 4. Verify it appears in listFiles
			const files = await offline.listFiles()

			expect(files.some((f: { item: DriveItem }) => f.item.data.uuid === uuid)).toBe(true)

			// 5. Remove it
			await offline.removeItem(fileItem)

			// 6. Verify it is gone
			expect(await offline.isItemStored(fileItem)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
		})
	})

	describe("integration: directory lifecycle", () => {
		it("store → list contents → itemSize → remove → verify removed", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "Project")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")
			const dataDirectoryUri = `${DIRECTORIES_DIR_URI}/${dirUuid}`

			mockListing({
				files: [makeListingFile(fileUuid, "notes.txt", "notes.txt", 3n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/notes.txt`, new Uint8Array([10, 20, 30]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const offline = await createOffline()

			// 1. Store
			await offline.storeDirectory({ directory: dirItem, parent })

			// 2. Verify stored
			expect(await offline.isItemStored(dirItem)).toBe(true)

			// 3. List top-level
			const dirs = await offline.listDirectories()

			expect(dirs.directories.some((d: { item: DriveItem }) => d.item.data.uuid === dirUuid)).toBe(true)

			// 4. Check size
			const size = await offline.itemSize(dirItem)

			expect(size.files).toBeGreaterThanOrEqual(1)

			// 5. Remove
			await offline.removeItem(dirItem)

			// 6. Verify removed
			expect(await offline.isItemStored(dirItem)).toBe(false)
			expect(fs.has(dataDirectoryUri)).toBe(false)
		})
	})

	describe("edge cases", () => {
		it("handles multiple files stored simultaneously", async () => {
			const items = [
				{ uuid: "11111111-1111-1111-1111-111111111111", name: "a.txt" },
				{ uuid: "22222222-2222-2222-2222-222222222222", name: "b.txt" },
				{ uuid: "33333333-3333-3333-3333-333333333333", name: "c.txt" }
			]

			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			for (const { uuid, name } of items) {
				writeFileData(uuid, name)
				writeFileMeta(uuid, {
					item: makeFileItem(uuid, name),
					parent
				})
			}

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toHaveLength(3)
		})

		it("handles empty directory meta entries", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "EmptyDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()
			const size = await offline.itemSize(dirItem)

			expect(size).toEqual({ size: 0, files: 0, dirs: 0 })
		})

		it("isItemStored handles sharedFile type", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const sharedFileItem = {
				type: "sharedFile",
				data: {
					uuid,
					decryptedMeta: { name: "shared.txt", size: 50n, modified: 1000, created: 900 },
					undecryptable: false
				}
			} as unknown as DriveItem

			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: sharedFileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()

			expect(await offline.isItemStored(sharedFileItem)).toBe(true)
		})

		it("isItemStored handles sharedDirectory type", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const sharedDirItem = {
				type: "sharedDirectory",
				data: {
					uuid,
					decryptedMeta: { name: "shared-dir" },
					undecryptable: false
				}
			} as unknown as DriveItem

			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: {},
				directories: { [uuid]: { item: sharedDirItem, parent } }
			})

			const offline = await createOffline()

			expect(await offline.isItemStored(sharedDirItem)).toBe(true)
		})

		it("isItemStored handles sharedRootDirectory type", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const sharedRootDirItem = {
				type: "sharedRootDirectory",
				data: {
					uuid,
					decryptedMeta: { name: "shared-root" },
					undecryptable: false
				}
			} as unknown as DriveItem

			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: {},
				directories: { [uuid]: { item: sharedRootDirItem, parent } }
			})

			const offline = await createOffline()

			expect(await offline.isItemStored(sharedRootDirItem)).toBe(true)
		})

		it("updateIndex includes directory entry files in the index", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const nestedFileUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			writeDirectoryMeta(dirUuid, {
				item: makeDirItem(dirUuid, "WithFiles"),
				parent,
				entries: makeEntries({
					"/doc.txt": makeFileItem(nestedFileUuid, "doc.txt")
				})
			})

			const offline = await createOffline()

			await offline.updateIndex()

			const index = readIndex()

			// The directory should be in the index
			expect(index.directories[dirUuid]).toBeDefined()

			// The nested file should also be in the index (from listDirectoriesRecursive)
			expect(index.files[nestedFileUuid]).toBeDefined()
		})

		it("itemSize does not match path prefix ambiguity (/a vs /ab)", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const subDirA = "22222222-2222-2222-2222-222222222222"
			const subDirAb = "33333333-3333-3333-3333-333333333333"
			const fileInA = "44444444-4444-4444-4444-444444444444"
			const fileInAb = "55555555-5555-5555-5555-555555555555"
			const parent = makeParent("66666666-6666-6666-6666-666666666666")

			const dirItem = makeDirItem(dirUuid, "Root")
			const subDirAItem = makeDirItem(subDirA, "a")
			const subDirAbItem = makeDirItem(subDirAb, "ab")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/a": subDirAItem,
					"/ab": subDirAbItem,
					"/a/file.txt": makeFileItemWithSize(fileInA, "file.txt", 100n),
					"/ab/file.txt": makeFileItemWithSize(fileInAb, "file.txt", 200n)
				})
			})

			// Create directories on disk
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/a`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/ab`, "dir")

			const offline = await createOffline()

			// Size of /a should only include file.txt (100 bytes), not /ab/file.txt
			const sizeA = await offline.itemSize(subDirAItem)

			expect(sizeA.files).toBe(1)
			expect(sizeA.size).toBe(100)

			// Size of /ab should only include its own file.txt (200 bytes)
			const sizeAb = await offline.itemSize(subDirAbItem)

			expect(sizeAb.files).toBe(1)
			expect(sizeAb.size).toBe(200)
		})

		it("listFiles skips entries with corrupted meta", async () => {
			const goodUuid = "11111111-1111-1111-1111-111111111111"
			const badUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			// Good file
			writeFileData(goodUuid, "good.txt")
			writeFileMeta(goodUuid, { item: makeFileItem(goodUuid, "good.txt"), parent })

			// Bad file — corrupted meta
			const badDirUri = `${FILES_DIR_URI}/${badUuid}`

			fs.set(badDirUri, "dir")
			fs.set(`${badDirUri}/bad.txt`, new Uint8Array([1, 2, 3]))
			fs.set(`${badDirUri}/${badUuid}.filenmeta`, new Uint8Array([0xff, 0xfe, 0xfd]))

			const offline = await createOffline()
			const files = await offline.listFiles()

			// Should only include the good file, not crash
			expect(files).toHaveLength(1)
			expect(files[0]!.item.data.uuid).toBe(goodUuid)
		})

		it("getLocalFile returns null when file exists in index but not on disk", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "ghost.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Write index entry but no actual file data
			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()
			const localFile = await offline.getLocalFile(fileItem)

			expect(localFile).toBeNull()
		})

		it("getLocalDirectory returns null when directory exists in index but not on disk", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "GhostDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Write index entry but no actual directory data
			writeIndex({
				files: {},
				directories: { [uuid]: { item: dirItem, parent } }
			})

			const offline = await createOffline()
			const localDir = await offline.getLocalDirectory(dirItem)

			expect(localDir).toBeNull()
		})

		it("listDirectoriesRecursive continues when one directory meta is corrupted", async () => {
			const goodUuid = "11111111-1111-1111-1111-111111111111"
			const badUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			// Good directory
			writeDirectoryMeta(goodUuid, {
				item: makeDirItem(goodUuid, "GoodDir"),
				parent,
				entries: {}
			})

			// Bad directory — corrupted meta
			const badDirUri = `${DIRECTORIES_DIR_URI}/${badUuid}`

			fs.set(badDirUri, "dir")
			fs.set(`${badDirUri}/${badUuid}.filenmeta`, new Uint8Array([0xff, 0xfe, 0xfd]))

			const offline = await createOffline()
			const result = await offline.listDirectoriesRecursive()

			// Should include the good directory but not crash on the bad one
			expect(result.directories).toHaveLength(1)
			expect(result.directories[0]!.item.data.uuid).toBe(goodUuid)
		})

		it("removeItem is a no-op for an item that was never stored", async () => {
			const fileItem = makeFileItem("11111111-1111-1111-1111-111111111111", "never-stored.txt")

			const offline = await createOffline()

			// Should not throw
			await expect(offline.removeItem(fileItem)).resolves.not.toThrow()
		})

		it("removeItem for nested file UUID is a no-op", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const nestedFileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "ParentDir")
			const nestedFile = makeFileItem(nestedFileUuid, "nested.txt")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({
					"/data/nested.txt": nestedFile
				})
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/nested.txt`, new Uint8Array([1, 2]))

			const offline = await createOffline()

			await offline.updateIndex()

			// Try to remove the nested file directly — should not crash
			await expect(offline.removeItem(nestedFile)).resolves.not.toThrow()

			// Parent directory should still be intact
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}/${dirUuid}.filenmeta`)).toBe(true)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/nested.txt`)).toBe(true)
		})

		it("store and remove multiple files, verify remaining", async () => {
			const parent = makeParent("55555555-5555-5555-5555-555555555555")
			const files = [
				{ uuid: "11111111-1111-1111-1111-111111111111", name: "keep1.txt" },
				{ uuid: "22222222-2222-2222-2222-222222222222", name: "remove.txt" },
				{ uuid: "33333333-3333-3333-3333-333333333333", name: "keep2.txt" }
			]

			// Store all three files manually
			for (const { uuid, name } of files) {
				writeFileData(uuid, name)
				writeFileMeta(uuid, { item: makeFileItem(uuid, name), parent })
			}

			const offline = await createOffline()

			await offline.updateIndex()

			// Remove the middle file
			await offline.removeItem(makeFileItem(files[1]!.uuid, files[1]!.name))

			// Remaining files should still be listed
			const remaining = await offline.listFiles()

			expect(remaining).toHaveLength(2)

			const remainingUuids = remaining.map((f: { item: DriveItem }) => f.item.data.uuid)

			expect(remainingUuids).toContain(files[0]!.uuid)
			expect(remainingUuids).toContain(files[2]!.uuid)
			expect(remainingUuids).not.toContain(files[1]!.uuid)
		})
	})

	describe("findParentAnyDirWithContext with shared types (test 21)", () => {
		it("resolves parent for sharedRootDirectory entries in listDirectories", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const childFileUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			const sharedRootDirItem = {
				type: "sharedRootDirectory",
				data: {
					uuid: topUuid,
					decryptedMeta: { name: "SharedRoot", size: 0n, modified: 1000, created: 900 },
					undecryptable: false,
					sharingRole: { tag: SharingRole_Tags.Receiver }
				}
			} as unknown as DriveItem

			const childFile = makeFileItem(childFileUuid, "child.txt")

			writeDirectoryMeta(topUuid, {
				item: sharedRootDirItem,
				parent,
				entries: makeEntries({
					"/child.txt": childFile
				})
			})

			const offline = await createOffline()

			// List children of the sharedRootDirectory
			// This exercises findParentAnyDirWithContext with sharedRootDirectory type
			const topParent = new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid: topUuid } as unknown as Dir))
			const result = await offline.listDirectories(topParent)

			expect(result.files).toHaveLength(1)
			expect(result.files[0].item.data.uuid).toBe(childFileUuid)
		})

		it("resolves parent for sharedDirectory entries in listDirectoriesRecursive", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const sharedSubDirUuid = "22222222-2222-2222-2222-222222222222"
			const fileInSharedUuid = "33333333-3333-3333-3333-333333333333"
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			const topDirItem = makeDirItem(topUuid, "Root")

			const sharedParentUuid = "55555555-5555-5555-5555-555555555555"

			const sharedSubDir = {
				type: "sharedDirectory",
				data: {
					uuid: sharedSubDirUuid,
					decryptedMeta: { name: "SharedSub", size: 0n, modified: 1000, created: 900 },
					undecryptable: false,
					inner: { parent: sharedParentUuid }
				}
			} as unknown as DriveItem

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: makeEntries({
					"/SharedSub": sharedSubDir,
					"/SharedSub/data.txt": makeFileItem(fileInSharedUuid, "data.txt")
				})
			})

			// Set up cache and mock for sharedDirectory parent resolution
			cache.directoryUuidToAnySharedDirWithContext.set(sharedParentUuid, {
				shareInfo: { tag: SharingRole_Tags.Receiver }
			} as any)

			const { unwrapParentUuid } = await import("@/lib/sdkUnwrap")

			vi.mocked(unwrapParentUuid).mockReset()
			vi.mocked(unwrapParentUuid).mockImplementation(() => sharedParentUuid)

			const offline = await createOffline()
			const result = await offline.listDirectoriesRecursive()

			// Should include the top-level directory and the shared subdirectory
			expect(result.directories.length).toBeGreaterThanOrEqual(2)

			const dirUuids = result.directories.map((d: { item: DriveItem }) => d.item.data.uuid)

			expect(dirUuids).toContain(topUuid)
			expect(dirUuids).toContain(sharedSubDirUuid)

			// Should include the file inside the shared subdirectory
			expect(result.files.length).toBeGreaterThanOrEqual(1)

			const fileUuids = result.files.map((f: { item: DriveItem }) => f.item.data.uuid)

			expect(fileUuids).toContain(fileInSharedUuid)

			// Clean up
			cache.directoryUuidToAnySharedDirWithContext.delete(sharedParentUuid)
			vi.mocked(unwrapParentUuid).mockImplementation(() => null)
		})

		// Regression (#46): a stored nested-shared-dir entry whose parent is absent from the cache must NOT
		// throw inside findParentAnyDirWithContext (which runs in the unguarded Promise.all of
		// listDirectoriesRecursive). It must return null so the entry is skipped and updateIndex() completes
		// as a PARTIAL rebuild rather than rejecting and aborting the whole offline index.
		it("yields a partial (not rejected) updateIndex when a nested shared-dir parent is missing from cache", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const sharedSubDirUuid = "22222222-2222-2222-2222-222222222222"
			const fileInSharedUuid = "33333333-3333-3333-3333-333333333333"
			const parent = makeParent("44444444-4444-4444-4444-444444444444")
			const sharedParentUuid = "55555555-5555-5555-5555-555555555555"

			const topDirItem = makeDirItem(topUuid, "Root")

			const sharedSubDir = {
				type: "sharedDirectory",
				data: {
					uuid: sharedSubDirUuid,
					decryptedMeta: { name: "SharedSub", size: 0n, modified: 1000, created: 900 },
					undecryptable: false,
					inner: { parent: sharedParentUuid }
				}
			} as unknown as DriveItem

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: makeEntries({
					"/SharedSub": sharedSubDir,
					"/SharedSub/data.txt": makeFileItem(fileInSharedUuid, "data.txt")
				})
			})

			// Parent resolves to a uuid, but the shared-context cache is EMPTY — the old code threw here.
			cache.directoryUuidToAnySharedDirWithContext.clear()

			const { unwrapParentUuid } = await import("@/lib/sdkUnwrap")

			vi.mocked(unwrapParentUuid).mockReset()
			vi.mocked(unwrapParentUuid).mockImplementation(() => sharedParentUuid)

			const offline = await createOffline()

			// Must NOT reject — the missing-parent shared entry is skipped, the rest is rebuilt.
			await expect(offline.updateIndex()).resolves.toBeUndefined()

			// The index file was written (rebuild reached the end) and the top-level directory survives.
			expect(fs.has(INDEX_FILE_URI)).toBe(true)

			const index = readIndex()

			expect(index.directories[topUuid]).toBeDefined()

			// The shared subdirectory itself resolves (its parent is the top-level "directory", no cache needed),
			// so it stays in the index...
			expect(index.directories[sharedSubDirUuid]).toBeDefined()

			// ...but the file UNDER it — whose parent IS the unresolvable shared-dir (empty cache) — is the entry
			// that used to throw and abort the whole rebuild. Now it is simply skipped (partial index).
			expect(index.files[fileInSharedUuid]).toBeUndefined()

			vi.mocked(unwrapParentUuid).mockReset()
			vi.mocked(unwrapParentUuid).mockImplementation(() => null)
		})
	})

	describe("concurrent store operations (test 22)", () => {
		it("allows multiple concurrent storeFile calls to complete", async () => {
			const files = [
				{ uuid: "11111111-1111-1111-1111-111111111111", name: "a.txt" },
				{ uuid: "22222222-2222-2222-2222-222222222222", name: "b.txt" },
				{ uuid: "33333333-3333-3333-3333-333333333333", name: "c.txt" },
				{ uuid: "44444444-4444-4444-4444-444444444444", name: "d.txt" },
				{ uuid: "55555555-5555-5555-5555-555555555555", name: "e.txt" }
			]

			const parent = makeParent("66666666-6666-6666-6666-666666666666")

			let concurrentCount = 0
			let maxConcurrent = 0

			vi.mocked(transfers.download).mockImplementation(async ({ destination }) => {
				concurrentCount++

				if (concurrentCount > maxConcurrent) {
					maxConcurrent = concurrentCount
				}

				// Simulate some async work
				await new Promise(resolve => setTimeout(resolve, 10))

				if (destination instanceof File) {
					destination.write(new Uint8Array([1, 2, 3]))
				}

				concurrentCount--

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			// Launch all stores concurrently
			await Promise.all(
				files.map(({ uuid, name }) =>
					offline.storeFile({
						file: makeFileItem(uuid, name),
						parent,
						skipIndexUpdate: true
					})
				)
			)

			// All files should be stored
			for (const { uuid, name } of files) {
				expect(fs.get(`${FILES_DIR_URI}/${uuid}/${name}`)).toBeInstanceOf(Uint8Array)
				expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)
			}

			// Semaphore(3) should allow up to 3 concurrent operations
			expect(maxConcurrent).toBeGreaterThan(1)
			expect(maxConcurrent).toBeLessThanOrEqual(3)
		})

		it("concurrent storeFile + storeDirectory do not interfere", async () => {
			const fileUuid = "11111111-1111-1111-1111-111111111111"
			const dirUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			vi.mocked(transfers.download).mockImplementation(async ({ destination }): Promise<any> => {
				await new Promise(resolve => setTimeout(resolve, 5))

				if (destination instanceof File) {
					destination.write(new Uint8Array([1, 2, 3]))
				} else {
					const destUri = (destination as { uri: string }).uri

					fs.set(destUri, "dir")

					return { files: [], directories: [] }
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await Promise.all([
				offline.storeFile({
					file: makeFileItem(fileUuid, "concurrent.txt"),
					parent,
					skipIndexUpdate: true
				}),
				offline.storeDirectory({
					directory: makeDirItem(dirUuid, "ConcurrentDir"),
					parent,
					skipIndexUpdate: true
				})
			])

			// Both should be stored without corruption
			expect(fs.get(`${FILES_DIR_URI}/${fileUuid}/${fileUuid}.filenmeta`)).toBeInstanceOf(Uint8Array)
			expect(fs.get(`${DIRECTORIES_DIR_URI}/${dirUuid}/${dirUuid}.filenmeta`)).toBeInstanceOf(Uint8Array)
		})
	})

	describe("critical coverage gaps", () => {
		it("isItemStored correctly caches and returns false values", async () => {
			writeIndex({ files: {}, directories: {} })

			const offline = await createOffline()
			const item = makeFileItem("99999999-9999-9999-9999-999999999999", "nonexistent.txt")

			// First call reads from index, returns false, caches it
			expect(await offline.isItemStored(item)).toBe(false)

			// Write a new index with the item — but cached false should be returned
			writeIndex({
				files: {
					"99999999-9999-9999-9999-999999999999": {
						item,
						parent: makeParent("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
					}
				},
				directories: {}
			})

			// Second call should return cached false without re-reading index
			expect(await offline.isItemStored(item)).toBe(false)
		})

		it("atomicWrite cleans up temp file on move failure and propagates error", async () => {
			const offline = await createOffline()
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "atomic-fail.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Patch File.prototype.move to throw for tmp files
			const originalMove = File.prototype.move

			File.prototype.move = function (this: InstanceType<typeof File>, dest: InstanceType<typeof File>) {
				if (this.uri.includes(".tmp-")) {
					// Simulate: original file was already deleted, now move fails
					throw new Error("Simulated disk failure during move")
				}

				return originalMove.call(this, dest)
			}

			try {
				vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
					if (destination instanceof File) {
						destination.write(new Uint8Array([1, 2, 3]))
					}

					return { files: [], directories: [] }
				})

				// storeFile calls atomicWrite for the meta file — which will fail
				await expect(offline.storeFile({ file: fileItem, parent })).rejects.toThrow("Simulated disk failure during move")

				// Verify no .tmp files are left behind
				for (const key of fs.keys()) {
					expect(key).not.toContain(".tmp-")
				}
			} finally {
				File.prototype.move = originalMove
			}
		})

		it("readIndex recovers from a valid serialized encoding of empty object", async () => {
			// Write valid serialized form of {} — keys length 0 triggers the "Index file is empty" check
			fs.set(BASE_DIR_URI, "dir")
			fs.set(FILES_DIR_URI, "dir")
			fs.set(DIRECTORIES_DIR_URI, "dir")

			writeIndex({} as unknown as Index)

			const offline = await createOffline()
			const stored = await offline.isItemStored(makeFileItem("11111111-1111-1111-1111-111111111111", "test.txt"))

			// Should not throw — empty index decoded, treated as invalid, file deleted, empty index returned
			expect(stored).toBe(false)

			// Corrupt index file should be deleted
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})

		it("readDirectoryMeta returns null for zero-length meta file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"

			// Write a zero-length meta file
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`, new Uint8Array([]))

			const offline = await createOffline()
			const result = await offline.listDirectories()

			// Zero-length meta should be skipped — directory should not appear
			expect(result.directories).toHaveLength(0)
		})

		it("listFiles skips entries where meta has non-file item type", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Write a data file AND meta file, but meta contains a directory item type
			const dirItem = makeDirItem(uuid, "actually-a-dir")

			writeFileData(uuid, "actually-a-dir")
			writeFileMeta(uuid, { item: dirItem, parent })

			const offline = await createOffline()
			const files = await offline.listFiles()

			// Should be skipped because meta.item.type is "directory", not "file"
			expect(files).toHaveLength(0)
		})
	})

	describe("sharedInRoot parent integration", () => {
		beforeEach(() => {
			fs.clear()
			vi.clearAllMocks()
		})

		it("storeFile persists sharedInRoot parent in meta", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "shared-root-file.txt")

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([10, 20, 30]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await offline.storeFile({ file: fileItem, parent: "sharedInRoot" })

			// Meta file should exist
			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`

			expect(fs.get(metaUri)).toBeInstanceOf(Uint8Array)

			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as FileOrDirectoryOfflineMeta

			expect(meta.parent).toBe("sharedInRoot")

			// Index should be updated
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)

			const index = deserialize(new TextDecoder().decode(fs.get(INDEX_FILE_URI) as Uint8Array)) as Index

			expect(index.files[uuid]).toBeDefined()
			expect(index.files[uuid]!.parent).toBe("sharedInRoot")
		})

		it("storeDirectory persists sharedInRoot parent in meta", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "shared-root-dir")

			mockListing({
				files: [makeListingFile("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "readme.md", "readme.md", 2n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/readme.md`, new Uint8Array([1, 2]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent: "sharedInRoot" })

			// Meta file should exist
			const metaUri = `${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`

			expect(fs.get(metaUri)).toBeInstanceOf(Uint8Array)

			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as DirectoryOfflineMeta

			expect(meta.parent).toBe("sharedInRoot")
		})

		it("listFiles returns sharedInRoot as the parent", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "shared-listed.txt")

			writeFileData(uuid, "shared-listed.txt")
			writeFileMeta(uuid, { item: fileItem, parent: "sharedInRoot" })

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toHaveLength(1)
			expect(files[0].item.data.uuid).toBe(uuid)
			expect(files[0].parent).toBe("sharedInRoot")
		})

		it("listDirectories with sharedInRoot parent returns empty results", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "shared-file.txt")

			writeFileData(uuid, "shared-file.txt")
			writeFileMeta(uuid, { item: fileItem, parent: "sharedInRoot" })

			const offline = await createOffline()

			await offline.updateIndex()

			const result = await offline.listDirectories("sharedInRoot")

			expect(result.files).toEqual([])
			expect(result.directories).toEqual([])
		})
	})

	describe("edge case coverage", () => {
		it("isItemStored returns true for sharedRootFile type", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const sharedRootFileItem = {
				type: "sharedRootFile",
				data: {
					uuid,
					decryptedMeta: { name: "shared-root.txt", size: 50n, modified: 1000, created: 900 },
					undecryptable: false
				}
			} as unknown as DriveItem

			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "shared-root.txt")
			writeFileMeta(uuid, { item: sharedRootFileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(sharedRootFileItem)).toBe(true)
		})

		it("storeDirectory handles null download result (abort) gracefully", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "NullDownload")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// One missing remote entry so the download path is taken at all.
			mockListing({
				files: [makeListingFile("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "a.txt", "a.txt", 1n)]
			})

			// Mock download to return undefined (aborted transfer)
			vi.mocked(transfers.download).mockImplementationOnce(async () => {
				return undefined as any
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent, skipIndexUpdate: true })

			// Nothing is committed on an aborted download — no meta, no index, and the partial
			// tree dir is cleaned up (an aborted initial store leaves zero residue).
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(false)
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("listFiles skips entries where meta file is missing but data file exists", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"

			// Write only the data file — no meta file
			writeFileData(uuid, "orphan-data.txt")

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toHaveLength(0)
		})

		it("listFiles skips entries where meta file has zero size", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"

			// Write data file
			writeFileData(uuid, "zero-meta.txt")

			// Write zero-byte meta file
			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`

			fs.set(`${FILES_DIR_URI}/${uuid}`, "dir")
			fs.set(metaUri, new Uint8Array([]))

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toHaveLength(0)
		})

		it("readDirectoryMeta returns null for valid serialized empty object", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"

			// Write a valid serialized encoding of {} (empty object)
			// This triggers the Object.keys(meta).length === 0 check
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/${uuid}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize({}))))

			const offline = await createOffline()
			const result = await offline.listDirectories()

			// Empty object meta should be skipped — directory should not appear
			expect(result.directories).toHaveLength(0)
		})

		it("readIndex handles zero-byte index file", async () => {
			// Write a zero-byte file at the index file path
			fs.set(BASE_DIR_URI, "dir")
			fs.set(FILES_DIR_URI, "dir")
			fs.set(DIRECTORIES_DIR_URI, "dir")
			fs.set(INDEX_FILE_URI, new Uint8Array([]))

			const offline = await createOffline()

			// Should not crash — zero-byte index triggers early return with empty index
			const stored = await offline.isItemStored(makeFileItem("11111111-1111-1111-1111-111111111111", "test.txt"))

			expect(stored).toBe(false)
		})

		it("findParentAnyDirWithContext returns null for file-type item in path", async () => {
			const topUuid = "11111111-1111-1111-1111-111111111111"
			const childFileUuid = "22222222-2222-2222-2222-222222222222"
			const nestedFileUuid = "33333333-3333-3333-3333-333333333333"
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			// Create a directory where one of the entries at a dirname position is a file, not a directory.
			// Put a file at path "/fakedir" and a file at path "/fakedir/nested.txt".
			// When listDirectories tries to find the parent for "/fakedir/nested.txt" it looks up
			// pathToItem["/fakedir"] — which is a file item. findParentAnyDirWithContext returns null,
			// so the nested entry is skipped.
			const fakeDir = makeFileItem(childFileUuid, "fakedir")
			const nestedFile = makeFileItem(nestedFileUuid, "nested.txt")

			writeDirectoryMeta(topUuid, {
				item: makeDirItem(topUuid, "Root"),
				parent,
				entries: makeEntries({
					"/fakedir": fakeDir,
					"/fakedir/nested.txt": nestedFile
				})
			})

			const offline = await createOffline()

			// List children of the top-level directory
			const topParent = new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid: topUuid } as unknown as Dir))
			const result = await offline.listDirectories(topParent)

			// "/fakedir" is a file type, so it appears in files but does NOT populate pathToItem.
			// "/fakedir/nested.txt" has dirname "/fakedir" which matches targetPath "/" => no,
			// its dirname is "/fakedir" not "/". But the direct children are at dirname "/".
			// Since "/fakedir" is a file type at the top level (dirname "/"), it shows as a file.
			// "/fakedir/nested.txt" has dirname "/fakedir" != "/" so it won't be a direct child.
			// The key test: if we list the children of the sub-level...
			// Actually the file at "/fakedir" won't be put into pathToItem (only dirs go there).
			// So if we try listing children of childFileUuid, no path maps to it => empty result.
			expect(result.files).toHaveLength(1)
			expect(result.files[0].item.data.uuid).toBe(childFileUuid)
			expect(result.directories).toHaveLength(0)

			// Now try listing children of the fake "directory" which is actually a file.
			// Since it's a file, it has no entry in pathToItem, so targetPath is undefined => empty.
			const fakeParent = new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid: childFileUuid } as unknown as Dir))
			const nestedResult = await offline.listDirectories(fakeParent)

			// The nested file under "/fakedir/nested.txt" should be skipped because
			// pathToItem["/fakedir"] doesn't exist (only dir types are added to pathToItem)
			expect(nestedResult.files).toHaveLength(0)
			expect(nestedResult.directories).toHaveLength(0)
		})
	})

	describe("overlap deduplication", () => {
		beforeEach(() => {
			fs.clear()
			vi.clearAllMocks()
		})

		it("removes standalone directory when parent is stored", async () => {
			const parentDirUuid = "11111111-1111-1111-1111-111111111111"
			const childDirUuid = "22222222-2222-2222-2222-222222222222"
			const parentDirItem = makeDirItem(parentDirUuid, "ParentDir")
			const childDirItem = makeDirItem(childDirUuid, "ChildDir")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")
			const parentDataUri = `${DIRECTORIES_DIR_URI}/${parentDirUuid}`

			// Store child directory standalone first
			writeDirectoryMeta(childDirUuid, {
				item: childDirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(childDirItem)).toBe(true)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${childDirUuid}`)).toBe(true)

			// Now store the parent directory, whose remote listing contains the child
			mockListing({
				dirs: [makeListingDir(childDirUuid, "ChildDir", "ChildDir")]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/ChildDir`, "dir")

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			await offline.storeDirectory({ directory: parentDirItem, parent })

			// Standalone child directory should be deleted
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${childDirUuid}/${childDirUuid}.filenmeta`)).toBe(false)

			// Parent should exist
			expect(fs.has(`${parentDataUri}/${parentDirUuid}.filenmeta`)).toBe(true)
		})

		it("removes standalone file when parent is stored", async () => {
			const parentDirUuid = "11111111-1111-1111-1111-111111111111"
			const childFileUuid = "22222222-2222-2222-2222-222222222222"
			const parentDirItem = makeDirItem(parentDirUuid, "ParentDir")
			const childFileItem = makeFileItem(childFileUuid, "child.txt")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			// Store file standalone first
			writeFileData(childFileUuid, "child.txt")
			writeFileMeta(childFileUuid, { item: childFileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(childFileItem)).toBe(true)
			expect(fs.has(`${FILES_DIR_URI}/${childFileUuid}`)).toBe(true)

			// Now store the parent directory, whose remote listing contains the file
			mockListing({
				files: [makeListingFile(childFileUuid, "child.txt", "child.txt", 3n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/child.txt`, new Uint8Array([1, 2, 3]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			await offline.storeDirectory({ directory: parentDirItem, parent })

			// Standalone file directory should be deleted
			expect(fs.has(`${FILES_DIR_URI}/${childFileUuid}`)).toBe(false)
		})

		it("index reflects deduplicated state after parent store", async () => {
			const parentDirUuid = "11111111-1111-1111-1111-111111111111"
			const childDirUuid = "22222222-2222-2222-2222-222222222222"
			const childFileUuid = "33333333-3333-3333-3333-333333333333"
			const parentDirItem = makeDirItem(parentDirUuid, "ParentDir")
			const childDirItem = makeDirItem(childDirUuid, "ChildDir")
			const childFileItem = makeFileItem(childFileUuid, "child.txt")
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			// Store child dir and file standalone
			writeDirectoryMeta(childDirUuid, {
				item: childDirItem,
				parent,
				entries: {}
			})

			writeFileData(childFileUuid, "child.txt")
			writeFileMeta(childFileUuid, { item: childFileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Now store parent whose remote listing contains both
			mockListing({
				files: [makeListingFile(childFileUuid, "child.txt", "child.txt", 3n)],
				dirs: [makeListingDir(childDirUuid, "ChildDir", "ChildDir")]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/ChildDir`, "dir")
				fs.set(`${destUri}/child.txt`, new Uint8Array([1, 2, 3]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			await offline.storeDirectory({ directory: parentDirItem, parent })

			// Standalone copies should be gone
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${childDirUuid}/${childDirUuid}.filenmeta`)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${childFileUuid}`)).toBe(false)

			// Index should have the parent directory
			const index = readIndex()

			expect(index.directories[parentDirUuid]).toBeDefined()

			// Parent meta should contain both child entries
			const metaUri = `${DIRECTORIES_DIR_URI}/${parentDirUuid}/${parentDirUuid}.filenmeta`
			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as DirectoryOfflineMeta
			const entryUuids = Object.values(meta.entries).map(e => e.item.data.uuid)

			expect(entryUuids).toContain(childDirUuid)
			expect(entryUuids).toContain(childFileUuid)
		})

		it("deeply nested: all standalone copies removed", async () => {
			const dirAUuid = "11111111-1111-1111-1111-111111111111"
			const dirBUuid = "22222222-2222-2222-2222-222222222222"
			const dirCUuid = "33333333-3333-3333-3333-333333333333"
			const dirA = makeDirItem(dirAUuid, "A")
			const dirB = makeDirItem(dirBUuid, "B")
			const dirC = makeDirItem(dirCUuid, "C")
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			// Store C standalone
			writeDirectoryMeta(dirCUuid, {
				item: dirC,
				parent,
				entries: {}
			})

			// Store B standalone
			writeDirectoryMeta(dirBUuid, {
				item: dirB,
				parent,
				entries: makeEntries({
					"/C": dirC
				})
			})

			const offline = await createOffline()

			await offline.updateIndex()

			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirCUuid}/${dirCUuid}.filenmeta`)).toBe(true)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirBUuid}/${dirBUuid}.filenmeta`)).toBe(true)

			// Now store A whose remote listing contains B > C
			mockListing({
				dirs: [makeListingDir(dirBUuid, "B", "B"), makeListingDir(dirCUuid, "B/C", "C")]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(`${destUri}/B`, "dir")
				fs.set(`${destUri}/B/C`, "dir")

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			await offline.storeDirectory({ directory: dirA, parent })

			// Both standalone copies should be removed
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirBUuid}/${dirBUuid}.filenmeta`)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirCUuid}/${dirCUuid}.filenmeta`)).toBe(false)

			// A should exist
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirAUuid}/${dirAUuid}.filenmeta`)).toBe(true)
		})

		it("listDirectoriesRecursive returns no duplicates with overlapping data", async () => {
			const dirAUuid = "11111111-1111-1111-1111-111111111111"
			const dirBUuid = "22222222-2222-2222-2222-222222222222"
			const fileUuid = "33333333-3333-3333-3333-333333333333"
			const dirA = makeDirItem(dirAUuid, "A")
			const dirB = makeDirItem(dirBUuid, "B")
			const fileItem = makeFileItem(fileUuid, "data.txt")
			const parent = makeParent("44444444-4444-4444-4444-444444444444")

			// Simulate legacy state: both A and B are top-level, A contains B as a nested entry
			writeDirectoryMeta(dirAUuid, {
				item: dirA,
				parent,
				entries: makeEntries({
					"/B": dirB,
					"/B/data.txt": fileItem
				})
			})

			writeDirectoryMeta(dirBUuid, {
				item: dirB,
				parent,
				entries: makeEntries({
					"/data.txt": fileItem
				})
			})

			const offline = await createOffline()
			const result = await offline.listDirectoriesRecursive()

			// B should appear only once (dedup)
			const dirBEntries = result.directories.filter((d: { item: DriveItem }) => d.item.data.uuid === dirBUuid)

			expect(dirBEntries).toHaveLength(1)

			// data.txt should appear only once (dedup)
			const fileEntries = result.files.filter((f: { item: DriveItem }) => f.item.data.uuid === fileUuid)

			expect(fileEntries).toHaveLength(1)
		})

		it("listDirectoriesRecursive returns no duplicates after cleanup", async () => {
			const dirAUuid = "11111111-1111-1111-1111-111111111111"
			const dirBUuid = "22222222-2222-2222-2222-222222222222"
			const dirA = makeDirItem(dirAUuid, "A")
			const dirB = makeDirItem(dirBUuid, "B")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			// After cleanup, only A exists on disk as top-level, with B as an entry
			// Write A with B as a nested entry (using properly formatted paths)
			writeDirectoryMeta(dirAUuid, {
				item: dirA,
				parent,
				entries: makeEntries({
					"/B": dirB
				})
			})

			const offline = await createOffline()
			const result = await offline.listDirectoriesRecursive()

			// A appears once as top-level, B appears once as nested entry
			const dirAEntries = result.directories.filter((d: { item: DriveItem }) => d.item.data.uuid === dirAUuid)
			const dirBEntries = result.directories.filter((d: { item: DriveItem }) => d.item.data.uuid === dirBUuid)

			expect(dirAEntries).toHaveLength(1)
			expect(dirBEntries).toHaveLength(1)
		})

		it("storeFile is no-op when file is inside stored parent", async () => {
			const parentDirUuid = "11111111-1111-1111-1111-111111111111"
			const childFileUuid = "22222222-2222-2222-2222-222222222222"
			const parentDirItem = makeDirItem(parentDirUuid, "ParentDir")
			const childFileItem = makeFileItem(childFileUuid, "child.txt")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			// Store parent directory with child file in entries
			writeDirectoryMeta(parentDirUuid, {
				item: parentDirItem,
				parent,
				entries: makeEntries({
					"/child.txt": childFileItem
				})
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${parentDirUuid}/child.txt`, new Uint8Array([1, 2, 3]))

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(transfers.download).mockClear()

			// Try to store the child file standalone — should be a no-op that still reports stored
			// (the file IS available offline inside its parent tree).
			await expect(offline.storeFile({ file: childFileItem, parent })).resolves.toBe(true)

			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("storeDirectory is no-op when dir is inside stored parent", async () => {
			const parentDirUuid = "11111111-1111-1111-1111-111111111111"
			const childDirUuid = "22222222-2222-2222-2222-222222222222"
			const parentDirItem = makeDirItem(parentDirUuid, "ParentDir")
			const childDirItem = makeDirItem(childDirUuid, "ChildDir")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			// Store parent directory with child dir in entries
			writeDirectoryMeta(parentDirUuid, {
				item: parentDirItem,
				parent,
				entries: makeEntries({
					"/ChildDir": childDirItem
				})
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${parentDirUuid}/ChildDir`, "dir")

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(transfers.download).mockClear()

			// Try to store the child directory standalone — should be a no-op
			await offline.storeDirectory({ directory: childDirItem, parent })

			expect(transfers.download).not.toHaveBeenCalled()
		})
	})

	describe("orphan sweep — degraded-listing safety (OF-01)", () => {
		const topUuid = "aa000000-0000-0000-0000-0000000000aa"
		const keepUuid = "bb000000-0000-0000-0000-0000000000bb"

		function setupBrokenTreeWithUnlistedSubtree(): { dirItem: DriveItem; parent: ReturnType<typeof makeParent> } {
			const dirItem = makeDirItem(topUuid, "BrokenTree")
			const parent = makeParent("cc000000-0000-0000-0000-0000000000cc")

			// A stored tree whose .filenmeta is MISSING (the broken-tree state healBrokenTrees repairs)
			// → readDirectoryMeta returns null → metaWasUnreadable, existingEntries empty.
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}`, "dir")
			// The entry the listing WILL return — its bytes are present so verify-after-download passes.
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}/keep.txt`, new Uint8Array([1, 2, 3]))
			// An on-disk subtree the listing OMITS. The orphan sweep deletes on absence from the
			// committed keep-set — this is the data the bug silently destroyed.
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}/SubA`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${topUuid}/SubA/orphan.txt`, new Uint8Array([9, 9, 9]))

			return { dirItem, parent }
		}

		it("does NOT sweep an unlisted on-disk subtree on a DEGRADED pass over a broken (meta-less) tree", async () => {
			const { dirItem, parent } = setupBrokenTreeWithUnlistedSubtree()

			// Degraded listing returns ONLY keep.txt — SubA is silently absent (scan error).
			mockDegradedListing({ files: [makeListingFile(keepUuid, "keep.txt", "keep.txt", 3n)] })

			const offline = await createOffline()

			await offline.reconcileTree({ directory: dirItem, parent })

			// The unlisted subtree's bytes MUST survive — a degraded listing's absences are not
			// evidence of deletion, and the verified-union can't protect them (meta unreadable).
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${topUuid}/SubA/orphan.txt`)).toBe(true)
			// The listed entry is still kept.
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${topUuid}/keep.txt`)).toBe(true)
		})

		it("STILL sweeps an unlisted on-disk subtree on a CLEAN pass over a broken (meta-less) tree", async () => {
			const { dirItem, parent } = setupBrokenTreeWithUnlistedSubtree()

			// Clean listing (no scan error) → absences ARE authoritative → orphan cleanup proceeds.
			mockListing({ files: [makeListingFile(keepUuid, "keep.txt", "keep.txt", 3n)] })

			const offline = await createOffline()

			await offline.reconcileTree({ directory: dirItem, parent })

			// The fix only DEFERS the sweep on degraded passes; on a clean pass it still removes the
			// genuinely-orphaned subtree.
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${topUuid}/SubA/orphan.txt`)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${topUuid}/keep.txt`)).toBe(true)
		})
	})

	describe("updateIndex / clearBarrier participation (OF-02)", () => {
		it("updateIndex() participates in the clearBarrier — it waits behind an active exclusive clear", async () => {
			const offline = await createOffline()
			const barrier = (offline as unknown as { clearBarrier: { runExclusive: (fn: () => Promise<void>) => Promise<void> } }).clearBarrier

			const order: string[] = []
			let releaseExclusive!: () => void
			const exclusiveGate = new Promise<void>(resolve => {
				releaseExclusive = resolve
			})

			// Hold the barrier exclusively, exactly as clearAll() does while it wipes the directory.
			const exclusive = barrier.runExclusive(async () => {
				await exclusiveGate

				order.push("exclusive")
			})

			// updateIndex must block on clearBarrier.enter() until the exclusive section finishes —
			// otherwise its disk-scan-then-write could resurrect a stale index after a wipe.
			const update = offline.updateIndex().then(() => {
				order.push("updateIndex")
			})

			// Give the (unblocked) buggy path a full macrotask to wrongly finish first.
			await new Promise(resolve => setTimeout(resolve, 0))

			releaseExclusive()

			await Promise.all([exclusive, update])

			expect(order).toEqual(["exclusive", "updateIndex"])
		})

		it("the in-barrier index rebuild does NOT take the clearBarrier (an in-barrier caller can't deadlock a clear)", async () => {
			const offline = await createOffline()
			const barrier = (offline as unknown as { clearBarrier: { runExclusive: (fn: () => Promise<void>) => Promise<void> } }).clearBarrier

			let releaseExclusive!: () => void
			const exclusiveGate = new Promise<void>(resolve => {
				releaseExclusive = resolve
			})

			const exclusive = barrier.runExclusive(async () => {
				await exclusiveGate
			})

			// rebuildIndex() is what reconcileTree/storeFile/removeItem call WHILE already holding the
			// barrier — it must run to completion even while a clear is exclusive, or those callers
			// would deadlock a queued clearAll (runExclusive waits for them to drain while they block
			// on enter()).
			let rebuildDone = false
			const rebuild = (offline as unknown as { rebuildIndex: () => Promise<void> }).rebuildIndex().then(() => {
				rebuildDone = true
			})

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(rebuildDone).toBe(true)

			releaseExclusive()

			await Promise.all([exclusive, rebuild])
		})
	})

	describe("clearAll", () => {
		it("deletes every offline file and directory, then rebuilds an empty index", async () => {
			const fileUuid = "ff111111-ffff-1111-ffff-111111111111"
			const dirUuid = "dd222222-dddd-2222-dddd-222222222222"
			const fileItem = makeFileItem(fileUuid, "doc.txt")
			const dirItem = makeDirItem(dirUuid, "Folder")
			const parent = makeParent("00000000-0000-0000-0000-000000000000")

			writeFileMeta(fileUuid, { item: fileItem, parent })
			writeFileData(fileUuid, "doc.txt")
			writeDirectoryMeta(dirUuid, { item: dirItem, parent, entries: {} })

			const offline = await createOffline()

			await offline.updateIndex()
			await offline.clearAll()

			expect(fs.has(`${FILES_DIR_URI}/${fileUuid}`)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}`)).toBe(false)
			expect(fs.get(FILES_DIR_URI)).toBe("dir")
			expect(fs.get(DIRECTORIES_DIR_URI)).toBe("dir")

			const index = readIndex()

			expect(Object.keys(index.files).length).toBe(0)
			expect(Object.keys(index.directories).length).toBe(0)
		})

		it("is idempotent — calling on an empty store does not throw", async () => {
			const offline = await createOffline()

			await expect(offline.clearAll()).resolves.toBeUndefined()
			await expect(offline.clearAll()).resolves.toBeUndefined()
			expect(fs.get(FILES_DIR_URI)).toBe("dir")
			expect(fs.get(DIRECTORIES_DIR_URI)).toBe("dir")
		})

		// Regression (bug #4): a meta written by the old sync() rename branch had only
		// {item, parent} — no `entries` field. Object.values(meta.entries) threw a
		// TypeError, preventing clearAll() from completing and leaving orphaned disk usage
		// that could never be reclaimed from the UI.
		it("does not crash when a directory meta is missing the entries field (legacy corrupt meta)", async () => {
			const dirUuid = "dd333333-dddd-3333-dddd-333333333333"
			const dirItem = makeDirItem(dirUuid, "CorruptMeta")
			const parent = makeParent("00000000-0000-0000-0000-000000000001")

			// Write a meta that deliberately omits the `entries` field, simulating
			// what the old sync() rename branch wrote ({item, parent} only).
			const corruptMeta = { item: dirItem, parent }

			const metaUri = `${DIRECTORIES_DIR_URI}/${dirUuid}/${dirUuid}.filenmeta`

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}`, "dir")
			fs.set(metaUri, new Uint8Array(new TextEncoder().encode(serialize(corruptMeta))))

			const offline = await createOffline()

			await offline.updateIndex()

			// clearAll must not throw even though meta.entries is undefined
			await expect(offline.clearAll()).resolves.not.toThrow()

			// After clearAll the directory should be gone
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}`)).toBe(false)
		})

		it("calls driveItemStoredOfflineQueryUpdate(false) for every stored item after clearAll", async () => {
			const fileUuid = "ff111111-ffff-1111-ffff-111111111111"
			const dirUuid = "dd222222-dddd-2222-dddd-222222222222"
			const fileItem = makeFileItem(fileUuid, "doc.txt")
			const dirItem = makeDirItem(dirUuid, "Folder")
			const parent = makeParent("00000000-0000-0000-0000-000000000000")

			writeFileMeta(fileUuid, { item: fileItem, parent })
			writeFileData(fileUuid, "doc.txt")
			writeDirectoryMeta(dirUuid, { item: dirItem, parent, entries: {} })

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(driveItemStoredOfflineQueryUpdate).mockClear()

			await offline.clearAll()

			const calls = vi.mocked(driveItemStoredOfflineQueryUpdate).mock.calls
			const falseCalls = calls.filter(([arg]) => arg.updater === false)
			const invalidatedUuids = falseCalls.map(([arg]) => arg.params.uuid)

			// Both items must be broadcast as no-longer-offline
			expect(invalidatedUuids).toContain(fileUuid)
			expect(invalidatedUuids).toContain(dirUuid)
		})
	})

	describe("size", () => {
		it("returns zero counts when nothing is stored", async () => {
			const offline = await createOffline()

			const result = await offline.size()

			expect(result.size).toBe(0)
			expect(result.files).toBe(0)
			expect(result.dirs).toBe(0)
		})

		it("counts indexed entries and sums all on-disk bytes", async () => {
			const fileUuid = "11111111-1111-1111-1111-111111111111"
			const dirUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(fileUuid, "doc.txt")
			const dirItem = makeDirItem(dirUuid, "Folder")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			writeFileMeta(fileUuid, { item: fileItem, parent })
			writeFileData(fileUuid, "doc.txt", new Uint8Array(new Array(10).fill(0)))
			writeDirectoryMeta(dirUuid, { item: dirItem, parent, entries: {} })

			// Add a nested file under the stored directory to simulate the recursive walk.
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/nested.bin`, new Uint8Array(new Array(20).fill(0)))

			const offline = await createOffline()

			await offline.updateIndex()

			const result = await offline.size()

			expect(result.files).toBe(1)
			expect(result.dirs).toBe(1)
			// size includes every file under files/ and directories/ (data + sidecars).
			expect(result.size).toBeGreaterThanOrEqual(10 + 20)
		})
	})

	// Tests for finding #166: verify that the @/lib/sdkUnwrap mock stubs return the
	// same shape that offline.ts relies on. Each assertion targets only the fields
	// that offline.ts actually reads — not the full real API — so the tests protect
	// against drift without re-implementing the real tag-switching logic.
	describe("sdkUnwrap mock contract alignment (finding #166)", () => {
		it("unwrapFileMeta: Decoded tag yields non-null meta with correct fields", async () => {
			const { unwrapFileMeta } = await import("@/lib/sdkUnwrap")
			const input = {
				uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
				meta: { tag: "Decoded", inner: [{ name: "report.pdf", size: 500n, modified: 2000, created: 1000 }] }
			}

			const result = vi.mocked(unwrapFileMeta)(input as any)

			// offline.ts checks result.meta !== null before using name / modified
			expect(result.meta).not.toBeNull()
			expect(result.meta?.name).toBe("report.pdf")
			expect(result.meta?.modified).toBe(2000)
			// offline.ts reads result.file.uuid for UUID-based map lookups
			expect(result.file).toBe(input)
			expect((result.file as unknown as typeof input).uuid).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
		})

		it("unwrapFileMeta: non-Decoded tag yields null meta (undecryptable path)", async () => {
			const { unwrapFileMeta } = await import("@/lib/sdkUnwrap")
			const input = {
				uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
				meta: { tag: "Encrypted", inner: ["ciphertext"] }
			}

			const result = vi.mocked(unwrapFileMeta)(input as any)

			// offline.ts guards: if (!unwrapped.meta) { continue }
			expect(result.meta).toBeNull()
			expect(result.undecryptable).toBe(true)
		})

		it("unwrapDirMeta: Decoded tag yields non-null meta with name and uuid", async () => {
			const { unwrapDirMeta } = await import("@/lib/sdkUnwrap")
			const input = {
				uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
				meta: { tag: "Decoded", inner: [{ name: "ProjectDir" }] }
			}

			const result = vi.mocked(unwrapDirMeta)(input as any)

			// offline.ts reads result.meta?.name and result.uuid
			expect(result.meta).not.toBeNull()
			expect(result.meta?.name).toBe("ProjectDir")
			expect(result.uuid).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc")
		})

		it("unwrapDirMeta: non-Decoded tag yields null meta", async () => {
			const { unwrapDirMeta } = await import("@/lib/sdkUnwrap")
			const input = {
				uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
				meta: { tag: "Encrypted", inner: ["blob"] }
			}

			const result = vi.mocked(unwrapDirMeta)(input as any)

			// offline.ts guards: if (!unwrapped.meta) { continue }
			expect(result.meta).toBeNull()
			expect(result.undecryptable).toBe(true)
			// uuid is still returned even for undecryptable dirs
			expect(result.uuid).toBe("dddddddd-dddd-dddd-dddd-dddddddddddd")
		})

		it("unwrappedFileIntoDriveItem: produces type:'file' DriveItem with correct uuid and decryptedMeta", async () => {
			const { unwrapFileMeta, unwrappedFileIntoDriveItem } = await import("@/lib/sdkUnwrap")
			const sdkFile = {
				uuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
				meta: { tag: "Decoded", inner: [{ name: "data.csv", size: 1024n, modified: 3000, created: 2000 }] }
			}

			const unwrapped = vi.mocked(unwrapFileMeta)(sdkFile as any)
			const driveItem = vi.mocked(unwrappedFileIntoDriveItem)(unwrapped as any)

			// offline.ts uses driveItem.type and driveItem.data.uuid / driveItem.data.decryptedMeta
			expect(driveItem.type).toBe("file")
			expect(driveItem.data.uuid).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
			expect(driveItem.data.decryptedMeta?.name).toBe("data.csv")
		})

		it("unwrappedFileIntoDriveItem: null meta yields null decryptedMeta (undecryptable file)", async () => {
			const { unwrappedFileIntoDriveItem } = await import("@/lib/sdkUnwrap")
			const unwrapped = {
				file: { uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
				meta: null,
				undecryptable: true,
				shared: false,
				root: false
			}

			const driveItem = vi.mocked(unwrappedFileIntoDriveItem)(unwrapped as any)

			expect(driveItem.type).toBe("file")
			expect(driveItem.data.decryptedMeta).toBeNull()
			expect(driveItem.data.undecryptable).toBe(true)
		})

		it("unwrappedDirIntoDriveItem: produces type:'directory' DriveItem with correct uuid and name", async () => {
			const { unwrapDirMeta, unwrappedDirIntoDriveItem } = await import("@/lib/sdkUnwrap")
			const sdkDir = {
				uuid: "11111111-2222-3333-4444-555555555555",
				meta: { tag: "Decoded", inner: [{ name: "Archive" }] }
			}

			const unwrapped = vi.mocked(unwrapDirMeta)(sdkDir as any)
			const driveItem = vi.mocked(unwrappedDirIntoDriveItem)(unwrapped as any)

			expect(driveItem.type).toBe("directory")
			expect(driveItem.data.uuid).toBe("11111111-2222-3333-4444-555555555555")
			expect(driveItem.data.decryptedMeta?.name).toBe("Archive")
		})

		it("unwrappedDirIntoDriveItem: null meta yields null decryptedMeta (undecryptable dir)", async () => {
			const { unwrappedDirIntoDriveItem } = await import("@/lib/sdkUnwrap")
			const unwrapped = {
				dir: { uuid: "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb" },
				uuid: "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb",
				meta: null,
				undecryptable: true,
				shared: false
			}

			const driveItem = vi.mocked(unwrappedDirIntoDriveItem)(unwrapped as any)

			expect(driveItem.type).toBe("directory")
			expect(driveItem.data.decryptedMeta).toBeNull()
			expect(driveItem.data.undecryptable).toBe(true)
		})

		it("unwrapAnyDirUuid: Normal.Dir path extracts uuid from inner[0].inner[0].uuid", async () => {
			const { unwrapAnyDirUuid } = await import("@/lib/sdkUnwrap")
			// Matches the shape produced by makeParent(): AnyDirWithContext.Normal(AnyNormalDir.Dir({uuid}))
			// tag: "Normal", inner: [AnyNormalDir.Dir], inner[0].inner: [Dir { uuid }]
			const normalDir = {
				tag: "Normal",
				inner: [{ tag: "Dir", inner: [{ uuid: "99999999-8888-7777-6666-555555555555" }] }]
			}

			const uuid = vi.mocked(unwrapAnyDirUuid)(normalDir as any)

			// offline.ts uses this uuid to resolve parents during sync
			expect(uuid).toBe("99999999-8888-7777-6666-555555555555")
		})

		it("unwrapAnyDirUuid: null/undefined input returns null (not a uuid)", async () => {
			const { unwrapAnyDirUuid } = await import("@/lib/sdkUnwrap")

			expect(vi.mocked(unwrapAnyDirUuid)(null as any)).toBeNull()
			expect(vi.mocked(unwrapAnyDirUuid)(undefined as any)).toBeNull()
		})
	})

	describe("isItemStoredSync", () => {
		it("returns undefined when the cache is cold (before any isItemStored call)", async () => {
			const offline = await createOffline()
			const item = makeFileItem("11111111-1111-1111-1111-111111111111", "cold-cache.txt")

			// No isItemStored or updateIndex has run — cache is empty.
			expect(offline.isItemStoredSync(item)).toBeUndefined()
		})

		it("returns false for an item that is not in the index after cache is warmed", async () => {
			writeIndex({ files: {}, directories: {} })

			const offline = await createOffline()
			const item = makeFileItem("99999999-9999-9999-9999-999999999999", "absent.txt")

			// Warm the cache by checking a specific (absent) item.
			await offline.isItemStored(item)

			expect(offline.isItemStoredSync(item)).toBe(false)
		})

		it("returns true for a file after isItemStored populates the cache", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "warm.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			const offline = await createOffline()

			// Async variant warms the isItemStoredCache.
			expect(await offline.isItemStored(fileItem)).toBe(true)

			// Sync variant must now return the cached value, not re-read disk.
			expect(offline.isItemStoredSync(fileItem)).toBe(true)
		})
	})

	describe("storeFile signal propagation", () => {
		it("passes the signal to transfers.download", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "signaled.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			let capturedSignal: AbortSignal | undefined

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination, signal: s }) => {
				capturedSignal = s

				if (destination instanceof File) {
					destination.write(new Uint8Array([1, 2, 3]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()
			const controller = new AbortController()

			await offline.storeFile({ file: fileItem, parent, signal: controller.signal })

			// The exact same AbortSignal instance must have been forwarded to the download.
			expect(capturedSignal).toBe(controller.signal)
		})

		it("rejects with AbortError when called with an already-aborted signal", async () => {
			const uuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "aborted.txt")
			const parent = makeParent("33333333-3333-3333-3333-333333333333")

			vi.mocked(transfers.download).mockRejectedValueOnce(
				Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
			)

			const controller = new AbortController()

			controller.abort()

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent, signal: controller.signal })).rejects.toThrow(
				"The operation was aborted"
			)

			// The aborted download must have triggered cleanup — no partial directory left.
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
		})
	})

	describe("redownloadStandaloneFile", () => {
		const uuid = "11111111-1111-1111-1111-111111111111"
		const healParentUuid = "22222222-2222-2222-2222-222222222222"

		it("re-downloads to the exact data path, rewrites the meta, and invalidates caches", async () => {
			const fileItem = makeFileItem(uuid, "heal.txt")
			const parent = makeParent(healParentUuid)

			// Stored per meta + index, but the data file on disk is gone (heal scenario).
			writeFileMeta(uuid, { item: fileItem, parent })
			writeIndex({
				files: { [uuid]: { item: fileItem, parent } },
				directories: {}
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([7, 7, 7]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			// Warm the stored cache so we can observe invalidateCaches() afterwards.
			expect(await offline.isItemStored(fileItem)).toBe(true)

			await expect(offline.redownloadStandaloneFile({ item: fileItem, parent })).resolves.toBe(true)

			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(Array.from(fs.get(`${FILES_DIR_URI}/${uuid}/heal.txt`) as Uint8Array)).toEqual([7, 7, 7])

			// Meta was rewritten on success.
			const meta = deserialize(
				new TextDecoder().decode(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`) as Uint8Array)
			) as FileOrDirectoryOfflineMeta

			expect(meta.item.data.uuid).toBe(uuid)

			// Caches were invalidated after the heal.
			expect(offline.isItemStoredSync(fileItem)).toBeUndefined()
		})

		it("keeps the meta byte-identical and the data dir intact when the download fails", async () => {
			const fileItem = makeFileItem(uuid, "heal.txt")
			const parent = makeParent(healParentUuid)

			writeFileMeta(uuid, { item: fileItem, parent })

			const metaBefore = fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Network error"))

			const offline = await createOffline()

			await expect(offline.redownloadStandaloneFile({ item: fileItem, parent })).rejects.toThrow("Network error")

			// The meta survives byte-identical and the data dir is NOT deleted — the item stays
			// listed offline so the next sync pass retries the heal.
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(true)
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(metaBefore)
		})

		it("resolves false and leaves the meta untouched when the download aborts (null result)", async () => {
			const fileItem = makeFileItem(uuid, "heal.txt")
			const parent = makeParent(healParentUuid)

			writeFileMeta(uuid, { item: fileItem, parent })

			const metaBefore = fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)

			vi.mocked(transfers.download).mockResolvedValueOnce(null as any)

			const offline = await createOffline()

			await expect(offline.redownloadStandaloneFile({ item: fileItem, parent })).resolves.toBe(false)

			expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(metaBefore)
		})

		it("removes a stale old-name data file while the meta survives (renamed-stale cleanup)", async () => {
			const oldItem = makeFileItem(uuid, "old-name.txt")
			const renamedItem = makeFileItem(uuid, "new-name.txt")
			const parent = makeParent(healParentUuid)

			// Meta + data still carry the old name; the heal is called with the renamed item.
			writeFileMeta(uuid, { item: oldItem, parent })
			writeFileData(uuid, "old-name.txt")

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([1, 2]))
				}

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

			await offline.redownloadStandaloneFile({ item: renamedItem, parent })

			expect(fs.has(`${FILES_DIR_URI}/${uuid}/old-name.txt`)).toBe(false)
			expect(Array.from(fs.get(`${FILES_DIR_URI}/${uuid}/new-name.txt`) as Uint8Array)).toEqual([1, 2])

			const meta = deserialize(
				new TextDecoder().decode(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`) as Uint8Array)
			) as FileOrDirectoryOfflineMeta

			expect(meta.item.data.decryptedMeta?.name).toBe("new-name.txt")
		})

		it("throws for non-file items and missing decrypted meta", async () => {
			const offline = await createOffline()
			const parent = makeParent(healParentUuid)

			await expect(offline.redownloadStandaloneFile({ item: makeDirItem(uuid, "not-a-file"), parent })).rejects.toThrow(
				"Item not of type file"
			)

			const noMetaFile = {
				type: "file",
				data: {
					uuid,
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem

			await expect(offline.redownloadStandaloneFile({ item: noMetaFile, parent })).rejects.toThrow("File missing decrypted meta")
		})
	})

	describe("reconcileTree", () => {
		const treeUuid = "11111111-1111-1111-1111-111111111111"
		const parentUuid = "99999999-9999-9999-9999-999999999999"
		const fileAUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
		const fileBUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
		const subDirUuid = "cccccccc-cccc-cccc-cccc-cccccccccccc"
		const treeUri = `${DIRECTORIES_DIR_URI}/${treeUuid}`

		function seedTree({ entries, disk }: { entries: DirectoryOfflineMeta["entries"]; disk: Record<string, Uint8Array | "dir"> }): {
			dirItem: DriveItem
			parent: ReturnType<typeof makeParent>
		} {
			const dirItem = makeDirItem(treeUuid, "Tree")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(treeUuid, {
				item: dirItem,
				parent,
				entries
			})

			for (const relPath in disk) {
				const value = disk[relPath]

				if (value !== undefined) {
					fs.set(`${treeUri}${relPath}`, value)
				}
			}

			return { dirItem, parent }
		}

		function readTreeMeta(): DirectoryOfflineMeta {
			return deserialize(new TextDecoder().decode(fs.get(`${treeUri}/${treeUuid}.filenmeta`) as Uint8Array)) as DirectoryOfflineMeta
		}

		it("is a no-op fixed point when nothing changed (zero downloads, zero writes)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			// First pass establishes the canonical serialized meta (entry items come from the listing).
			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const firstErrors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(firstErrors).toEqual([])

			const metaAfterFirst = fs.get(`${treeUri}/${treeUuid}.filenmeta`)

			// Second pass with the identical listing must be a pure no-op: same meta bytes (by
			// reference — never rewritten), no download.
			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const secondErrors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(secondErrors).toEqual([])
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaAfterFirst)
			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("moves a renamed entry in place without downloading (uuid stable ⟹ identical bytes)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "old.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/old.txt": fileItem }),
				disk: { "/old.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			// Remote: same uuid, new path.
			mockListing({ files: [makeListingFile(fileAUuid, "new.txt", "new.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(`${treeUri}/old.txt`)).toBe(false)
			expect(Array.from(fs.get(`${treeUri}/new.txt`) as Uint8Array)).toEqual([1, 2, 3])

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/new.txt")
		})

		it("moves a nested entry into a renamed directory (two-phase, no download)", async () => {
			const subDirItem = makeDirItem(subDirUuid, "sub")
			const fileItem = makeFileItemWithSize(fileAUuid, "f.txt", 2n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/sub": subDirItem,
					"/sub/f.txt": fileItem
				}),
				disk: {
					"/sub": "dir",
					"/sub/f.txt": new Uint8Array([5, 6])
				}
			})

			const offline = await createOffline()

			// Remote: the directory was renamed sub → renamed; the child travels inside it.
			mockListing({
				files: [makeListingFile(fileAUuid, "renamed/f.txt", "f.txt", 2n)],
				dirs: [makeListingDir(subDirUuid, "renamed", "renamed")]
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.get(`${treeUri}/renamed`)).toBe("dir")
			expect(Array.from(fs.get(`${treeUri}/renamed/f.txt`) as Uint8Array)).toEqual([5, 6])
			expect(fs.has(`${treeUri}/sub`)).toBe(false)

			const meta = readTreeMeta()

			expect(meta.entries[subDirUuid]?.path).toBe("/renamed")
			expect(meta.entries[fileAUuid]?.path).toBe("/renamed/f.txt")
		})

		it("deletes only-local entries when the listing is clean", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const goneItem = makeFileItemWithSize(fileBUuid, "gone.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/keep.txt": keepItem,
					"/gone.txt": goneItem
				}),
				disk: {
					"/keep.txt": new Uint8Array([1]),
					"/gone.txt": new Uint8Array([2])
				}
			})

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(fs.has(`${treeUri}/keep.txt`)).toBe(true)
			expect(fs.has(`${treeUri}/gone.txt`)).toBe(false)

			const meta = readTreeMeta()

			expect(meta.entries[fileBUuid]).toBeUndefined()
			expect(meta.entries[fileAUuid]?.path).toBe("/keep.txt")
		})

		// Crash convergence: a previous pass deleted the bytes, then crashed BEFORE the meta
		// rewrite. The stale meta still lists the uuid and the remote also lacks it — an
		// INDEX-ONLY pass trusts the meta, plans the delete again, the executor's exists-guard
		// silently no-ops on the already-gone target, and the commit rewrites the meta without
		// the uuid. No download, no errors — the tree converges instead of erroring forever.
		it("converges a crashed delete on an INDEX-ONLY pass — stale meta entry with no bytes and no remote is dropped via a no-op delete", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const goneItem = makeFileItemWithSize(fileBUuid, "gone.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/keep.txt": keepItem,
					"/gone.txt": goneItem
				}),
				// The crashed pass already deleted /gone.txt — only the meta still claims it.
				disk: { "/keep.txt": new Uint8Array([1]) }
			})

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(`${treeUri}/keep.txt`)).toBe(true)

			const meta = readTreeMeta()

			expect(meta.entries[fileBUuid]).toBeUndefined()
			expect(meta.entries[fileAUuid]?.path).toBe("/keep.txt")
		})

		// Crash convergence: a previous pass MOVED the bytes /old.txt → /new.txt, then crashed
		// before the meta rewrite (both move phases completed — no .sync-tmp residue). The stale
		// meta still says /old.txt, so an INDEX-ONLY pass plans the same move again; the executor
		// finds the move SOURCE missing and silently skips both phases (the occupied destination
		// is never touched — no throw), and the commit records the remote path. Pins the
		// exists-guard executor semantics the design's crash-anywhere convergence relies on.
		it("converges a crashed move on an INDEX-ONLY pass — re-planned move no-ops on the missing source and the meta lands on the remote path", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "old.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/old.txt": fileItem }),
				// The crashed pass already placed the bytes at the destination.
				disk: { "/new.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "new.txt", "new.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			// Bytes untouched at the destination, no source resurrection, no temp residue.
			expect(Array.from(fs.get(`${treeUri}/new.txt`) as Uint8Array)).toEqual([1, 2, 3])
			expect(fs.has(`${treeUri}/old.txt`)).toBe(false)
			expect(fs.has(`${treeUri}/.sync-tmp-${fileAUuid}`)).toBe(false)

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/new.txt")
		})

		// Crash convergence for an interrupted SWAP (a.bin ↔ b.bin, different sizes): phase 2
		// placed A's bytes at /b.bin, then the pass crashed before placing B and B's extraction
		// temp was cleaned. The stale meta still claims the pre-swap paths. A THOROUGH pass stats
		// both meta paths — A's old path is empty and /b.bin size-mismatches B — so the planner
		// classifies BOTH uuids as missing (neither is physically present at its meta path: no
		// move ops at all) and ONE hash-idempotent download heals the tree: A's correct bytes at
		// /b.bin are skipped untouched, only B transfers to /a.bin.
		it("converges a crashed swap (different sizes) on a THOROUGH pass — both entries classified missing, exactly one download, meta lands on the swapped remote paths", async () => {
			const itemA = makeFileItemWithSize(fileAUuid, "a.bin", 3n)
			const itemB = makeFileItemWithSize(fileBUuid, "b.bin", 5n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/a.bin": itemA,
					"/b.bin": itemB
				}),
				// Crash state: A's 3 bytes already sit at /b.bin, nothing at /a.bin, no temps.
				disk: { "/b.bin": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			// Remote: the swap — A now lives at /b.bin (3 bytes), B at /a.bin (5 bytes).
			mockListing({
				files: [makeListingFile(fileAUuid, "b.bin", "b.bin", 3n), makeListingFile(fileBUuid, "a.bin", "a.bin", 5n)]
			})

			// Hash-idempotent downloader: /b.bin already holds A's correct bytes (skipped, never
			// rewritten); only B's bytes are written to /a.bin.
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/a.bin`, new Uint8Array([9, 9, 9, 9, 9]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, thorough: true })

			// End state: both entries at their remote paths with correct sizes, exactly one
			// download, meta committed.
			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(Array.from(fs.get(`${treeUri}/b.bin`) as Uint8Array)).toEqual([1, 2, 3])
			expect(Array.from(fs.get(`${treeUri}/a.bin`) as Uint8Array)).toEqual([9, 9, 9, 9, 9])

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/b.bin")
			expect(meta.entries[fileBUuid]?.path).toBe("/a.bin")
		})

		it("skips deletions and returns a degraded marker when the listing reports scan errors (fixed point, no download)", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const goneItem = makeFileItemWithSize(fileBUuid, "undecryptable.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/keep.txt": keepItem,
					"/undecryptable.txt": goneItem
				}),
				disk: {
					"/keep.txt": new Uint8Array([1]),
					"/undecryptable.txt": new Uint8Array([2])
				}
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			// The undecryptable entry is silently absent from the listing AND a scan error fires.
			mockDegradedListing({ files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			// One DEGRADED listing marker, the local copy survives. With nothing else changed the
			// committed union is byte-identical to the existing meta — a fixed point: zero writes,
			// zero downloads, meta untouched.
			expect(errors).toHaveLength(1)
			expect(errors[0]?.kind).toBe("listing")
			expect(errors[0]?.degraded).toBe(true)
			expect(errors[0]?.topLevelUuid).toBe(treeUuid)
			expect(fs.has(`${treeUri}/undecryptable.txt`)).toBe(true)
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
			expect(transfers.download).not.toHaveBeenCalled()
		})

		// Fix: a PERMANENT scan error (e.g. a legacy undecryptable nested meta) must not block the
		// commit forever — that regime re-downloaded/re-hashed the whole tree every pass while new
		// files never entered the meta (an eternal-resync relative).
		it("commits the verified union on a degraded pass — new remote file enters the meta, the unlisted local entry survives the sweep, second pass is a no-op", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const unlistedItem = makeFileItemWithSize(subDirUuid, "undecryptable.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/keep.txt": keepItem,
					"/undecryptable.txt": unlistedItem
				}),
				disk: {
					"/keep.txt": new Uint8Array([1]),
					"/undecryptable.txt": new Uint8Array([2])
				}
			})

			const offline = await createOffline()

			// Degraded listing: the undecryptable entry is silently absent, a NEW remote file appears.
			mockDegradedListing({
				files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n), makeListingFile(fileBUuid, "new.txt", "new.txt", 1n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/new.txt`, new Uint8Array([3]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const firstErrors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			// Only the degraded marker — the pass verified clean and COMMITTED.
			expect(firstErrors).toHaveLength(1)
			expect(firstErrors[0]?.kind).toBe("listing")
			expect(firstErrors[0]?.degraded).toBe(true)
			expect(transfers.download).toHaveBeenCalledTimes(1)

			// Union meta: both remote entries AND the preserved unlisted entry (existing item + path).
			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/keep.txt")
			expect(meta.entries[fileBUuid]?.path).toBe("/new.txt")
			expect(meta.entries[subDirUuid]?.path).toBe("/undecryptable.txt")
			expect(meta.entries[subDirUuid]?.item.data.uuid).toBe(subDirUuid)

			// The orphan sweep ran (a download happened) — the preserved entry's bytes are
			// sweep-protected via the committed-union keep-set.
			expect(fs.has(`${treeUri}/undecryptable.txt`)).toBe(true)
			expect(Array.from(fs.get(`${treeUri}/undecryptable.txt`) as Uint8Array)).toEqual([2])

			const metaAfterFirst = fs.get(`${treeUri}/${treeUuid}.filenmeta`)

			// Treadmill regression: a second degraded pass over unchanged state must be a TRUE
			// no-op — the union meta now lists the new file, so nothing is missing, nothing
			// downloads, and the meta is not rewritten.
			mockDegradedListing({
				files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n), makeListingFile(fileBUuid, "new.txt", "new.txt", 1n)]
			})

			const secondErrors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(secondErrors).toHaveLength(1)
			expect(secondErrors[0]?.degraded).toBe(true)
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaAfterFirst)
		})

		it("still blocks the commit when a degraded pass also collects a non-degraded error (verify failure)", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/keep.txt": keepItem }),
				disk: { "/keep.txt": new Uint8Array([1]) }
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			// Degraded listing with a new remote file whose download never materializes → verify error.
			mockDegradedListing({
				files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n), makeListingFile(fileBUuid, "ghost.txt", "ghost.txt", 1n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async (): Promise<any> => {
				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors.some((e: { kind: string }) => e.kind === "verify")).toBe(true)
			expect(errors.some((e: { degraded?: boolean }) => e.degraded === true)).toBe(true)
			// The non-degraded verify error blocks the commit — meta untouched.
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
		})

		it("treats listed files with unreadable metas as degradation — local bytes survive, no deletions", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/keep.txt": keepItem }),
				disk: { "/keep.txt": new Uint8Array([1]) }
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			// The same file IS listed but its meta cannot be decoded, so it drops out of the remote
			// map. Without degradation that would classify keep.txt as only-local and DELETE it.
			mockListing({ files: [makeListingFileUndecodable(fileAUuid, "keep.txt")] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toHaveLength(1)
			expect(errors[0]?.kind).toBe("listing")
			expect(errors[0]?.degraded).toBe(true)
			expect(fs.has(`${treeUri}/keep.txt`)).toBe(true)
			// The union (= the preserved entry alone) is byte-identical to the existing meta — fixed point.
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
			expect(transfers.download).not.toHaveBeenCalled()
		})

		// INDEX-ONLY + degraded coherence: the union's pre-pass gate trusts the all-true index
		// view, so the commit-time RE-STAT is the only presence guard — a preserved (unlisted)
		// entry whose bytes are externally gone is dropped from the union, and the committed meta
		// never claims absent bytes. (Once the listing reads clean again the entry re-enters via
		// the normal listing → download path if it is still alive remotely.)
		it("degraded INDEX-ONLY pass drops a preserved entry whose bytes are gone at the commit re-stat — the committed meta never claims absent bytes", async () => {
			const keepItem = makeFileItemWithSize(fileAUuid, "keep.txt", 1n)
			const unlistedItem = makeFileItemWithSize(fileBUuid, "u.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/keep.txt": keepItem,
					"/u.txt": unlistedItem
				}),
				// The unlisted entry's bytes are externally gone — invisible to the index-only
				// pre-pass view, caught only by the union's commit re-stat.
				disk: { "/keep.txt": new Uint8Array([1]) }
			})

			const offline = await createOffline()

			mockDegradedListing({ files: [makeListingFile(fileAUuid, "keep.txt", "keep.txt", 1n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			// Degraded marker only — the union commit still advances.
			expect(errors).toHaveLength(1)
			expect(errors[0]?.kind).toBe("listing")
			expect(errors[0]?.degraded).toBe(true)
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(`${treeUri}/keep.txt`)).toBe(true)

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/keep.txt")
			expect(meta.entries[fileBUuid]).toBeUndefined()
		})

		// Degraded-union move-replay: an unlisted (scan-error-hidden) child rides inside its
		// renamed parent directory through the two-phase move; the union must record the entry at
		// its CURRENT on-disk path (the planner's prefix rewrites replayed over both temp phases),
		// not the stale pre-move path — otherwise the committed meta would lie about the disk.
		it("replays planner moves on the degraded union — an unlisted child carried inside a renamed directory commits at its current path", async () => {
			const subDirItem = makeDirItem(subDirUuid, "sub")
			const unlistedItem = makeFileItemWithSize(fileAUuid, "u.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/sub": subDirItem,
					"/sub/u.txt": unlistedItem
				}),
				disk: {
					"/sub": "dir",
					"/sub/u.txt": new Uint8Array([7])
				}
			})

			const offline = await createOffline()

			// Degraded listing: the directory was renamed sub → renamed; the child is hidden by
			// the scan error and would be only-local (delete phase is skipped while degraded).
			mockDegradedListing({ dirs: [makeListingDir(subDirUuid, "renamed", "renamed")] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toHaveLength(1)
			expect(errors[0]?.degraded).toBe(true)
			expect(transfers.download).not.toHaveBeenCalled()

			// The child physically travelled inside the renamed directory.
			expect(Array.from(fs.get(`${treeUri}/renamed/u.txt`) as Uint8Array)).toEqual([7])
			expect(fs.has(`${treeUri}/sub`)).toBe(false)
			expect(fs.has(`${treeUri}/sub/u.txt`)).toBe(false)
			expect(fs.has(`${treeUri}/.sync-tmp-${subDirUuid}`)).toBe(false)

			const meta = readTreeMeta()

			expect(meta.entries[subDirUuid]?.path).toBe("/renamed")
			expect(meta.entries[fileAUuid]?.path).toBe("/renamed/u.txt")
		})

		// A4 — degraded move-destination collision: with deletes skipped, the mover's destination
		// stays occupied by a kept only-local entry, so the executor's never-overwrite move would
		// throw a non-degraded store error and block the commit EVERY pass (livelock). The planner
		// defers the move instead; the meta commits at the CURRENT path and the next clean pass
		// (deletes allowed) completes the move.
		it("defers a degraded-pass move onto a kept occupant — commits at the old path without a store error; the follow-up clean pass completes the move", async () => {
			const moverItem = makeFileItemWithSize(fileAUuid, "old.txt", 3n)
			const occupantItem = makeFileItemWithSize(fileBUuid, "new.txt", 2n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/old.txt": moverItem,
					"/new.txt": occupantItem
				}),
				disk: {
					"/old.txt": new Uint8Array([1, 2, 3]),
					"/new.txt": new Uint8Array([9, 9])
				}
			})

			const offline = await createOffline()

			// Degraded listing: the occupant is hidden by a scan error (so it is kept), while the
			// mover's remote path is exactly the occupant's spot.
			mockDegradedListing({ files: [makeListingFile(fileAUuid, "new.txt", "new.txt", 3n)] })

			const firstErrors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			// ONLY the degraded marker — no store error from a throwing move; the pass COMMITTED.
			expect(firstErrors).toHaveLength(1)
			expect(firstErrors[0]?.kind).toBe("listing")
			expect(firstErrors[0]?.degraded).toBe(true)
			expect(transfers.download).not.toHaveBeenCalled()

			// Nothing moved on disk: both files still at their original paths.
			expect(Array.from(fs.get(`${treeUri}/old.txt`) as Uint8Array)).toEqual([1, 2, 3])
			expect(Array.from(fs.get(`${treeUri}/new.txt`) as Uint8Array)).toEqual([9, 9])

			const firstMeta = readTreeMeta()

			// The deferred mover commits at its CURRENT path; the occupant survives via the union.
			expect(firstMeta.entries[fileAUuid]?.path).toBe("/old.txt")
			expect(firstMeta.entries[fileBUuid]?.path).toBe("/new.txt")

			// The listing heals: the clean pass deletes the occupant and completes the move.
			mockListing({ files: [makeListingFile(fileAUuid, "new.txt", "new.txt", 3n)] })

			const secondErrors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(secondErrors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(`${treeUri}/old.txt`)).toBe(false)
			expect(Array.from(fs.get(`${treeUri}/new.txt`) as Uint8Array)).toEqual([1, 2, 3])

			const secondMeta = readTreeMeta()

			expect(secondMeta.entries[fileAUuid]?.path).toBe("/new.txt")
			expect(secondMeta.entries[fileBUuid]).toBeUndefined()
		})

		// Deferred-pass + download interplay: an entry the plan classified MISSING is downloaded to
		// its REMOTE path even when its stale meta path differs — the deferred-pass verify/commit
		// must expect it there (replaying the stale meta path would block the commit forever).
		it("verifies and commits a missing renamed entry at its REMOTE path on a deferred-move pass", async () => {
			const moverItem = makeFileItemWithSize(fileAUuid, "old.txt", 3n)
			const occupantItem = makeFileItemWithSize(fileBUuid, "new.txt", 2n)
			const renamedMissingItem = makeFileItemWithSize(subDirUuid, "r-old.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/old.txt": moverItem,
					"/new.txt": occupantItem,
					"/r-old.txt": renamedMissingItem
				}),
				// r's bytes are missing on disk — the THOROUGH stat detects it.
				disk: {
					"/old.txt": new Uint8Array([1, 2, 3]),
					"/new.txt": new Uint8Array([9, 9])
				}
			})

			const offline = await createOffline()

			// Degraded listing hides the occupant; m's move collides (deferred); r was renamed
			// remotely while its local bytes are gone (missing → downloaded at the remote path).
			mockDegradedListing({
				files: [makeListingFile(fileAUuid, "new.txt", "new.txt", 3n), makeListingFile(subDirUuid, "r-new.txt", "r-new.txt", 1n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/r-new.txt`, new Uint8Array([7]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, thorough: true })

			// Only the degraded marker — the verify must NOT fail on r's stale meta path.
			expect(errors).toHaveLength(1)
			expect(errors[0]?.degraded).toBe(true)
			expect(transfers.download).toHaveBeenCalledTimes(1)

			const meta = readTreeMeta()

			// Deferred mover at its current path, downloaded entry at its remote path, occupant
			// preserved via the union.
			expect(meta.entries[fileAUuid]?.path).toBe("/old.txt")
			expect(meta.entries[subDirUuid]?.path).toBe("/r-new.txt")
			expect(meta.entries[fileBUuid]?.path).toBe("/new.txt")
			expect(Array.from(fs.get(`${treeUri}/r-new.txt`) as Uint8Array)).toEqual([7])
		})

		// A3 + downloads — pinning the dedup contract too: two per-entry download errors that
		// resolve to the SAME remote entry (same `${itemUuid}:${kind}` id) surface as ONE error.
		it("dedups same-id errors within a pass — two download errors resolving to the same entry surface once", async () => {
			const { dirItem, parent } = seedTree({
				entries: {},
				disk: {}
			})

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "big.bin", "big.bin", 4n)] })

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const base = `${(destination as { uri: string }).uri.replace(/^file:\/+/, "/private/")}/big.bin`

				return {
					files: [],
					directories: [],
					errors: [
						{
							error: { message: () => "chunk 1 failed", kind: () => "IO" },
							path: base,
							item: {}
						},
						{
							error: { message: () => "chunk 2 failed", kind: () => "IO" },
							path: base,
							item: {}
						}
					]
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			const downloadErrors = errors.filter((e: { kind: string }) => e.kind === "download")

			expect(downloadErrors).toHaveLength(1)
			expect(downloadErrors[0]?.id).toBe(`${fileAUuid}:download`)
			// First error wins; the duplicate id is dropped.
			expect(downloadErrors[0]?.message).toBe("chunk 1 failed")
		})

		it("returns a listing error and leaves state untouched when the remote listing fails", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1]) }
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn().mockRejectedValue(new Error("Network down"))
				}
			} as any)

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toHaveLength(1)
			expect(errors[0]?.kind).toBe("listing")
			expect(errors[0]?.message).toBe("Network down")
			expect(fs.has(`${treeUri}/a.txt`)).toBe(true)
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
		})

		// Regression: a failed initialStore pass must only delete the tree when there was NO readable
		// meta at pass start. Over a committed tree (concurrent-store race) it keeps state and returns
		// the errors like a sync pass.
		it("keeps the committed tree when an initialStore pass fails over a readable prior meta", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1]) }
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			// The pass fails outright at the listing — with no readable meta this would delete + throw.
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn().mockRejectedValue(new Error("Network down"))
				}
			} as any)

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, initialStore: true })

			expect(errors).toHaveLength(1)
			expect(errors[0]?.kind).toBe("listing")
			expect(fs.has(treeUri)).toBe(true)
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
			expect(fs.has(`${treeUri}/a.txt`)).toBe(true)
		})

		// Truncation detection requires the disk-verified local view — a THOROUGH pass (user-explicit
		// trigger). The index-only counterpart is pinned by the paired "INDEX-ONLY pass trusts the
		// meta" test below.
		it("re-downloads a truncated file on a THOROUGH pass (size mismatch counts as missing) and commits after verify", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 5n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				// Truncated: meta says 5 bytes, disk has 2.
				disk: { "/a.txt": new Uint8Array([1, 2]) }
			})

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 5n)] })

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/a.txt`, new Uint8Array([1, 2, 3, 4, 5]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, thorough: true })

			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect((fs.get(`${treeUri}/a.txt`) as Uint8Array).length).toBe(5)
		})

		// Paired tests pinning the §4.2 local-view semantics precisely: the SAME externally damaged
		// tree (meta claims an entry whose bytes are gone) with an UNCHANGED remote is a TRUE no-op
		// on an automatic (index-only) pass — the meta is trusted, zero per-entry stats, so nothing
		// is detected, downloaded, or written — while a thorough pass stat-checks, detects, and
		// re-downloads.
		it("INDEX-ONLY (default) pass trusts the meta: an externally deleted entry with an unchanged remote is a TRUE no-op (no download, no errors, no writes)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			// First pass establishes the canonical serialized meta.
			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })
			await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			const metaAfterFirst = fs.get(`${treeUri}/${treeUuid}.filenmeta`)

			// External damage behind the meta's back.
			fs.delete(`${treeUri}/a.txt`)

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaAfterFirst)
			// The damage stays — healed only by a thorough pass or at file-access time.
			expect(fs.has(`${treeUri}/a.txt`)).toBe(false)
		})

		it("THOROUGH pass stat-checks the meta: the same externally deleted entry is detected and re-downloaded", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				// The meta claims /a.txt but its bytes are gone (external deletion).
				disk: {}
			})

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/a.txt`, new Uint8Array([1, 2, 3]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, thorough: true })

			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(Array.from(fs.get(`${treeUri}/a.txt`) as Uint8Array)).toEqual([1, 2, 3])
		})

		// THOROUGH counterpart of the no-op fixed point: the disk-verified pass stats every entry
		// and runs the verify loop even without a download, but a fully healthy unchanged tree
		// must still write nothing, download nothing, and NOT sweep — the orphan sweep requires a
		// download or an unreadable meta, never a clean thorough no-op.
		it("THOROUGH no-op pass over a healthy unchanged tree: stats verify clean, zero writes, no download, no orphan sweep", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			// First pass establishes the canonical serialized meta.
			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })
			await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			const metaAfterFirst = fs.get(`${treeUri}/${treeUuid}.filenmeta`)

			// A stray the meta does not claim — a sweep would delete it, a true no-op must not.
			fs.set(`${treeUri}/stray.txt`, new Uint8Array([9]))

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, thorough: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			// Same meta bytes by reference — never rewritten.
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaAfterFirst)
			expect(fs.has(`${treeUri}/stray.txt`)).toBe(true)
		})

		it("fails the pass (no commit) when the download reports per-entry errors, resolving the entry by path suffix", async () => {
			const okItem = makeFileItemWithSize(fileAUuid, "ok.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/ok.txt": okItem }),
				disk: { "/ok.txt": new Uint8Array([1]) }
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			mockListing({
				files: [makeListingFile(fileAUuid, "ok.txt", "ok.txt", 1n), makeListingFile(fileBUuid, "sub/broken.txt", "broken.txt", 1n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				return {
					files: [],
					directories: [],
					errors: [
						{
							error: { message: () => "chunk fetch failed", kind: () => "IO" },
							path: `${(destination as { uri: string }).uri.replace(/^file:\/+/, "/private/")}/sub/broken.txt`,
							item: {}
						}
					]
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			const downloadError = errors.find((e: { kind: string }) => e.kind === "download")

			expect(downloadError).toBeDefined()
			expect(downloadError?.itemUuid).toBe(fileBUuid)
			expect(downloadError?.message).toBe("chunk fetch failed")
			expect(downloadError?.topLevelUuid).toBe(treeUuid)

			// Meta did not advance, healthy local data untouched.
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
			expect(fs.has(`${treeUri}/ok.txt`)).toBe(true)
		})

		it("fails the pass with a verify error when a remote entry is missing after the download", async () => {
			const { dirItem, parent } = seedTree({
				entries: {},
				disk: {}
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "ghost.txt", "ghost.txt", 3n)] })

			// Download resolves cleanly but never writes the file.
			vi.mocked(transfers.download).mockImplementationOnce(async (): Promise<any> => {
				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toHaveLength(1)
			expect(errors[0]?.kind).toBe("verify")
			expect(errors[0]?.itemUuid).toBe(fileAUuid)
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
		})

		it("rebuilds an unreadable meta from the listing while the healthy bytes survive", async () => {
			const dirItem = makeDirItem(treeUuid, "Tree")
			const parent = makeParent(parentUuid)

			// Corrupt meta + a healthy data file on disk.
			fs.set(treeUri, "dir")
			fs.set(`${treeUri}/${treeUuid}.filenmeta`, new Uint8Array([0xff, 0xfe]))
			fs.set(`${treeUri}/a.txt`, new Uint8Array([1, 2, 3]))

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			// Local view is empty (meta unreadable) → download runs; the hash-idempotent downloader
			// would skip the healthy bytes, so the mock writes nothing.
			vi.mocked(transfers.download).mockImplementationOnce(async (): Promise<any> => {
				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(fs.has(`${treeUri}/a.txt`)).toBe(true)

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/a.txt")
		})

		it("deletes a leftover /.sync-tmp-* temp whose uuid the meta does not claim (crash recovery)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1]) }
			})

			fs.set(`${treeUri}/.sync-tmp-deadbeef`, "dir")
			fs.set(`${treeUri}/.sync-tmp-deadbeef/orphan.txt`, new Uint8Array([9]))

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(fs.has(`${treeUri}/.sync-tmp-deadbeef`)).toBe(false)
			expect(fs.has(`${treeUri}/.sync-tmp-deadbeef/orphan.txt`)).toBe(false)
		})

		it("RESCUES a /.sync-tmp-{uuid} temp back to its free meta path (bytes preserved, no download, temp gone)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				// The crashed move phase extracted the entry: its meta path is free, the temp holds
				// the bytes.
				disk: {}
			})

			fs.set(`${treeUri}/.sync-tmp-${fileAUuid}`, new Uint8Array([1, 2, 3]))

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(Array.from(fs.get(`${treeUri}/a.txt`) as Uint8Array)).toEqual([1, 2, 3])
			expect(fs.has(`${treeUri}/.sync-tmp-${fileAUuid}`)).toBe(false)
		})

		it("deletes a /.sync-tmp-{uuid} temp whose meta path is occupied on disk (no overwrite)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([7, 8, 9]) }
			})

			// Crash residue for a uuid whose meta path is already occupied — never rescued.
			fs.set(`${treeUri}/.sync-tmp-${fileAUuid}`, new Uint8Array([1, 2, 3]))

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(`${treeUri}/.sync-tmp-${fileAUuid}`)).toBe(false)
			// The occupied bytes stay exactly as they were.
			expect(Array.from(fs.get(`${treeUri}/a.txt`) as Uint8Array)).toEqual([7, 8, 9])
		})

		it("a leftover temp ESCALATES an automatic pass to the disk-verified view — a missing sibling entry is detected and downloaded", async () => {
			const okItem = makeFileItemWithSize(fileAUuid, "ok.txt", 1n)
			const goneItem = makeFileItemWithSize(fileBUuid, "gone.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({
					"/ok.txt": okItem,
					"/gone.txt": goneItem
				}),
				// gone.txt is missing on disk — invisible to a plain automatic pass (see the
				// INDEX-ONLY no-op test above) but visible to this crash-escalated one.
				disk: { "/ok.txt": new Uint8Array([1]) }
			})

			// Crash residue from an unknown uuid — not rescuable, but still escalation proof.
			fs.set(`${treeUri}/.sync-tmp-deadbeef`, new Uint8Array([9]))

			const offline = await createOffline()

			mockListing({
				files: [makeListingFile(fileAUuid, "ok.txt", "ok.txt", 1n), makeListingFile(fileBUuid, "gone.txt", "gone.txt", 1n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/gone.txt`, new Uint8Array([2]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(fs.has(`${treeUri}/.sync-tmp-deadbeef`)).toBe(false)
			expect(Array.from(fs.get(`${treeUri}/gone.txt`) as Uint8Array)).toEqual([2])
		})

		// Rescue requires a META CLAIM: with the tree meta unreadable there is no claimed path to
		// rescue a /.sync-tmp-{uuid} back to, so the temp is deleted, the empty local view
		// downloads the listing, and the meta is rebuilt — double crash residue (move temp +
		// corrupt meta) converges in a single pass.
		it("deletes a rescuable-looking temp when the meta is ALSO unreadable, then rebuilds via download (no rescue without a meta claim)", async () => {
			const dirItem = makeDirItem(treeUuid, "Tree")
			const parent = makeParent(parentUuid)

			// Corrupt meta + a temp whose uuid a READABLE meta would have rescued.
			fs.set(treeUri, "dir")
			fs.set(`${treeUri}/${treeUuid}.filenmeta`, new Uint8Array([0xff, 0xfe]))
			fs.set(`${treeUri}/.sync-tmp-${fileAUuid}`, new Uint8Array([1, 2, 3]))

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/a.txt`, new Uint8Array([1, 2, 3]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)
			expect(fs.has(`${treeUri}/.sync-tmp-${fileAUuid}`)).toBe(false)
			expect(Array.from(fs.get(`${treeUri}/a.txt`) as Uint8Array)).toEqual([1, 2, 3])

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/a.txt")
		})

		// Mixed crash residue in ONE pass: a claimed temp whose meta path is free is rescued
		// (bytes preserved), an unknown temp is deleted, and — since the rescue restored the only
		// entry — the escalated disk-verified view finds the tree whole, so nothing downloads.
		it("handles multiple temps in one pass — rescues the claimed-free one, deletes the unknown one, no download needed", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				// The crashed move phase extracted the entry — its meta path is free.
				disk: {}
			})

			fs.set(`${treeUri}/.sync-tmp-${fileAUuid}`, new Uint8Array([1, 2, 3]))
			fs.set(`${treeUri}/.sync-tmp-deadbeef`, new Uint8Array([9]))

			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(`${treeUri}/.sync-tmp-${fileAUuid}`)).toBe(false)
			expect(fs.has(`${treeUri}/.sync-tmp-deadbeef`)).toBe(false)
			expect(Array.from(fs.get(`${treeUri}/a.txt`) as Uint8Array)).toEqual([1, 2, 3])

			const meta = readTreeMeta()

			expect(meta.entries[fileAUuid]?.path).toBe("/a.txt")
		})

		it("sweeps unclaimed orphans after a committed pass that downloaded", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: {
					"/a.txt": new Uint8Array([1]),
					"/stray.txt": new Uint8Array([9]),
					"/partial.bin.filendl": new Uint8Array([9, 9])
				}
			})

			const offline = await createOffline()

			// One missing entry forces a download (→ sweep eligibility).
			mockListing({
				files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n), makeListingFile(fileBUuid, "b.txt", "b.txt", 1n)]
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/b.txt`, new Uint8Array([2]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])

			// Claimed paths survive, orphans (incl. .filendl partials) are gone, meta survives.
			expect(fs.has(`${treeUri}/a.txt`)).toBe(true)
			expect(fs.has(`${treeUri}/b.txt`)).toBe(true)
			expect(fs.has(`${treeUri}/${treeUuid}.filenmeta`)).toBe(true)
			expect(fs.has(`${treeUri}/stray.txt`)).toBe(false)
			expect(fs.has(`${treeUri}/partial.bin.filendl`)).toBe(false)
		})

		it("does NOT sweep orphans on a no-op pass", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 1n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1]) }
			})

			const offline = await createOffline()

			// Establish the canonical meta first.
			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n)] })
			await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			// Drop a stray AFTER commit, then run a no-op pass.
			fs.set(`${treeUri}/stray.txt`, new Uint8Array([9]))

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n)] })

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(errors).toEqual([])
			expect(fs.has(`${treeUri}/stray.txt`)).toBe(true)
		})

		// Regression: a pure self-heal pass (download ran, rebuilt meta byte-identical) must still
		// sweep — otherwise crashed .filendl partials linger forever on trees that never change.
		// Detecting the truncation requires the disk-verified local view, so this is a THOROUGH pass.
		it("sweeps a stray .filendl partial on a THOROUGH heal pass even when the meta is byte-identical", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()

			// First pass establishes the canonical serialized meta.
			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })
			await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			const metaAfterFirst = fs.get(`${treeUri}/${treeUuid}.filenmeta`)

			// Crash aftermath: the data file is truncated and a .filendl partial lingers.
			fs.set(`${treeUri}/a.txt`, new Uint8Array([1]))
			fs.set(`${treeUri}/a.txt.filendl`, new Uint8Array([9, 9]))

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)] })

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				fs.set(`${(destination as { uri: string }).uri}/a.txt`, new Uint8Array([1, 2, 3]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			const errors = await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, thorough: true })

			expect(errors).toEqual([])
			expect(transfers.download).toHaveBeenCalledTimes(1)

			// The meta is byte-identical (never rewritten) yet the heal pass still swept the partial.
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaAfterFirst)
			expect(fs.has(`${treeUri}/a.txt.filendl`)).toBe(false)
			expect((fs.get(`${treeUri}/a.txt`) as Uint8Array).length).toBe(3)
		})

		it("returns collected errors without committing when the signal aborts before the download — committed tree untouched", async () => {
			const { dirItem, parent } = seedTree({
				entries: {},
				disk: {}
			})

			const metaBefore = fs.get(`${treeUri}/${treeUuid}.filenmeta`)
			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n)] })

			const controller = new AbortController()

			controller.abort()

			const errors = await offline.reconcileTree({
				directory: dirItem,
				parent,
				skipIndexUpdate: true,
				signal: controller.signal
			})

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			// A sync-pass abort over an existing committed meta keeps the tree fully intact.
			expect(fs.has(treeUri)).toBe(true)
			expect(fs.get(`${treeUri}/${treeUuid}.filenmeta`)).toBe(metaBefore)
		})

		// Fix: an aborted INITIAL store used to strand an invisible meta-less directories/{uuid}/
		// partial forever (no meta → listed nowhere). The abort stays silent (no throw, no errors)
		// but must delete the partial tree.
		it("deletes the partial tree when an initial store aborts mid-download (no throw)", async () => {
			const dirItem = makeDirItem(treeUuid, "Tree")
			const parent = makeParent(parentUuid)
			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n)] })

			// transfers.download resolving null = aborted download.
			vi.mocked(transfers.download).mockResolvedValueOnce(null as any)

			const errors = await offline.reconcileTree({
				directory: dirItem,
				parent,
				skipIndexUpdate: true,
				initialStore: true
			})

			expect(errors).toEqual([])
			expect(fs.has(treeUri)).toBe(false)
			expect(fs.has(`${treeUri}/${treeUuid}.filenmeta`)).toBe(false)
		})

		it("deletes the partial tree when an initial store's signal is aborted before the download (no throw)", async () => {
			const dirItem = makeDirItem(treeUuid, "Tree")
			const parent = makeParent(parentUuid)
			const offline = await createOffline()

			mockListing({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 1n)] })

			const controller = new AbortController()

			controller.abort()

			const errors = await offline.reconcileTree({
				directory: dirItem,
				parent,
				skipIndexUpdate: true,
				initialStore: true,
				signal: controller.signal
			})

			expect(errors).toEqual([])
			expect(transfers.download).not.toHaveBeenCalled()
			expect(fs.has(treeUri)).toBe(false)
		})

		it("threads the abort signal into the recursive listing call (4th asyncOpts arg)", async () => {
			const fileItem = makeFileItemWithSize(fileAUuid, "a.txt", 3n)
			const { dirItem, parent } = seedTree({
				entries: makeEntries({ "/a.txt": fileItem }),
				disk: { "/a.txt": new Uint8Array([1, 2, 3]) }
			})

			const offline = await createOffline()
			const listMock = vi.fn().mockResolvedValue({ files: [makeListingFile(fileAUuid, "a.txt", "a.txt", 3n)], dirs: [] })

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: listMock
				}
			} as any)

			const controller = new AbortController()

			await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true, signal: controller.signal })
			await offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			expect(listMock).toHaveBeenCalledTimes(2)
			// With a signal: asyncOpts { signal } as the 4th arg (generated-bindings contract).
			expect(listMock.mock.calls[0]?.[3]?.signal).toBe(controller.signal)
			// Without: undefined.
			expect(listMock.mock.calls[1]?.[3]).toBeUndefined()
		})

		it("throws on non-directory items and missing decrypted meta", async () => {
			const offline = await createOffline()
			const parent = makeParent(parentUuid)

			await expect(offline.reconcileTree({ directory: makeFileItem(fileAUuid, "not-a-dir.txt"), parent })).rejects.toThrow(
				"Item not of type directory"
			)

			const noMetaDir = {
				type: "directory",
				data: {
					uuid: treeUuid,
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem

			await expect(offline.reconcileTree({ directory: noMetaDir, parent })).rejects.toThrow("Directory missing decrypted meta")
		})
	})

	describe("updateTreeRootMeta", () => {
		it("rewrites item and parent while preserving entries", async () => {
			const treeUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const dirItem = makeDirItem(treeUuid, "OldName")
			const renamedItem = makeDirItem(treeUuid, "NewName")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const newParent = makeParent("33333333-3333-3333-3333-333333333333")
			const nestedFile = makeFileItem(fileUuid, "nested.txt")

			writeDirectoryMeta(treeUuid, {
				item: dirItem,
				parent,
				entries: makeEntries({ "/nested.txt": nestedFile })
			})

			const offline = await createOffline()

			await offline.updateTreeRootMeta({ uuid: treeUuid, item: renamedItem, parent: newParent })

			const metaUri = `${DIRECTORIES_DIR_URI}/${treeUuid}/${treeUuid}.filenmeta`
			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as DirectoryOfflineMeta

			expect(meta.item.data.decryptedMeta?.name).toBe("NewName")
			expect(meta.entries[fileUuid]?.path).toBe("/nested.txt")
			expect(meta.entries[fileUuid]?.item.data.uuid).toBe(fileUuid)
		})

		it("is a no-op when the tree meta is missing or unreadable", async () => {
			const treeUuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(treeUuid, "Ghost")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const offline = await createOffline()

			await expect(offline.updateTreeRootMeta({ uuid: treeUuid, item: dirItem, parent })).resolves.toBeUndefined()

			expect(fs.has(`${DIRECTORIES_DIR_URI}/${treeUuid}/${treeUuid}.filenmeta`)).toBe(false)
		})
	})

	describe("renameStandaloneFile", () => {
		it("renames the data file in place and rewrites the meta", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const oldItem = makeFileItem(uuid, "old-name.txt")
			const newItem = makeFileItem(uuid, "new-name.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeFileData(uuid, "old-name.txt", new Uint8Array([1, 2, 3]))
			writeFileMeta(uuid, { item: oldItem, parent })

			const offline = await createOffline()

			await offline.renameStandaloneFile({ item: newItem, parent })

			expect(fs.has(`${FILES_DIR_URI}/${uuid}/old-name.txt`)).toBe(false)
			expect(Array.from(fs.get(`${FILES_DIR_URI}/${uuid}/new-name.txt`) as Uint8Array)).toEqual([1, 2, 3])

			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as FileOrDirectoryOfflineMeta

			expect(meta.item.data.decryptedMeta?.name).toBe("new-name.txt")
		})

		it("locates the data file even when its on-disk name does not match the old meta", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const newItem = makeFileItem(uuid, "corrected.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// The single non-.filenmeta file has a stale name unrelated to any meta.
			writeFileData(uuid, "stale-on-disk.txt", new Uint8Array([7]))
			writeFileMeta(uuid, { item: makeFileItem(uuid, "meta-name.txt"), parent })

			const offline = await createOffline()

			await offline.renameStandaloneFile({ item: newItem, parent })

			expect(fs.has(`${FILES_DIR_URI}/${uuid}/stale-on-disk.txt`)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/corrected.txt`)).toBe(true)
		})

		// A5 — the meta rewrite must not require a data file: a bytes-missing standalone that was
		// MOVED remotely must converge (meta parent re-anchored), otherwise the sync re-anchor
		// no-ops every pass forever and the heal never gets a meta pointing at the new parent.
		it("rewrites the meta {item, parent} even when no data file exists (bytes-missing standalone converges on a remote move)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const oldParent = makeParent("22222222-2222-2222-2222-222222222222")
			const newParent = makeParent("33333333-3333-3333-3333-333333333333")
			const movedItem = makeFileItem(uuid, "moved.txt")

			// Meta only — the data file is gone (deleted bytes / crash residue).
			writeFileMeta(uuid, { item: makeFileItem(uuid, "doc.txt"), parent: oldParent })

			const offline = await createOffline()

			await offline.renameStandaloneFile({ item: movedItem, parent: newParent })

			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
			const meta = deserialize(new TextDecoder().decode(fs.get(metaUri) as Uint8Array)) as FileOrDirectoryOfflineMeta

			// Meta converged: refreshed item + re-anchored parent — the subsequent heal path can
			// now redownload the bytes into the right place.
			expect(meta.item.data.decryptedMeta?.name).toBe("moved.txt")
			expect((meta.parent as InstanceType<typeof AnyDirWithContext.Normal>).inner[0]).toMatchObject({
				inner: [{ uuid: "33333333-3333-3333-3333-333333333333" }]
			})

			// No data file was conjured up — only the meta exists in the standalone dir.
			const standaloneEntries = [...fs.keys()].filter(key => key.startsWith(`${FILES_DIR_URI}/${uuid}/`))

			expect(standaloneEntries).toEqual([metaUri])
		})

		it("is a no-op when the standalone directory does not exist", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const item = makeFileItem(uuid, "nowhere.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const offline = await createOffline()

			await expect(offline.renameStandaloneFile({ item, parent })).resolves.toBeUndefined()
		})

		it("throws for non-file items and missing decrypted meta", async () => {
			const offline = await createOffline()
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			await expect(
				offline.renameStandaloneFile({ item: makeDirItem("11111111-1111-1111-1111-111111111111", "dir"), parent })
			).rejects.toThrow("Item not of type file")

			const noMetaFile = {
				type: "file",
				data: {
					uuid: "11111111-1111-1111-1111-111111111111",
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem

			await expect(offline.renameStandaloneFile({ item: noMetaFile, parent })).rejects.toThrow("File missing decrypted meta")
		})
	})

	describe("listBrokenStandaloneUuids", () => {
		it("reports uuid dirs with missing, empty, or undecodable metas — and only those — with hasDataFile", async () => {
			const healthyUuid = "11111111-1111-1111-1111-111111111111"
			const missingMetaUuid = "22222222-2222-2222-2222-222222222222"
			const emptyMetaUuid = "33333333-3333-3333-3333-333333333333"
			const corruptMetaUuid = "44444444-4444-4444-4444-444444444444"
			const noDataUuid = "55555555-5555-5555-5555-555555555555"
			const parent = makeParent("99999999-9999-9999-9999-999999999999")

			// Healthy
			writeFileData(healthyUuid, "ok.txt")
			writeFileMeta(healthyUuid, { item: makeFileItem(healthyUuid, "ok.txt"), parent })

			// Missing meta
			writeFileData(missingMetaUuid, "data.txt")

			// Empty meta
			writeFileData(emptyMetaUuid, "data.txt")
			fs.set(`${FILES_DIR_URI}/${emptyMetaUuid}/${emptyMetaUuid}.filenmeta`, new Uint8Array([]))

			// Corrupt meta
			writeFileData(corruptMetaUuid, "data.txt")
			fs.set(`${FILES_DIR_URI}/${corruptMetaUuid}/${corruptMetaUuid}.filenmeta`, new Uint8Array([0xff, 0xfe]))

			// Empty meta-less dir with NO data file (crash / aborted-adoption residue)
			fs.set(`${FILES_DIR_URI}/${noDataUuid}`, "dir")

			// Non-uuid dir is ignored entirely
			fs.set(`${FILES_DIR_URI}/not-a-uuid`, "dir")

			const offline = await createOffline()
			const broken = (await offline.listBrokenStandaloneUuids()) as {
				uuid: string
				hasDataFile: boolean
				dataFileSize: number | null
			}[]

			expect(broken.map(entry => entry.uuid).sort()).toEqual(
				[missingMetaUuid, emptyMetaUuid, corruptMetaUuid, noDataUuid].sort()
			)

			const byUuid = new Map(broken.map(entry => [entry.uuid, entry]))

			// hasDataFile = any non-.filenmeta file present, dataFileSize = its on-disk byte size
			// (null without one) — together they drive rebuild vs redownload in the heal (a meta
			// rewrite is only allowed around bytes at the remote meta's exact size).
			expect(byUuid.get(missingMetaUuid)).toMatchObject({ hasDataFile: true, dataFileSize: 3 })
			expect(byUuid.get(emptyMetaUuid)).toMatchObject({ hasDataFile: true, dataFileSize: 3 })
			expect(byUuid.get(corruptMetaUuid)).toMatchObject({ hasDataFile: true, dataFileSize: 3 })
			expect(byUuid.get(noDataUuid)).toMatchObject({ hasDataFile: false, dataFileSize: null })
		})

		it("returns an empty array when everything is healthy", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parent = makeParent("99999999-9999-9999-9999-999999999999")

			writeFileData(uuid, "ok.txt")
			writeFileMeta(uuid, { item: makeFileItem(uuid, "ok.txt"), parent })

			const offline = await createOffline()

			expect(await offline.listBrokenStandaloneUuids()).toEqual([])
		})
	})

	describe("listBrokenTreeUuids", () => {
		it("reports uuid tree dirs with missing, empty, undecodable, or entries-less metas — and only those", async () => {
			const healthyUuid = "11111111-1111-1111-1111-111111111111"
			const missingMetaUuid = "22222222-2222-2222-2222-222222222222"
			const emptyMetaUuid = "33333333-3333-3333-3333-333333333333"
			const corruptMetaUuid = "44444444-4444-4444-4444-444444444444"
			const entriesLessUuid = "55555555-5555-5555-5555-555555555555"
			const parent = makeParent("99999999-9999-9999-9999-999999999999")

			// Healthy committed tree.
			writeDirectoryMeta(healthyUuid, {
				item: makeDirItem(healthyUuid, "Healthy"),
				parent,
				entries: {}
			})

			// Meta-less partial (crash residue) — invisible to listDirectories, must be reported.
			fs.set(`${DIRECTORIES_DIR_URI}/${missingMetaUuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${missingMetaUuid}/orphan.txt`, new Uint8Array([1]))

			// Zero-byte meta.
			fs.set(`${DIRECTORIES_DIR_URI}/${emptyMetaUuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${emptyMetaUuid}/${emptyMetaUuid}.filenmeta`, new Uint8Array([]))

			// Undecodable meta bytes.
			fs.set(`${DIRECTORIES_DIR_URI}/${corruptMetaUuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${corruptMetaUuid}/${corruptMetaUuid}.filenmeta`, new Uint8Array([0xff, 0xfe]))

			// Directory-item meta without an entries field (legacy corrupt write) — rejected by
			// readDirectoryMeta, so it is broken for every tree reader.
			fs.set(`${DIRECTORIES_DIR_URI}/${entriesLessUuid}`, "dir")
			fs.set(
				`${DIRECTORIES_DIR_URI}/${entriesLessUuid}/${entriesLessUuid}.filenmeta`,
				new Uint8Array(
					new TextEncoder().encode(
						serialize({
							item: makeDirItem(entriesLessUuid, "Legacy"),
							parent
						})
					)
				)
			)

			// Non-uuid dirs are ignored entirely.
			fs.set(`${DIRECTORIES_DIR_URI}/not-a-uuid`, "dir")

			const offline = await createOffline()
			const broken = (await offline.listBrokenTreeUuids()) as string[]

			expect(broken.sort()).toEqual([missingMetaUuid, emptyMetaUuid, corruptMetaUuid, entriesLessUuid].sort())
		})

		it("returns an empty array when everything is healthy", async () => {
			writeDirectoryMeta("11111111-1111-1111-1111-111111111111", {
				item: makeDirItem("11111111-1111-1111-1111-111111111111", "Healthy"),
				parent: makeParent("99999999-9999-9999-9999-999999999999"),
				entries: {}
			})

			const offline = await createOffline()

			expect(await offline.listBrokenTreeUuids()).toEqual([])
		})
	})

	describe("removeTreeDirectory", () => {
		it("deletes directories/{uuid} recursively without touching the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"

			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}`, "dir")
			fs.set(`${DIRECTORIES_DIR_URI}/${uuid}/orphan.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.removeTreeDirectory(uuid)

			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}/orphan.txt`)).toBe(false)
			// NO index update — broken trees were never indexed; callers batch one per pass.
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})

		it("is a no-op for a uuid with no tree dir", async () => {
			const offline = await createOffline()

			await expect(offline.removeTreeDirectory("22222222-2222-2222-2222-222222222222")).resolves.toBeUndefined()
		})
	})

	describe("removeItem per-uuid lock", () => {
		// Fix: without the per-uuid lock, a removeItem racing a same-uuid reconcileTree could
		// delete the tree mid-download and then be resurrected by that pass's meta commit.
		it("waits for an in-flight same-uuid reconcile, so the removal lands after the commit (no resurrection)", async () => {
			const treeUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parent = makeParent("99999999-9999-9999-9999-999999999999")
			const dirItem = makeDirItem(treeUuid, "Tree")
			const treeUri = `${DIRECTORIES_DIR_URI}/${treeUuid}`

			// Committed tree on disk so removeItem's listDirectories sees it.
			writeDirectoryMeta(treeUuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			let releaseDownload!: () => void
			const downloadGate = new Promise<void>(resolve => {
				releaseDownload = resolve
			})

			let downloadStarted!: () => void
			const downloadStartedPromise = new Promise<void>(resolve => {
				downloadStarted = resolve
			})

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				downloadStarted()

				await downloadGate

				fs.set(`${(destination as { uri: string }).uri}/a.txt`, new Uint8Array([1]))

				return {
					files: [],
					directories: [],
					errors: []
				}
			})

			mockListing({ files: [makeListingFile(fileUuid, "a.txt", "a.txt", 1n)] })

			const reconcile = offline.reconcileTree({ directory: dirItem, parent, skipIndexUpdate: true })

			await downloadStartedPromise

			// removeItem for the SAME uuid must park on the per-uuid lock, not interleave.
			let removed = false
			const removal = (offline.removeItem(dirItem) as Promise<void>).then(() => {
				removed = true
			})

			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			expect(removed).toBe(false)
			expect(fs.has(treeUri)).toBe(true)

			releaseDownload()

			await expect(reconcile).resolves.toEqual([])
			await removal

			// The removal ran strictly AFTER the commit — final state is removed, not resurrected.
			expect(removed).toBe(true)
			expect(fs.has(treeUri)).toBe(false)
			expect(fs.has(`${treeUri}/${treeUuid}.filenmeta`)).toBe(false)
		})
	})
})

describe("shouldSkipOfflineSyncForConnection", () => {
	it("skips when Wi-Fi-only is on and the connection is cellular", () => {
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: "cellular" })).toBe(true)
	})

	it("does NOT skip when Wi-Fi-only is on and the connection is Wi-Fi", () => {
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: "wifi" })).toBe(false)
	})

	it("does NOT skip when Wi-Fi-only is off, even on cellular (default behavior)", () => {
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: false, connectionType: "cellular" })).toBe(false)
	})

	it("only blocks cellular — ethernet/vpn/unknown/null still sync when Wi-Fi-only is on", () => {
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: "ethernet" })).toBe(false)
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: "vpn" })).toBe(false)
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: "unknown" })).toBe(false)
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: null })).toBe(false)
		expect(shouldSkipOfflineSyncForConnection({ wifiOnly: true, connectionType: undefined })).toBe(false)
	})
})

describe("findStaleStoredOfflineEntries", () => {
	const BASE_KEY = "useDriveItemStoredOfflineQuery"
	const FILE_UUID = "11111111-1111-1111-1111-111111111111"
	const DIR_UUID = "22222222-2222-2222-2222-222222222222"
	const GHOST_UUID = "99999999-9999-9999-9999-999999999999"

	const index = {
		files: {
			[FILE_UUID]: {}
		},
		directories: {
			[DIR_UUID]: {}
		}
	}

	function entry(params: unknown, data: unknown): StoredOfflineQueryCacheEntry {
		return {
			queryKey: params === undefined ? [BASE_KEY] : [BASE_KEY, params],
			state: {
				data
			}
		}
	}

	it("returns a true entry whose uuid is missing from the index (file and directory)", () => {
		expect(findStaleStoredOfflineEntries([entry({ type: "file", uuid: GHOST_UUID }, true)], index)).toEqual([
			{ uuid: GHOST_UUID, type: "file" }
		])
		expect(findStaleStoredOfflineEntries([entry({ type: "directory", uuid: GHOST_UUID }, true)], index)).toEqual([
			{ uuid: GHOST_UUID, type: "directory" }
		])
	})

	it("does not return a true entry whose uuid is present in its type's index section", () => {
		expect(findStaleStoredOfflineEntries([entry({ type: "file", uuid: FILE_UUID }, true)], index)).toEqual([])
		expect(findStaleStoredOfflineEntries([entry({ type: "directory", uuid: DIR_UUID }, true)], index)).toEqual([])
	})

	it("checks the index section matching the entry's type — a files-only uuid is stale as a directory", () => {
		expect(findStaleStoredOfflineEntries([entry({ type: "directory", uuid: FILE_UUID }, true)], index)).toEqual([
			{ uuid: FILE_UUID, type: "directory" }
		])
		expect(findStaleStoredOfflineEntries([entry({ type: "file", uuid: DIR_UUID }, true)], index)).toEqual([
			{ uuid: DIR_UUID, type: "file" }
		])
	})

	it("ignores entries whose data is not exactly true", () => {
		expect(
			findStaleStoredOfflineEntries(
				[
					entry({ type: "file", uuid: GHOST_UUID }, false),
					entry({ type: "file", uuid: GHOST_UUID }, undefined),
					entry({ type: "file", uuid: GHOST_UUID }, "true"),
					entry({ type: "file", uuid: GHOST_UUID }, 1)
				],
				index
			)
		).toEqual([])
	})

	it("skips malformed keys without throwing", () => {
		expect(
			findStaleStoredOfflineEntries(
				[
					entry(undefined, true),
					entry(null, true),
					entry("not-an-object", true),
					entry({}, true),
					entry({ type: "file" }, true),
					entry({ type: "file", uuid: "" }, true),
					entry({ type: "file", uuid: 42 }, true),
					entry({ uuid: GHOST_UUID }, true),
					entry({ type: "sharedFile", uuid: GHOST_UUID }, true),
					entry({ type: "banana", uuid: GHOST_UUID }, true)
				],
				index
			)
		).toEqual([])
	})

	it("returns every stale entry across a mixed cache snapshot", () => {
		const result = findStaleStoredOfflineEntries(
			[
				entry({ type: "file", uuid: FILE_UUID }, true),
				entry({ type: "file", uuid: GHOST_UUID }, true),
				entry({ type: "directory", uuid: GHOST_UUID }, true),
				entry({ type: "directory", uuid: DIR_UUID }, true)
			],
			index
		)

		expect(result).toEqual([
			{ uuid: GHOST_UUID, type: "file" },
			{ uuid: GHOST_UUID, type: "directory" }
		])
	})

	it("returns an empty array for an empty cache snapshot", () => {
		expect(findStaleStoredOfflineEntries([], index)).toEqual([])
	})
})
