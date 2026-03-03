import { describe, it, expect, vi, beforeEach } from "vitest"
import { pack } from "msgpackr"
import type { DriveItem } from "@/types"
import type { AnyDirEnumWithShareInfo } from "@filen/sdk-rs"

// ── In-memory VFS ─────────────────────────────────────────────────────────────

const vfsFiles = new Map<string, Uint8Array>()
const vfsDirs = new Set<string>()

function vfsNorm(p: string): string {
	return ("/" + p.replace(/^\/+/, "")).replace(/\/+/g, "/").replace(/(?<!^)\/$/, "")
}

class MockFile {
	private _uri: string

	constructor(uri: string) {
		this._uri = vfsNorm(uri)
	}

	get uri() {
		return this._uri
	}

	get name() {
		return this._uri.split("/").at(-1) ?? ""
	}

	get size() {
		return vfsFiles.get(this._uri)?.length ?? 0
	}

	get exists() {
		return vfsFiles.has(this._uri)
	}

	get parentDirectory() {
		return new MockDirectory(this._uri.split("/").slice(0, -1).join("/") || "/")
	}

	async bytes(): Promise<Uint8Array> {
		return vfsFiles.get(this._uri) ?? new Uint8Array()
	}

	write(data: Uint8Array) {
		vfsFiles.set(this._uri, data)
	}

	rename(newName: string) {
		const dir = this._uri.split("/").slice(0, -1).join("/")
		const newUri = vfsNorm(dir + "/" + newName)
		const data = vfsFiles.get(this._uri)

		if (data !== undefined) {
			vfsFiles.delete(this._uri)
			vfsFiles.set(newUri, data)
			this._uri = newUri
		}
	}
}

class MockDirectory {
	constructor(readonly uri: string) {}

	get name() {
		return this.uri.split("/").at(-1) ?? ""
	}

	get exists() {
		return vfsDirs.has(this.uri)
	}

	create({ intermediates = false, idempotent = false }: { intermediates?: boolean; idempotent?: boolean } = {}) {
		if (!idempotent && vfsDirs.has(this.uri)) {
			return
		}

		vfsDirs.add(this.uri)

		if (intermediates) {
			const parts = this.uri.split("/")

			for (let i = 1; i < parts.length; i++) {
				vfsDirs.add(parts.slice(0, i + 1).join("/") || "/")
			}
		}
	}

	delete() {
		const prefix = this.uri + "/"

		for (const k of [...vfsFiles.keys()]) {
			if (k === this.uri || k.startsWith(prefix)) {
				vfsFiles.delete(k)
			}
		}

		for (const d of [...vfsDirs]) {
			if (d === this.uri || d.startsWith(prefix)) {
				vfsDirs.delete(d)
			}
		}
	}

	list(): (MockFile | MockDirectory)[] {
		const prefix = this.uri + "/"
		const results: (MockFile | MockDirectory)[] = []
		const seenDirs = new Set<string>()

		for (const fileUri of vfsFiles.keys()) {
			if (!fileUri.startsWith(prefix)) {
				continue
			}

			const rel = fileUri.slice(prefix.length)

			if (!rel.includes("/")) {
				results.push(new MockFile(fileUri))
			}
		}

		for (const dirUri of vfsDirs) {
			if (!dirUri.startsWith(prefix)) {
				continue
			}

			const rel = dirUri.slice(prefix.length)

			if (!rel.includes("/") && !seenDirs.has(dirUri)) {
				results.push(new MockDirectory(dirUri))
				seenDirs.add(dirUri)
			}
		}

		return results
	}
}

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("expo-file-system", () => ({
	Directory: MockDirectory,
	File: MockFile,
	Paths: {
		document: { uri: "/vfs/doc" },
		appleSharedContainers: undefined,
		join: (...parts: string[]) => vfsNorm(parts.join("/")),
		dirname: (p: string) => p.split("/").slice(0, -1).join("/") || "/"
	}
}))

vi.mock("react-native", () => ({
	Platform: {
		select: ({ default: def }: { default: string }) => def
	}
}))

