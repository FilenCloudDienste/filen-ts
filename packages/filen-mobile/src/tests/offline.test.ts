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

vi.mock("@/lib/transfers", () => ({
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

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: vi.fn()
	}
}))

vi.mock("@/stores/useOffline.store", () => ({
	default: {
		getState: vi.fn().mockReturnValue({
			setSyncing: vi.fn()
		})
	}
}))

vi.mock("@/queries/useDriveItemStoredOffline.query", () => ({
	driveItemStoredOfflineQueryUpdate: vi.fn()
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (p: string) =>
		p
			.trim()
			.replace(/^file:\/+/, "/")
			.replace(/\/+/g, "/")
			.replace(/\/$/, ""),
	normalizeModificationTimestampForComparison: (timestamp: number) => Math.floor(timestamp / 1000),
	unwrapFileMeta: vi.fn((file: unknown) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const f = file as any

		if (f && typeof f === "object" && "meta" in f && f.meta && typeof f.meta === "object" && f.meta.tag === "Decoded") {
			return { file, meta: f.meta.inner[0] }
		}

		return { file, meta: { name: "test.txt", size: 100n, modified: 1000, created: 900 } }
	}),
	unwrapDirMeta: vi.fn((dir: unknown) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const extractMeta = (d: any) => {
			if (d && typeof d === "object" && "meta" in d && d.meta && typeof d.meta === "object" && d.meta.tag === "Decoded") {
				return d.meta.inner[0]
			}

			return { name: "test-dir" }
		}

		if (typeof dir === "object" && dir !== null) {
			// Direct Dir object with uuid property
			if ("uuid" in dir) {
				return { dir, uuid: (dir as { uuid: string }).uuid, meta: extractMeta(dir) }
			}

			// AnyNormalDir.Dir/Root wrapper with inner[0].uuid
			if ("inner" in dir) {
				const inner = (dir as { inner: unknown[] }).inner[0]

				if (typeof inner === "object" && inner !== null && "uuid" in inner) {
					return { dir, uuid: (inner as { uuid: string }).uuid, meta: extractMeta(inner) }
				}
			}
		}

		return { dir, uuid: "unknown", meta: { name: "test-dir" } }
	}),
	unwrappedFileIntoDriveItem: vi.fn(
		(unwrapped: { file: { uuid?: string }; meta: { name: string; size: bigint; modified: number; created: number } }) => ({
			type: "file" as const,
			data: {
				uuid: unwrapped.file?.uuid ?? "file-uuid",
				decryptedMeta: {
					name: unwrapped.meta?.name ?? "test.txt",
					size: unwrapped.meta?.size ?? 100n,
					modified: unwrapped.meta?.modified ?? 1000,
					created: unwrapped.meta?.created ?? 900
				},
				inner: unwrapped.file
			}
		})
	),
	unwrappedDirIntoDriveItem: vi.fn((unwrapped: { dir: { uuid?: string }; uuid: string; meta: { name: string } }) => ({
		type: "directory" as const,
		data: {
			uuid: unwrapped.uuid ?? unwrapped.dir?.uuid ?? "dir-uuid",
			decryptedMeta: {
				name: unwrapped.meta?.name ?? "test-dir",
				size: 0n,
				modified: 1000,
				created: 900
			},
			inner: unwrapped.dir
		}
	})),
	unwrapParentUuid: vi.fn(() => null),
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

vi.mock("uuid", () => ({
	validate: (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}))

// eslint-disable-next-line import/first
import { type Index, type FileOrDirectoryOfflineMeta, type DirectoryOfflineMeta } from "@/lib/offline"
// eslint-disable-next-line import/first
import { pack, unpack } from "@/lib/msgpack"
// eslint-disable-next-line import/first
import { fs, File } from "@/tests/mocks/expoFileSystem"
// eslint-disable-next-line import/first
import type { DriveItem } from "@/types"
// eslint-disable-next-line import/first
import { AnyDirWithContext, AnyNormalDir, AnySharedDir, AnySharedDirWithContext, SharingRole_Tags, NonRootDir_Tags, type Dir } from "@filen/sdk-rs"
// eslint-disable-next-line import/first
import transfers from "@/lib/transfers"
// eslint-disable-next-line import/first
import { driveItemStoredOfflineQueryUpdate } from "@/queries/useDriveItemStoredOffline.query"
// eslint-disable-next-line import/first
import auth from "@/lib/auth"
// eslint-disable-next-line import/first
import cache from "@/lib/cache"
// eslint-disable-next-line import/first
import useOfflineStore from "@/stores/useOffline.store"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OfflineInstance = any

const BASE_DIR_URI = "file:///shared/group.io.filen.app/offline_v1"
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
			}
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
			}
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
			}
		}
	} as unknown as DriveItem
}