vi.mock("@filen/sdk-rs", () => {
	class Tagged {
		tag: string
		inner: unknown[]

		constructor(tag: string, inner: unknown) {
			this.tag = tag
			this.inner = [inner]
		}
	}

	return {
		AnyDirEnum: {
			Dir: class extends Tagged {
				constructor(d: unknown) {
					super("Dir", d)
				}
			},
			Root: class extends Tagged {
				constructor(d: unknown) {
					super("Root", d)
				}
			}
		},
		AnyDirEnumWithShareInfo: {
			Dir: class extends Tagged {
				constructor(d: unknown) {
					super("Dir", d)
				}
			},
			Root: class extends Tagged {
				constructor(d: unknown) {
					super("Root", d)
				}
			},
			SharedDir: class extends Tagged {
				constructor(d: unknown) {
					super("SharedDir", d)
				}
			}
		},
		AnyDirEnumWithShareInfo_Tags: { Dir: "Dir", Root: "Root", SharedDir: "SharedDir" },
		DirEnum: {
			Dir: class extends Tagged {
				constructor(d: unknown) {
					super("Dir", d)
				}
			},
			Root: class extends Tagged {
				constructor(d: unknown) {
					super("Root", d)
				}
			}
		},
		DirWithMetaEnum_Tags: { Dir: "Dir", Root: "Root" },
		SharingRole_Tags: { Sharer: "Sharer", Receiver: "Receiver" },
		ErrorKind: { FolderNotFound: "FolderNotFound" }
	}
})

const mockDownload = vi.fn()

vi.mock("@/lib/transfers", () => ({
	default: { download: mockDownload }
}))

const mockGetSdkClients = vi.fn()

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: mockGetSdkClients }
}))

const mockSetSyncing = vi.fn()

vi.mock("@/stores/useOffline.store", () => ({
	default: { getState: () => ({ setSyncing: mockSetSyncing }) }
}))

const mockQueryUpdate = vi.fn()

vi.mock("@/queries/useDriveItemStoredOffline.query", () => ({
	driveItemStoredOfflineQueryUpdate: mockQueryUpdate
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.test"
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (p: string) => ("/" + p.replace(/^\/+/, "")).replace(/\/+/g, "/").replace(/(?<!^)\/$/, "") || "/",
	unwrapFileMeta: vi.fn((f: unknown) => ({
		meta: (f as Record<string, unknown>)["_meta"] ?? null,
		shared: false,
		file: f
	})),
	unwrapDirMeta: vi.fn((d: unknown) => {
		const obj = d as Record<string, unknown>

		return {
			meta: obj["_meta"] ?? null,
			shared: false,
			dir: d,
			uuid: (obj["_uuid"] as string | undefined) ?? (obj["uuid"] as string | undefined) ?? ""
		}
	}),
	unwrappedDirIntoDriveItem: vi.fn((u: unknown) => (u as Record<string, unknown>)["_driveItem"]),
	unwrappedFileIntoDriveItem: vi.fn((u: unknown) => (u as Record<string, unknown>)["_driveItem"]),
	unwrapSdkError: vi.fn(() => null)
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

// Valid v4 UUIDs so validateUuid() passes
const UUID_FILE = "550e8400-e29b-41d4-a716-446655440001"
const UUID_FILE_2 = "550e8400-e29b-41d4-a716-446655440002"
const UUID_DIR = "550e8400-e29b-41d4-a716-446655440010"

// Base paths derived from the mock Paths.document.uri + offline_v1
const BASE = "/vfs/doc/offline_v1"
const FILES_DIR = `${BASE}/files`
const DIRS_DIR = `${BASE}/directories`
const INDEX_PATH = `${BASE}/index`

function makeFileItem(uuid: string, name = "photo.jpg"): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			size: 1024n,
			decryptedMeta: {
				name,
				size: 1024n,
				modified: 1000
			}
		}
	} as unknown as DriveItem
}

function makeSharedFileItem(uuid: string, name = "shared.jpg"): DriveItem {
	return {
		type: "sharedFile",
		data: {
			uuid,
			size: 512n,
			decryptedMeta: {
				name,
				size: 512n,
				modified: 2000
			}
		}
	} as unknown as DriveItem
}

function makeDirItem(uuid: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			size: 0n,
			decryptedMeta: { name: "myfolder" },
			dir: { tag: "Dir", inner: [{ uuid }] }
		}
	} as unknown as DriveItem
}

function makeDirParent(uuid = "parent-00000000-0000-0000-0000-000000000001"): AnyDirEnumWithShareInfo {
	return {
		tag: "Dir",
		inner: [{ uuid }]
	} as unknown as AnyDirEnumWithShareInfo
}

// Write a file meta to the VFS as if storeFile had run
function seedFileMeta(uuid: string, name: string, parent: AnyDirEnumWithShareInfo) {
	const item = makeFileItem(uuid, name)
	const metaPath = `${FILES_DIR}/${uuid}/${uuid}.filenmeta`
	const dataPath = `${FILES_DIR}/${uuid}/${name}`

	vfsDirs.add(`${FILES_DIR}/${uuid}`)
	vfsFiles.set(dataPath, new Uint8Array([1, 2, 3]))
	vfsFiles.set(metaPath, new Uint8Array(pack({
		item,
		parent
	})))

	return {
		item,
		metaPath,
		dataPath
	}
}

// Write a directory meta to the VFS as if storeDirectory had run
function seedDirMeta(uuid: string, parent: AnyDirEnumWithShareInfo, entries: Record<string, { item: DriveItem }> = {}) {
	const item = makeDirItem(uuid)
	const metaPath = `${DIRS_DIR}/${uuid}/${uuid}.filenmeta`

	vfsDirs.add(`${DIRS_DIR}/${uuid}`)
	vfsFiles.set(metaPath, new Uint8Array(pack({
		item,
		parent,
		entries
	})))

	return {
		item,
		metaPath
	}
}

// Build a populated index and write it to the VFS
function seedIndex(
	files: Record<string, { item: DriveItem; parent: AnyDirEnumWithShareInfo }>,
	directories: Record<string, { item: DriveItem; parent: AnyDirEnumWithShareInfo }>
) {
	vfsDirs.add(BASE)
	vfsFiles.set(INDEX_PATH, new Uint8Array(pack({
		files,
		directories
	})))
}