function makeParent(uuid: string): InstanceType<typeof AnyDirWithContext.Normal> {
	return new AnyDirWithContext.Normal(new AnyNormalDir.Dir({ uuid } as unknown as Dir))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSharedRootParent(uuid: string, role: "Receiver" | "Sharer"): any {
	return new AnyDirWithContext.Shared(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(AnySharedDirWithContext as any).new({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			dir: new (AnySharedDir as any).Root({ inner: { uuid } }),
			shareInfo: { tag: role === "Receiver" ? SharingRole_Tags.Receiver : SharingRole_Tags.Sharer }
		})
	)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSharedDirParent(uuid: string, grandparentUuid: string): any {
	return new AnyDirWithContext.Shared(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(AnySharedDirWithContext as any).new({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			dir: new (AnySharedDir as any).Dir({ inner: { uuid, parent: grandparentUuid } }),
			shareInfo: { tag: SharingRole_Tags.Receiver }
		})
	)
}

function writeIndex(index: Index): void {
	fs.set(INDEX_FILE_URI, new Uint8Array(pack(index)))
}

function readIndex(): Index {
	const bytes = fs.get(INDEX_FILE_URI) as Uint8Array

	return unpack(bytes) as Index
}

function writeFileMeta(uuid: string, meta: FileOrDirectoryOfflineMeta): void {
	const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
	const dirUri = `${FILES_DIR_URI}/${uuid}`

	fs.set(dirUri, "dir")
	fs.set(metaUri, new Uint8Array(pack(meta)))
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
	fs.set(metaUri, new Uint8Array(pack(meta)))
}

async function createOffline(): Promise<OfflineInstance> {
	const mod = await import("@/lib/offline")

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

		it("skips entries where data file is missing", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "gone.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Only write meta, not the data file
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()
			const files = await offline.listFiles()

			expect(files).toEqual([])
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

			// Should be exactly 1 updateIndex call (which does create + write = 2 fs.set calls),
			// not N updateIndex calls from inside Promise.all
			expect(writeCount).toBeLessThanOrEqual(2)

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
				entries: {
					"/SubDir": { item: subDirItem },
					"/SubDir/readme.md": { item: subFileItem }
				}
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
				entries: {
					"/a.txt": { item: file1 },
					"/SubDir": { item: subDir },
					"/SubDir/b.txt": { item: file2 }
				}
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
				entries: {
					"/readme.md": { item: fileItem }
				}
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
				entries: {
					"/file.txt": { item: makeFileItem("33333333-3333-3333-3333-333333333333", "file.txt") }
				}
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
				entries: {
					"/sub": { item: makeDirItem(nestedDirUuid, "sub") },
					"/sub/file.txt": { item: makeFileItem(nestedFileUuid, "file.txt") }
				}
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

			await offline.storeFile({ file: fileItem, parent })

			// Data file should exist
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/download.txt`)).toBeInstanceOf(Uint8Array)

			// Meta file should exist
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)

			// Index should contain the file
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)
			const index = unpack(fs.get(INDEX_FILE_URI) as Uint8Array) as Index

			expect(index.files[uuid]).toBeDefined()
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
					decryptedMeta: null
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

			await offline.storeFile({ file: fileItem, parent })

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

			await offline.storeFile({ file: fileItem, parent, skipIndexUpdate: true })

			// Meta file should exist (store completed)
			expect(fs.get(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBeInstanceOf(Uint8Array)

			// Index should NOT have been written
			expect(fs.has(INDEX_FILE_URI)).toBe(false)
		})
	})

	describe("storeDirectory", () => {
		it("downloads the directory, builds entries, writes meta, and updates the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "Project")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const dataDirectoryUri = `${DIRECTORIES_DIR_URI}/${uuid}`

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				// Simulate the download writing files into the directory
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")
				fs.set(`${destUri}/readme.md`, new Uint8Array([1, 2]))
				fs.set(`${destUri}/src`, "dir")
				fs.set(`${destUri}/src/main.ts`, new Uint8Array([3, 4]))

				return {
					files: [
						{
							file: { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
							path: `${destUri}/readme.md`
						},
						{
							file: { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
							path: `${destUri}/src/main.ts`
						}
					],
					directories: [
						{
							dir: { tag: NonRootDir_Tags.Normal, inner: [{ uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc" }] },
							path: `${destUri}/src`
						}
					]
				}
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent })

			// Meta file should exist
			const metaUri = `${dataDirectoryUri}/${uuid}.filenmeta`

			expect(fs.get(metaUri)).toBeInstanceOf(Uint8Array)

			// Unpack and verify entries were built
			const meta = unpack(fs.get(metaUri) as Uint8Array) as DirectoryOfflineMeta

			expect(Object.keys(meta.entries).length).toBeGreaterThanOrEqual(2)

			// Index should be updated
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)
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
					decryptedMeta: null
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

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Disk full"))

			const offline = await createOffline()

			await expect(offline.storeDirectory({ directory: dirItem, parent })).rejects.toThrow("Disk full")

			// Data directory should be cleaned up
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("skips linked directories in entries", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "WithLinked")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")
			const dataDirectoryUri = `${DIRECTORIES_DIR_URI}/${uuid}`

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")
				fs.set(`${destUri}/linked`, "dir")

				return {
					files: [],
					directories: [
						{
							dir: { tag: NonRootDir_Tags.Linked, inner: [{ uuid: "linked-uuid" }] },
							path: `${destUri}/linked`
						}
					]
				}
			})

			const offline = await createOffline()

			await offline.storeDirectory({ directory: dirItem, parent })

			const metaUri = `${dataDirectoryUri}/${uuid}.filenmeta`
			const meta = unpack(fs.get(metaUri) as Uint8Array) as DirectoryOfflineMeta

			// Linked directory should be excluded from entries
			expect(Object.keys(meta.entries)).toHaveLength(0)
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
				entries: {
					"/docs": { item: makeDirItem(subDirUuid, "docs") },
					"/readme.md": { item: makeFileItem(fileUuid, "readme.md") },
					"/docs/deep.txt": { item: makeFileItem(deepFileUuid, "deep.txt") }
				}
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
				entries: {
					"/sub": { item: makeDirItem(subDirUuid, "sub") },
					"/sub/nested.txt": { item: makeFileItem(deepFileUuid, "nested.txt") }
				}
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
				entries: {
					"/sub": { item: makeDirItem(subDirUuid, "sub") },
					"/sub/file.txt": { item: makeFileItem(fileInSubUuid, "file.txt") }
				}
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
				entries: {
					"/nested.txt": { item: nestedFile }
				}
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
				entries: {
					"/nested.txt": { item: nestedFile },
					"/sub-dir": { item: nestedSubdir }
				}
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
	})

	describe("storeDirectory force option", () => {
		it("re-downloads directory even when already stored when force is true", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "ForceDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Pre-store the directory so isItemStored returns true
			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(dirItem)).toBe(true)

			let downloadCalled = false

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				downloadCalled = true

				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")

				return { files: [], directories: [] }
			})

			await offline.storeDirectory({ directory: dirItem, parent, force: true })

			expect(downloadCalled).toBe(true)
		})

		it("skips download when already stored and force is not set", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "NoForce")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			writeDirectoryMeta(uuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			vi.mocked(transfers.download).mockClear()

			await offline.storeDirectory({ directory: dirItem, parent })

			expect(transfers.download).not.toHaveBeenCalled()
		})
	})

	describe("storeDirectory skipIndexUpdate", () => {
		it("stores directory without updating the index", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "NoIndex")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")

				return { files: [], directories: [] }
			})

			const offline = await createOffline()

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
				entries: {
					"/a.txt": { item: makeFileItem("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "a.txt") }
				}
			})

			writeDirectoryMeta("22222222-2222-2222-2222-222222222222", {
				item: makeDirItem("22222222-2222-2222-2222-222222222222", "Dir2"),
				parent,
				entries: {
					"/b.txt": { item: makeFileItem("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "b.txt") }
				}
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
				entries: {
					"/root-file.txt": { item: makeFileItemWithSize("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "root-file.txt", 200n) },
					"/sub": { item: makeDirItem(subDirUuid, "sub") },
					"/sub/inner.txt": { item: makeFileItemWithSize("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "inner.txt", 300n) },
					"/sub/deep": { item: makeDirItem("cccccccc-cccc-cccc-cccc-cccccccccccc", "deep") },
					"/sub/deep/deep.txt": { item: makeFileItemWithSize("dddddddd-dddd-dddd-dddd-dddddddddddd", "deep.txt", 400n) }
				}
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
				entries: {
					"/nested": { item: makeDirItem(nestedDirUuid, "nested") }
				}
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

	describe("sync", () => {
		it("sets and resets syncing state", async () => {
			const offline = await createOffline()
			const setSyncing = vi.fn()

			vi.mocked(useOfflineStore.getState).mockReturnValue({ setSyncing } as unknown as ReturnType<typeof useOfflineStore.getState>)

			await offline.sync()

			expect(setSyncing).toHaveBeenCalledWith(true)
			expect(setSyncing).toHaveBeenCalledWith(false)
		})

		it("completes without error when no items are stored", async () => {
			const offline = await createOffline()

			await expect(offline.sync()).resolves.not.toThrow()
		})

		it("removes a file when it no longer exists in the remote parent listing", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "deleted-remotely.txt")
			const parent = makeParent(parentUuid)

			// Store file on disk
			writeFileData(uuid, "deleted-remotely.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Verify file is stored
			expect(await offline.isItemStored(fileItem)).toBe(true)

			// Mock SDK to return empty listing (file no longer exists remotely)
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({ files: [], dirs: [] })
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// File directory should be deleted
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/deleted-remotely.txt`)).toBe(false)
		})

		it("re-downloads a file when remote has newer modification time", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "report.txt")
			const parent = makeParent(parentUuid)

			writeFileData(uuid, "report.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(fileItem)).toBe(true)

			// Remote listing returns the same file with a newer modified timestamp
			const newerRemoteFile = {
				uuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "report.txt", size: 200n, modified: 5000, created: 900 }]
				}
			}

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([10, 20, 30, 40, 50]))
				}

				return { files: [], directories: [] }
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [newerRemoteFile],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// The file should have been re-downloaded — new meta should reflect updated modification time
			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
			const metaBytes = fs.get(metaUri) as Uint8Array
			const meta = unpack(metaBytes) as FileOrDirectoryOfflineMeta

			expect((meta.item.data.decryptedMeta as { modified: number } | null)?.modified).toBe(5000)
		})

		it("does not re-download a file when remote has same modification time", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "stable.txt")
			const parent = makeParent(parentUuid)

			writeFileData(uuid, "stable.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote listing returns the same file with the same modified timestamp (1000)
			const sameRemoteFile = {
				uuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "stable.txt", size: 100n, modified: 1000, created: 900 }]
				}
			}

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [sameRemoteFile],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// transfers.download should NOT have been called
			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("removes a file when its parent folder is not found remotely (FolderNotFound)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "orphaned.txt")
			const parent = makeParent(parentUuid)

			writeFileData(uuid, "orphaned.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Mock SDK to throw FolderNotFound
			const folderNotFoundError = new Error("Folder not found")

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockRejectedValue(folderNotFoundError)
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			// Make unwrapSdkError return an error with kind() === FolderNotFound
			const { unwrapSdkError } = await import("@/lib/utils")

			vi.mocked(unwrapSdkError).mockReturnValueOnce({
				kind: () => "FolderNotFound"
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// File should be cleaned up since parent folder doesn't exist
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/orphaned.txt`)).toBe(false)
		})

		it("updates index at the end of sync", async () => {
			const offline = await createOffline()

			await offline.sync()

			// Index file should exist after sync (even if empty)
			expect(fs.get(INDEX_FILE_URI)).toBeInstanceOf(Uint8Array)
		})

		it("updates directory meta when directory is renamed remotely", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "OldName")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(dirItem)).toBe(true)

			// Remote listing returns the same dir UUID but with a new name
			const renamedDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "NewName" }] }
			}

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [renamedDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Meta file should be updated with the new name
			const metaUri = `${DIRECTORIES_DIR_URI}/${dirUuid}/${dirUuid}.filenmeta`
			const metaBytes = fs.get(metaUri) as Uint8Array
			const meta = unpack(metaBytes) as DirectoryOfflineMeta

			expect(meta.item.data.decryptedMeta?.name).toBe("NewName")
		})

		it("removes directory when it no longer exists in the remote parent listing", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "GoneDir")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(dirItem)).toBe(true)

			// Remote listing returns no dirs (directory was deleted remotely)
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Directory data should be deleted
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}`)).toBe(false)
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}/${dirUuid}.filenmeta`)).toBe(false)
		})

		it("replaces directory when a different dir with the same name exists remotely", async () => {
			const oldUuid = "11111111-1111-1111-1111-111111111111"
			const newUuid = "33333333-3333-3333-3333-333333333333"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(oldUuid, "ProjectDir")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(oldUuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			expect(await offline.isItemStored(dirItem)).toBe(true)

			// Remote listing returns a different dir with the same name
			const replacementDir = {
				uuid: newUuid,
				meta: { tag: "Decoded", inner: [{ name: "ProjectDir" }] }
			}

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")

				return { files: [], directories: [] }
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [replacementDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Old directory should be deleted
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${oldUuid}/${oldUuid}.filenmeta`)).toBe(false)

			// New directory should be stored
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${newUuid}/${newUuid}.filenmeta`)).toBe(true)
		})

		it("renames a file when same UUID exists remotely with different name", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "old-name.txt")
			const parent = makeParent(parentUuid)

			writeFileData(uuid, "old-name.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote listing returns the same file UUID but with a different name
			const renamedFile = {
				uuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "new-name.txt", size: 100n, modified: 1000, created: 900 }]
				}
			}

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [renamedFile],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Old data file should be gone, new one should exist
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/old-name.txt`)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/new-name.txt`)).toBe(true)

			// Meta should reflect the new name
			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
			const metaBytes = fs.get(metaUri) as Uint8Array
			const meta = unpack(metaBytes) as FileOrDirectoryOfflineMeta

			expect(meta.item.data.decryptedMeta?.name).toBe("new-name.txt")
		})

		it("replaces a file when a different UUID with the same name exists remotely", async () => {
			const oldUuid = "11111111-1111-1111-1111-111111111111"
			const newUuid = "33333333-3333-3333-3333-333333333333"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(oldUuid, "report.txt")
			const parent = makeParent(parentUuid)

			writeFileData(oldUuid, "report.txt")
			writeFileMeta(oldUuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote listing returns a different file UUID with the same name
			const replacementFile = {
				uuid: newUuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "report.txt", size: 200n, modified: 2000, created: 1500 }]
				}
			}

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([10, 20]))
				}

				return { files: [], directories: [] }
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [replacementFile],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Old file should be deleted
			expect(fs.has(`${FILES_DIR_URI}/${oldUuid}`)).toBe(false)

			// New file should be stored
			expect(fs.has(`${FILES_DIR_URI}/${newUuid}/${newUuid}.filenmeta`)).toBe(true)
		})

		it("triggers full resync when a new file is added inside a stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const existingFileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			const existingFile = makeFileItem(existingFileUuid, "existing.txt")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/existing.txt": { item: existingFile }
				}
			})

			// Write data files so they pass existence checks
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/existing.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote listing: directory still exists
			const remoteDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "MyDir" }] }
			}

			// Remote recursive listing: existing file + a NEW file
			const newRemoteFile = {
				uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
				meta: {
					tag: "Decoded",
					inner: [{ name: "new-file.txt", size: 50n, modified: 2000, created: 1500 }]
				}
			}

			let downloadCalled = false

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				downloadCalled = true

				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")
				fs.set(`${destUri}/existing.txt`, new Uint8Array([1]))
				fs.set(`${destUri}/new-file.txt`, new Uint8Array([2]))

				return {
					files: [
						{ file: { uuid: existingFileUuid }, path: `${destUri}/existing.txt` },
						{ file: { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }, path: `${destUri}/new-file.txt` }
					],
					directories: []
				}
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [remoteDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [
							{
								file: {
									uuid: existingFileUuid,
									meta: { tag: "Decoded", inner: [{ name: "existing.txt", size: 100n, modified: 1000, created: 900 }] }
								},
								path: "/data/existing.txt"
							},
							{
								file: newRemoteFile,
								path: "/data/new-file.txt"
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Full resync should have been triggered (storeDirectory called)
			expect(downloadCalled).toBe(true)
		})

		it("deletes a local file inside a stored directory when removed remotely", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/data/removed.txt": { item: makeFileItem(fileUuid, "removed.txt") }
				}
			})

			// Write the data file that will be removed
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/removed.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote listing: directory still exists but the file is gone
			const remoteDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "MyDir" }] }
			}

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [remoteDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// The file should have been deleted locally
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/removed.txt`)).toBe(false)
		})

		it("triggers full resync when a nested file has newer modification time", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			const localFile = makeFileItem(fileUuid, "report.txt")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/data/report.txt": { item: localFile }
				}
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/report.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			const remoteDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "MyDir" }] }
			}

			// Remote file has newer modified timestamp (5000 > 1000)
			const updatedRemoteFile = {
				uuid: fileUuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "report.txt", size: 200n, modified: 5000, created: 900 }]
				}
			}

			let downloadCalled = false

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				downloadCalled = true

				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")
				fs.set(`${destUri}/report.txt`, new Uint8Array([10, 20]))

				return {
					files: [{ file: { uuid: fileUuid }, path: `${destUri}/report.txt` }],
					directories: []
				}
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [remoteDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [
							{
								file: updatedRemoteFile,
								path: "/data/report.txt"
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Full resync should have been triggered
			expect(downloadCalled).toBe(true)
		})

		it("does not re-sync nested file when normalized timestamps match at sub-second precision", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			// Local file has modified=1000
			const localFile = makeFileItem(fileUuid, "data.txt")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/data/data.txt": { item: localFile }
				}
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/data.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			const remoteDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "MyDir" }] }
			}

			// Remote file has modified=1000.5 — differs only at sub-second precision
			// normalizeModificationTimestampForComparison floors to seconds: Math.floor(1000.5/1000) === Math.floor(1000/1000) === 1
			const remoteFileSubSecond = {
				uuid: fileUuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "data.txt", size: 100n, modified: 1000.5, created: 900 }]
				}
			}

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [remoteDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [
							{
								file: remoteFileSubSecond,
								path: "/data/data.txt"
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// No re-sync should happen — transfers.download should NOT have been called
			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("re-syncs nested file when normalized timestamps actually differ", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			// Local file has modified=1000 (normalizes to 1)
			const localFile = makeFileItem(fileUuid, "data.txt")

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/data/data.txt": { item: localFile }
				}
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/data.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			const remoteDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "MyDir" }] }
			}

			// Remote file has modified=2000 (normalizes to 2, which is > 1)
			const remoteFileNewer = {
				uuid: fileUuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "data.txt", size: 100n, modified: 2000, created: 900 }]
				}
			}

			let downloadCalled = false

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				downloadCalled = true

				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")
				fs.set(`${destUri}/data.txt`, new Uint8Array([10, 20]))

				return {
					files: [{ file: { uuid: fileUuid }, path: `${destUri}/data.txt` }],
					directories: []
				}
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [remoteDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [
							{
								file: remoteFileNewer,
								path: "/data/data.txt"
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Full resync should have been triggered because normalized timestamps differ
			expect(downloadCalled).toBe(true)
		})

		it("keeps directory meta unchanged when name has not changed remotely", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "SameName")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			const metaUri = `${DIRECTORIES_DIR_URI}/${dirUuid}/${dirUuid}.filenmeta`
			const originalMetaBytes = fs.get(metaUri) as Uint8Array

			// Remote listing returns the same dir with the same name
			const sameDir = {
				uuid: dirUuid,
				meta: { tag: "Decoded", inner: [{ name: "SameName" }] }
			}

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [sameDir]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Meta file should not have been rewritten
			const afterMetaBytes = fs.get(metaUri) as Uint8Array

			expect(afterMetaBytes).toBe(originalMetaBytes)
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

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				const destUri = destination instanceof File ? destination.uri : destination.uri
				const destPosix = destUri.replace(/^file:\/+/, "/")

				fs.set(destUri, "dir")
				fs.set(`${destUri}/notes.txt`, new Uint8Array([10, 20, 30]))

				return {
					files: [
						{
							file: { uuid: fileUuid },
							path: `${destPosix}/notes.txt`
						}
					],
					directories: []
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
					decryptedMeta: { name: "shared.txt", size: 50n, modified: 1000, created: 900 }
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
					decryptedMeta: { name: "shared-dir" }
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
					decryptedMeta: { name: "shared-root" }
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
				entries: {
					"/doc.txt": { item: makeFileItem(nestedFileUuid, "doc.txt") }
				}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			const index = readIndex()

			// The directory should be in the index
			expect(index.directories[dirUuid]).toBeDefined()

			// The nested file should also be in the index (from listDirectoriesRecursive)
			expect(index.files[nestedFileUuid]).toBeDefined()
		})

		it("storeFile throws when given a directory type", async () => {
			const dirItem = makeDirItem("11111111-1111-1111-1111-111111111111", "NotAFile")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const offline = await createOffline()

			await expect(offline.storeFile({ file: dirItem, parent })).rejects.toThrow("Item not of type file")
		})

		it("storeFile throws when decryptedMeta is null", async () => {
			const fileItem = {
				type: "file",
				data: {
					uuid: "11111111-1111-1111-1111-111111111111",
					decryptedMeta: null
				}
			} as unknown as DriveItem

			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent })).rejects.toThrow("File missing decrypted meta")
		})

		it("storeFile cleans up on download failure", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "fail.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Network error"))

			const offline = await createOffline()

			await expect(offline.storeFile({ file: fileItem, parent })).rejects.toThrow("Network error")

			// Parent directory should be cleaned up
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/fail.txt`)).toBe(false)
		})

		it("storeDirectory cleans up on download failure", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const dirItem = makeDirItem(uuid, "FailDir")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			vi.mocked(transfers.download).mockRejectedValueOnce(new Error("Download failed"))

			const offline = await createOffline()

			await expect(offline.storeDirectory({ directory: dirItem, parent })).rejects.toThrow("Download failed")

			// Data directory should be cleaned up
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${uuid}`)).toBe(false)
		})

		it("storeFile is a no-op when file is already stored", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const fileItem = makeFileItem(uuid, "already.txt")
			const parent = makeParent("22222222-2222-2222-2222-222222222222")

			// Pre-store the file
			writeFileData(uuid, "already.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Store again — should not call download
			await offline.storeFile({ file: fileItem, parent })

			expect(transfers.download).not.toHaveBeenCalled()
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
				entries: {
					"/a": { item: subDirAItem },
					"/ab": { item: subDirAbItem },
					"/a/file.txt": { item: makeFileItemWithSize(fileInA, "file.txt", 100n) },
					"/ab/file.txt": { item: makeFileItemWithSize(fileInAb, "file.txt", 200n) }
				}
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

		it("sync handles rename + content update simultaneously for a file", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "old-name.txt")
			const parent = makeParent(parentUuid)

			writeFileData(uuid, "old-name.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote has same UUID but new name AND newer modification time
			const renamedAndUpdatedFile = {
				uuid,
				meta: {
					tag: "Decoded",
					inner: [{ name: "new-name.txt", size: 500n, modified: 9000, created: 900 }]
				}
			}

			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }) => {
				if (destination instanceof File) {
					destination.write(new Uint8Array([99, 98, 97]))
				}

				return { files: [], directories: [] }
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [renamedAndUpdatedFile],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// File should be re-downloaded with new name and modification time
			const metaUri = `${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`
			const metaBytes = fs.get(metaUri) as Uint8Array
			const meta = unpack(metaBytes) as FileOrDirectoryOfflineMeta

			expect(meta.item.data.decryptedMeta?.name).toBe("new-name.txt")
			expect((meta.item.data.decryptedMeta as { modified: number } | null)?.modified).toBe(9000)
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
				entries: {
					"/data/nested.txt": { item: nestedFile }
				}
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

	describe("sync error resilience (test 19)", () => {
		it("continues syncing other files when one file's parent listing throws", async () => {
			const uuid1 = "11111111-1111-1111-1111-111111111111"
			const uuid2 = "22222222-2222-2222-2222-222222222222"
			const parent1Uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parent2Uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
			const parent1 = makeParent(parent1Uuid)
			const parent2 = makeParent(parent2Uuid)

			const file1 = makeFileItem(uuid1, "ok.txt")
			const file2 = makeFileItem(uuid2, "fail.txt")

			// Store both files
			writeFileData(uuid1, "ok.txt")
			writeFileMeta(uuid1, { item: file1, parent: parent1 })
			writeFileData(uuid2, "fail.txt")
			writeFileMeta(uuid2, { item: file2, parent: parent2 })

			const offline = await createOffline()

			await offline.updateIndex()

			// Mock SDK: parent1 succeeds (file still exists), parent2 throws
			const listDirParent1 = vi.fn().mockResolvedValue({
				files: [
					{
						uuid: uuid1,
						meta: { tag: "Decoded", inner: [{ name: "ok.txt", size: 100n, modified: 1000, created: 900 }] }
					}
				],
				dirs: []
			})

			const listDirParent2 = vi.fn().mockRejectedValue(new Error("Network timeout"))

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockImplementation((dir: { inner: unknown[] }) => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const uuid = ((dir as any).inner ?? [(dir as any)])[0]?.uuid ?? (dir as any).uuid

						if (uuid === parent1Uuid) {
							return listDirParent1()
						}

						return listDirParent2()
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			// Sync should complete without throwing
			await expect(offline.sync()).resolves.not.toThrow()

			// File 1 should still be intact (its parent listing succeeded)
			expect(fs.has(`${FILES_DIR_URI}/${uuid1}/ok.txt`)).toBe(true)
		})

		it("continues syncing directories when one directory's content sync throws", async () => {
			const dir1Uuid = "11111111-1111-1111-1111-111111111111"
			const dir2Uuid = "22222222-2222-2222-2222-222222222222"
			const parentUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dir1Uuid, {
				item: makeDirItem(dir1Uuid, "GoodDir"),
				parent,
				entries: {}
			})

			writeDirectoryMeta(dir2Uuid, {
				item: makeDirItem(dir2Uuid, "BadDir"),
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			// Both dirs exist remotely, but listDirRecursiveWithPaths fails for dir2
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [
							{ uuid: dir1Uuid, meta: { tag: "Decoded", inner: [{ name: "GoodDir" }] } },
							{ uuid: dir2Uuid, meta: { tag: "Decoded", inner: [{ name: "BadDir" }] } }
						]
					}),
					listDirRecursiveWithPaths: vi.fn().mockImplementation((dir: { inner: unknown[] }) => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const innerDir = (dir as any).inner?.[0]

						if (innerDir?.uuid === dir2Uuid || innerDir?.inner?.[0]?.uuid === dir2Uuid) {
							throw new Error("SDK crash for dir2")
						}

						return Promise.resolve({ files: [], dirs: [] })
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			// Sync should complete without throwing
			await expect(offline.sync()).resolves.not.toThrow()

			// Dir1 should still be intact
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dir1Uuid}/${dir1Uuid}.filenmeta`)).toBe(true)
		})
	})

	describe("sync with shared directory listing paths (test 20)", () => {
		it("calls listInSharedRoot for a shared root receiver parent", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "shared-file.txt")

			// Create a shared root receiver parent
			const sharedRootParent = makeSharedRootParent(parentUuid, "Receiver")

			writeFileData(uuid, "shared-file.txt")
			writeFileMeta(uuid, { item: fileItem, parent: sharedRootParent })

			const offline = await createOffline()

			await offline.updateIndex()

			const listInSharedRoot = vi.fn().mockResolvedValue({
				files: [
					{
						uuid,
						meta: { tag: "Decoded", inner: [{ name: "shared-file.txt", size: 100n, modified: 1000, created: 900 }] }
					}
				],
				dirs: []
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listInSharedRoot
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			expect(listInSharedRoot).toHaveBeenCalled()
		})

		it("calls listOutShared for a shared root sharer parent", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "shared-out.txt")

			const sharedRootParent = makeSharedRootParent(parentUuid, "Sharer")

			writeFileData(uuid, "shared-out.txt")
			writeFileMeta(uuid, { item: fileItem, parent: sharedRootParent })

			const offline = await createOffline()

			await offline.updateIndex()

			const listOutShared = vi.fn().mockResolvedValue({
				files: [
					{
						uuid,
						meta: { tag: "Decoded", inner: [{ name: "shared-out.txt", size: 100n, modified: 1000, created: 900 }] }
					}
				],
				dirs: []
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listOutShared
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			expect(listOutShared).toHaveBeenCalled()
		})

		it("calls listSharedDir for a shared non-root directory parent", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const grandparentUuid = "33333333-3333-3333-3333-333333333333"
			const fileItem = makeFileItem(uuid, "nested-shared.txt")

			const sharedDirParent = makeSharedDirParent(parentUuid, grandparentUuid)

			// Set up cache and unwrapParentUuid for shared dir listing
			cache.directoryUuidToAnySharedDirWithContext.set(grandparentUuid, {
				shareInfo: { tag: SharingRole_Tags.Receiver }
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			const { unwrapParentUuid } = await import("@/lib/utils")

			vi.mocked(unwrapParentUuid).mockReturnValueOnce(grandparentUuid)

			writeFileData(uuid, "nested-shared.txt")
			writeFileMeta(uuid, { item: fileItem, parent: sharedDirParent })

			const offline = await createOffline()

			await offline.updateIndex()

			const listSharedDir = vi.fn().mockResolvedValue({
				files: [
					{
						uuid,
						meta: { tag: "Decoded", inner: [{ name: "nested-shared.txt", size: 100n, modified: 1000, created: 900 }] }
					}
				],
				dirs: []
			})

			vi.mocked(unwrapParentUuid).mockReturnValueOnce(grandparentUuid)

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listSharedDir
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			expect(listSharedDir).toHaveBeenCalled()

			// Clean up cache
			cache.directoryUuidToAnySharedDirWithContext.delete(grandparentUuid)
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
					sharingRole: { tag: SharingRole_Tags.Receiver }
				}
			} as unknown as DriveItem

			const childFile = makeFileItem(childFileUuid, "child.txt")

			writeDirectoryMeta(topUuid, {
				item: sharedRootDirItem,
				parent,
				entries: {
					"/child.txt": { item: childFile }
				}
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
					inner: { parent: sharedParentUuid }
				}
			} as unknown as DriveItem

			writeDirectoryMeta(topUuid, {
				item: topDirItem,
				parent,
				entries: {
					"/SharedSub": { item: sharedSubDir },
					"/SharedSub/data.txt": { item: makeFileItem(fileInSharedUuid, "data.txt") }
				}
			})

			// Set up cache and mock for sharedDirectory parent resolution
			cache.directoryUuidToAnySharedDirWithContext.set(sharedParentUuid, {
				shareInfo: { tag: SharingRole_Tags.Receiver }
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			const { unwrapParentUuid } = await import("@/lib/utils")

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

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
		it("sync deletes local subdirectory when removed remotely from stored directory", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const subDirUuid = "22222222-2222-2222-2222-222222222222"
			const parentUuid = "33333333-3333-3333-3333-333333333333"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/sub": { item: makeDirItem(subDirUuid, "sub") }
				}
			})

			// Create the subdirectory on disk
			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/sub`, "dir")

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote: dir still exists but subdir was removed
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [{ uuid: dirUuid, meta: { tag: "Decoded", inner: [{ name: "MyDir" }] } }]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Local subdirectory should be deleted
			expect(fs.has(`${DIRECTORIES_DIR_URI}/${dirUuid}/sub`)).toBe(false)
		})

		it("sync triggers full resync when new subdirectory added remotely", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {}
			})

			const offline = await createOffline()

			await offline.updateIndex()

			let downloadCalled = false

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			vi.mocked(transfers.download).mockImplementationOnce(async ({ destination }): Promise<any> => {
				downloadCalled = true

				const destUri = destination instanceof File ? destination.uri : destination.uri

				fs.set(destUri, "dir")
				fs.set(`${destUri}/newSubDir`, "dir")

				return {
					files: [],
					directories: [
						{
							dir: { tag: NonRootDir_Tags.Normal, inner: [{ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }] },
							path: `${destUri}/newSubDir`
						}
					]
				}
			})

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [{ uuid: dirUuid, meta: { tag: "Decoded", inner: [{ name: "MyDir" }] } }]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [],
						dirs: [
							{
								dir: { tag: NonRootDir_Tags.Normal, inner: [{ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }] },
								path: "/newSubDir"
							}
						]
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Full resync should have been triggered because of new remote subdirectory
			expect(downloadCalled).toBe(true)
		})

		it("sync does not trigger resync when directory content is unchanged", async () => {
			const dirUuid = "11111111-1111-1111-1111-111111111111"
			const fileUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const dirItem = makeDirItem(dirUuid, "MyDir")
			const parent = makeParent(parentUuid)

			writeDirectoryMeta(dirUuid, {
				item: dirItem,
				parent,
				entries: {
					"/data/file.txt": { item: makeFileItem(fileUuid, "file.txt") }
				}
			})

			fs.set(`${DIRECTORIES_DIR_URI}/${dirUuid}/data/file.txt`, new Uint8Array([1]))

			const offline = await createOffline()

			await offline.updateIndex()

			// Remote: everything matches local
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [],
						dirs: [{ uuid: dirUuid, meta: { tag: "Decoded", inner: [{ name: "MyDir" }] } }]
					}),
					listDirRecursiveWithPaths: vi.fn().mockResolvedValue({
						files: [
							{
								file: {
									uuid: fileUuid,
									meta: { tag: "Decoded", inner: [{ name: "file.txt", size: 100n, modified: 1000, created: 900 }] }
								},
								path: "/data/file.txt"
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// No download should have been triggered
			expect(transfers.download).not.toHaveBeenCalled()
		})

		it("sync cleans up when data file name on disk doesn't match meta name", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const parent = makeParent(parentUuid)

			// Store file with name "original.txt" in meta but name the data file differently on disk
			// This simulates a corruption scenario where meta and data are out of sync
			const fileItem = makeFileItem(uuid, "original.txt")

			// Write data file with a DIFFERENT name than what meta says
			writeFileData(uuid, "actual-on-disk.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			// listFiles() finds "actual-on-disk.txt" as the data file, returns the item with meta name "original.txt"
			// But during sync, dataFile is constructed from meta name "original.txt" — which doesn't exist
			// The cleanup code should delete the parent directory

			await offline.updateIndex()

			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [
							{
								uuid,
								meta: { tag: "Decoded", inner: [{ name: "original.txt", size: 100n, modified: 1000, created: 900 }] }
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// Parent directory should be cleaned up since the data file path from meta didn't exist
			expect(fs.has(`${FILES_DIR_URI}/${uuid}`)).toBe(false)
		})

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

		it("parentCacheKey handles Linked directory context via sync", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "linked-file.txt")

			// Create a Linked parent context (plain object matching the shape parentCacheKey expects)
			const linkedParent = {
				tag: "Linked",
				inner: [
					{
						dir: { tag: "Dir", inner: [{ inner: { uuid: parentUuid } }] }
					}
				]
			}

			writeFileData(uuid, "linked-file.txt")
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			writeFileMeta(uuid, { item: fileItem, parent: linkedParent as any })

			const offline = await createOffline()

			await offline.updateIndex()

			// Sync will call parentCacheKey (Linked branch) and then hit "Unsupported directory type"
			// in the listing switch — our error isolation should catch it and skip the parent
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await expect(offline.sync()).resolves.not.toThrow()

			// File should be preserved since the parent listing was skipped
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/linked-file.txt`)).toBe(true)
		})

		it("parentCacheKey handles Normal Root sub-case", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "root-file.txt")

			// Create a Normal Root parent (instead of the usual Normal Dir)
			const rootParent = new AnyDirWithContext.Normal(new AnyNormalDir.Root({ uuid: parentUuid } as unknown as Dir))

			writeFileData(uuid, "root-file.txt")
			writeFileMeta(uuid, { item: fileItem, parent: rootParent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Sync should work — parentCacheKey will produce "root:{uuid}"
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockResolvedValue({
						files: [
							{
								uuid,
								meta: { tag: "Decoded", inner: [{ name: "root-file.txt", size: 100n, modified: 1000, created: 900 }] }
							}
						],
						dirs: []
					})
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await expect(offline.sync()).resolves.not.toThrow()

			// File should still be intact
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/root-file.txt`)).toBe(true)
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

		it("readIndex recovers from a valid msgpack encoding of empty object", async () => {
			// Write valid msgpack for {} — keys length 0 triggers the "Index file is empty" check
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

		it("sync skips items whose parent listing failed (non-FolderNotFound)", async () => {
			const uuid = "11111111-1111-1111-1111-111111111111"
			const parentUuid = "22222222-2222-2222-2222-222222222222"
			const fileItem = makeFileItem(uuid, "preserved.txt")
			const parent = makeParent(parentUuid)

			writeFileData(uuid, "preserved.txt")
			writeFileMeta(uuid, { item: fileItem, parent })

			const offline = await createOffline()

			await offline.updateIndex()

			// Mock SDK to throw a transient error (not FolderNotFound)
			vi.mocked(auth.getSdkClients).mockResolvedValueOnce({
				authedSdkClient: {
					listDir: vi.fn().mockRejectedValue(new Error("Connection refused"))
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)

			await offline.sync()

			// File should NOT be deleted — parent listing failed, so item was skipped
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/preserved.txt`)).toBe(true)
			expect(fs.has(`${FILES_DIR_URI}/${uuid}/${uuid}.filenmeta`)).toBe(true)
		})
	})
})