// Import the class AFTER all vi.mock() calls (mocks are hoisted, but the import
// needs the aliases resolved which happens at runtime)
const { Offline } = await import("../lib/offline")

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Offline", () => {
	let offline: InstanceType<typeof Offline>

	beforeEach(() => {
		vfsFiles.clear()
		vfsDirs.clear()
		vi.clearAllMocks()
		mockDownload.mockResolvedValue({
			files: [],
			directories: []
		})
		offline = new Offline()
	})

	// ── isItemStored ─────────────────────────────────────────────────────────

	describe("isItemStored", () => {
		it("returns false when index does not exist", async () => {
			const item = makeFileItem(UUID_FILE)

			expect(await offline.isItemStored(item)).toBe(false)
		})

		it("returns true for a file present in the index", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			expect(await offline.isItemStored(item)).toBe(true)
		})

		it("returns false for a file absent from the index", async () => {
			const item = makeFileItem(UUID_FILE)
			const other = makeFileItem(UUID_FILE_2)
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE_2]: {
					item: other,
					parent
				}
			}, {})

			expect(await offline.isItemStored(item)).toBe(false)
		})

		it("returns true for a directory present in the index", async () => {
			const item = makeDirItem(UUID_DIR)
			const parent = makeDirParent()

			seedIndex({}, {
				[UUID_DIR]: {
					item,
					parent
				}
			})

			expect(await offline.isItemStored(item)).toBe(true)
		})

		it("caches true result — second call does not re-read the index", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			await offline.isItemStored(item)

			// Remove the index from VFS — a cache miss would re-read and get false
			vfsFiles.delete(INDEX_PATH)

			expect(await offline.isItemStored(item)).toBe(true)
		})

		it("caches false result — second call does not re-read the index", async () => {
			const item = makeFileItem(UUID_FILE)

			seedIndex({}, {})

			await offline.isItemStored(item)

			// Now seed a real entry — a cache miss would re-read and get true
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			expect(await offline.isItemStored(item)).toBe(false)
		})
	})

	// ── listFiles ────────────────────────────────────────────────────────────

	describe("listFiles", () => {
		it("returns empty array when no files are stored", async () => {
			const files = await offline.listFiles()

			expect(files).toHaveLength(0)
		})

		it("returns a stored file with correct item and parent", async () => {
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)

			const files = await offline.listFiles()

			expect(files).toHaveLength(1)
			expect(files[0]?.item.data.uuid).toBe(UUID_FILE)
			expect(files[0]?.item.type).toBe("file")
		})

		it("includes sharedFile type items (not just file)", async () => {
			const parent = makeDirParent()
			const sharedItem = makeSharedFileItem(UUID_FILE, "shared.jpg")
			const metaPath = `${FILES_DIR}/${UUID_FILE}/${UUID_FILE}.filenmeta`
			const dataPath = `${FILES_DIR}/${UUID_FILE}/shared.jpg`

			vfsDirs.add(`${FILES_DIR}/${UUID_FILE}`)
			vfsFiles.set(dataPath, new Uint8Array([1]))
			vfsFiles.set(metaPath, new Uint8Array(pack({
				item: sharedItem,
				parent
			})))

			const files = await offline.listFiles()

			expect(files).toHaveLength(1)
			expect(files[0]?.item.type).toBe("sharedFile")
		})

		it("ignores entries with no meta file", async () => {
			// Seed a data file but no .filenmeta
			vfsDirs.add(`${FILES_DIR}/${UUID_FILE}`)
			vfsFiles.set(`${FILES_DIR}/${UUID_FILE}/photo.jpg`, new Uint8Array([1]))

			const files = await offline.listFiles()

			expect(files).toHaveLength(0)
		})

		it("populates cache — second call returns same reference", async () => {
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)

			const first = await offline.listFiles()
			const second = await offline.listFiles()

			expect(second).toBe(first)
		})

		it("returns multiple files", async () => {
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)
			seedFileMeta(UUID_FILE_2, "video.mp4", parent)

			const files = await offline.listFiles()

			expect(files).toHaveLength(2)

			const uuids = files.map(f => f.item.data.uuid).sort()

			expect(uuids).toEqual([UUID_FILE, UUID_FILE_2].sort())
		})
	})

	// ── listDirectories ──────────────────────────────────────────────────────

	describe("listDirectories", () => {
		it("returns empty when nothing stored", async () => {
			const { directories } = await offline.listDirectories()

			expect(directories).toHaveLength(0)
		})

		it("returns a stored top-level directory", async () => {
			const parent = makeDirParent()

			seedDirMeta(UUID_DIR, parent)

			const { directories } = await offline.listDirectories()

			expect(directories).toHaveLength(1)
			expect(directories[0]?.item.data.uuid).toBe(UUID_DIR)
		})

		it("caches the root listing — second call returns same reference", async () => {
			const parent = makeDirParent()

			seedDirMeta(UUID_DIR, parent)

			const first = await offline.listDirectories()
			const second = await offline.listDirectories()

			expect(second).toBe(first)
		})
	})

	// ── storeFile ────────────────────────────────────────────────────────────

	describe("storeFile", () => {
		it("calls transfers.download with the correct item and destination", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			mockDownload.mockImplementation(async ({ destination }: { destination: MockFile }) => {
				vfsFiles.set(destination.uri, new Uint8Array([1, 2, 3]))

				return {
					files: [],
					directories: []
				}
			})

			await offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})

			expect(mockDownload).toHaveBeenCalledOnce()

			const call = mockDownload.mock.calls[0]?.[0] as { item: DriveItem; itemUuid: string }

			expect(call.item).toBe(item)
			expect(call.itemUuid).toBe(UUID_FILE)
		})

		it("writes the .filenmeta file after download", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()
			const metaPath = `${FILES_DIR}/${UUID_FILE}/${UUID_FILE}.filenmeta`

			mockDownload.mockImplementation(async ({ destination }: { destination: MockFile }) => {
				vfsFiles.set(destination.uri, new Uint8Array([1]))

				return {
					files: [],
					directories: []
				}
			})

			await offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})

			expect(vfsFiles.has(metaPath)).toBe(true)
			expect(vfsFiles.get(metaPath)!.length).toBeGreaterThan(0)
		})

		it("returns early without downloading if item is already stored", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			await offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})

			expect(mockDownload).not.toHaveBeenCalled()
		})

		it("calls updateIndex when skipIndexUpdate is not set", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			mockDownload.mockImplementation(async ({ destination }: { destination: MockFile }) => {
				vfsFiles.set(destination.uri, new Uint8Array([1]))

				return {
					files: [],
					directories: []
				}
			})

			await offline.storeFile({
				file: item,
				parent
			})

			// updateIndex writes to the index file
			expect(vfsFiles.has(INDEX_PATH)).toBe(true)
		})

		it("does not call updateIndex when skipIndexUpdate is true", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			mockDownload.mockImplementation(async ({ destination }: { destination: MockFile }) => {
				vfsFiles.set(destination.uri, new Uint8Array([1]))

				return {
					files: [],
					directories: []
				}
			})

			await offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})

			expect(vfsFiles.has(INDEX_PATH)).toBe(false)
		})

		it("cleans up the data directory when download fails", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			mockDownload.mockRejectedValue(new Error("Network error"))

			await expect(offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})).rejects.toThrow("Network error")

			// Parent directory should be deleted
			expect(vfsDirs.has(`${FILES_DIR}/${UUID_FILE}`)).toBe(false)
		})

		it("throws for non-file item types", async () => {
			const item = makeDirItem(UUID_DIR)
			const parent = makeDirParent()

			await expect(offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})).rejects.toThrow("Item not of type file")
		})

		it("throws when item has no decryptedMeta", async () => {
			const item = { type: "file", data: { uuid: UUID_FILE, decryptedMeta: null } } as unknown as DriveItem
			const parent = makeDirParent()

			await expect(offline.storeFile({
				file: item,
				parent,
				skipIndexUpdate: true
			})).rejects.toThrow("File missing decrypted meta")
		})
	})

	// ── removeItem ───────────────────────────────────────────────────────────

	describe("removeItem", () => {
		it("deletes the file directory and updates the index", async () => {
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)
			seedIndex({
				[UUID_FILE]: {
					item: makeFileItem(UUID_FILE),
					parent
				}
			}, {})

			await offline.removeItem(makeFileItem(UUID_FILE))

			expect(vfsDirs.has(`${FILES_DIR}/${UUID_FILE}`)).toBe(false)
			expect(vfsFiles.has(`${FILES_DIR}/${UUID_FILE}/photo.jpg`)).toBe(false)
			expect(vfsFiles.has(INDEX_PATH)).toBe(true)
		})

		it("makes isItemStored return false after removal", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)
			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			await offline.removeItem(item)

			expect(await offline.isItemStored(item)).toBe(false)
		})

		it("removes a top-level offline directory", async () => {
			const parent = makeDirParent()

			seedDirMeta(UUID_DIR, parent)
			seedIndex({}, {
				[UUID_DIR]: {
					item: makeDirItem(UUID_DIR),
					parent
				}
			})

			await offline.removeItem(makeDirItem(UUID_DIR))

			expect(vfsDirs.has(`${DIRS_DIR}/${UUID_DIR}`)).toBe(false)
			expect(vfsFiles.has(INDEX_PATH)).toBe(true)
		})

		it("does nothing for a file that is not stored", async () => {
			const item = makeFileItem(UUID_FILE)

			// No VFS data, no index — should complete without error
			await expect(offline.removeItem(item)).resolves.not.toThrow()

			expect(vfsFiles.has(INDEX_PATH)).toBe(false)
		})
	})

	// ── cache invalidation ───────────────────────────────────────────────────

	describe("cache invalidation", () => {
		it("storeFile clears listFilesCache so the next listFiles rescans", async () => {
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)

			// Warm up cache
			const before = await offline.listFiles()

			expect(before).toHaveLength(1)

			// Store a second file (the mock seeds its data file so updateIndex can see it)
			mockDownload.mockImplementation(async ({ destination }: { destination: MockFile }) => {
				vfsFiles.set(destination.uri, new Uint8Array([1]))

				return {
					files: [],
					directories: []
				}
			})

			const item2 = makeFileItem(UUID_FILE_2, "video.mp4")

			await offline.storeFile({
				file: item2,
				parent
			})

			// Cache was invalidated by updateIndex — next call rescans and finds 2 files
			const after = await offline.listFiles()

			expect(after).toHaveLength(2)
		})

		it("removeItem clears isItemStoredCache so the next check rescans", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedFileMeta(UUID_FILE, "photo.jpg", parent)
			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			// Warm up the isItemStored cache with true
			expect(await offline.isItemStored(item)).toBe(true)

			// Remove the item
			await offline.removeItem(item)

			// Cache was invalidated — re-checks the (now-updated) index
			expect(await offline.isItemStored(item)).toBe(false)
		})
	})

	// ── itemSize ─────────────────────────────────────────────────────────────

	describe("itemSize", () => {
		it("returns size 0 for a file not in the index", async () => {
			const item = makeFileItem(UUID_FILE)
			const result = await offline.itemSize(item)

			expect(result).toEqual({
				size: 0,
				files: 0,
				dirs: 0
			})
		})

		it("returns the file size from the index for a stored file", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			const result = await offline.itemSize(item)

			expect(result.size).toBe(1024)
		})

		it("caches the size result", async () => {
			const item = makeFileItem(UUID_FILE)
			const parent = makeDirParent()

			seedIndex({
				[UUID_FILE]: {
					item,
					parent
				}
			}, {})

			const first = await offline.itemSize(item)

			// Modify index — a cache miss would return 0
			vfsFiles.delete(INDEX_PATH)

			const second = await offline.itemSize(item)

			expect(second).toEqual(first)
		})
	})
})
