import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"

const { mockDb, open, mockAppStateListeners } = vi.hoisted(() => {
	const mockDb = {
		execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeRaw: vi.fn().mockResolvedValue({ rawRows: [], columnNames: [], rowsAffected: 0 }),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		prepareStatement: vi.fn(() => ({
			bind: vi.fn(),
			bindSync: vi.fn(),
			execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 })
		})),
		close: vi.fn()
	}

	// Track all AppState listeners added during tests so we can trigger them
	const mockAppStateListeners: Array<(state: string) => void> = []

	return { mockDb, open: vi.fn(() => mockDb), mockAppStateListeners }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: (_type: string, handler: (state: string) => void) => {
			mockAppStateListeners.push(handler)

			return { remove: () => {} }
		}
	},
	Platform: {
		OS: "ios",
		select(specifics: Record<string, unknown>) {
			return specifics["ios"] ?? specifics["default"]
		}
	}
}))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

// Stub SDK runtime values referenced by the cacheNew* helpers — without this mock the
// real SDK module would load its WASM bridge, which references `self` (undefined in node).
vi.mock("@filen/sdk-rs", () => {
	// Stub SDK wrapper constructors used by the cacheNew* helpers. Each records its tag and the
	// constructor arg(s) under `inner` so tests can assert what was wrapped, without loading the real
	// WASM bridge (which references `self`, undefined in node).
	const makeStub = (tag: string) =>
		class {
			public readonly tag = tag
			public readonly inner: unknown[]

			public constructor(...args: unknown[]) {
				this.inner = args
			}
		}

	return {
		AnyNormalDir: { Dir: makeStub("Dir") },
		AnySharedDir: { Dir: makeStub("SharedDir"), Root: makeStub("SharedRoot") },
		AnyLinkedDir: { Dir: makeStub("LinkedDir") },
		AnyDirWithContext: { Normal: makeStub("Normal"), Shared: makeStub("Shared"), Linked: makeStub("Linked") },
		AnySharedDirWithContext: { new: (arg: unknown) => ({ tag: "SharedDirWithContext", inner: [arg] }) },
		AnyLinkedDirWithContext: { new: (arg: unknown) => ({ tag: "LinkedDirWithContext", inner: [arg] }) }
	}
})

import { Cache, PersistentMap, GLOBAL_PREFIX } from "@/lib/cache"
import { isKvRangeScanQuery, kvRangeScanRows } from "@/tests/mocks/kvExecuteRaw"
import { type DriveItem } from "@/types"

/**
 * In-memory KV store that simulates sqlite.kvAsync behavior.
 * Values are stored as serialized strings just like the real SQLite KV.
 */
const kvStore = new Map<string, string>()

function likeToPrefix(pattern: string): string {
	return pattern.endsWith("%") ? pattern.slice(0, -1) : pattern
}

function matchesLike(key: string, pattern: string): boolean {
	const prefix = likeToPrefix(pattern)

	return key.startsWith(prefix)
}

function setupMockDb(): void {
	mockDb.execute.mockImplementation(async (query: string, params?: unknown[]) => {
		if (query.startsWith("INSERT OR REPLACE")) {
			const key = params![0] as string
			const value = params![1] as string

			kvStore.set(key, value)

			return { rows: [], insertId: 1, rowsAffected: 1 }
		}

		if (query.startsWith("DELETE FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			let count = 0

			for (const key of [...kvStore.keys()]) {
				if (matchesLike(key, pattern)) {
					kvStore.delete(key)

					count++
				}
			}

			return { rows: [], insertId: undefined, rowsAffected: count }
		}

		if (query.startsWith("DELETE FROM kv WHERE")) {
			const key = params![0] as string

			kvStore.delete(key)

			return { rows: [], insertId: undefined, rowsAffected: 1 }
		}

		if (query === "DELETE FROM kv") {
			kvStore.clear()

			return { rows: [], insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT value FROM kv")) {
			const key = params![0] as string
			const value = kvStore.get(key)

			return { rows: value ? [{ value }] : [], insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT key FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: { key: string }[] = []

			for (const key of kvStore.keys()) {
				if (matchesLike(key, pattern)) {
					rows.push({ key })
				}
			}

			return { rows, insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT key FROM kv WHERE")) {
			const key = params![0] as string

			return { rows: kvStore.has(key) ? [{ key }] : [], insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT key FROM kv")) {
			return { rows: [...kvStore.keys()].map(key => ({ key })), insertId: undefined, rowsAffected: 0 }
		}

		return { rows: [], insertId: undefined, rowsAffected: 0 }
	})

	const executeRawRows = async (query: string, params?: unknown[]): Promise<unknown[][]> => {
		if (isKvRangeScanQuery(query)) {
			return kvRangeScanRows(kvStore, query, params)
		}

		if (query.startsWith("SELECT key, value FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: [string, string][] = []

			for (const [key, value] of kvStore) {
				if (matchesLike(key, pattern)) {
					rows.push([key, value])
				}
			}

			return rows
		}

		if (query.startsWith("SELECT key FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: [string][] = []

			for (const key of kvStore.keys()) {
				if (matchesLike(key, pattern)) {
					rows.push([key])
				}
			}

			return rows
		}

		if (query.startsWith("SELECT key FROM kv")) {
			return [...kvStore.keys()].map(key => [key])
		}

		return []
	}

	mockDb.executeRaw.mockImplementation(async (query: string, params?: unknown[]) => ({
		rawRows: await executeRawRows(query, params),
		columnNames: [] as string[],
		rowsAffected: 0
	}))

	mockDb.executeBatch.mockImplementation(async (commands: [string, unknown[]][]) => {
		for (const [query, params] of commands) {
			if (query.startsWith("INSERT OR REPLACE")) {
				kvStore.set(params[0] as string, params[1] as string)
			}

			if (query.startsWith("DELETE FROM kv WHERE") && query.includes("LIKE")) {
				const pattern = params[0] as string

				for (const key of [...kvStore.keys()]) {
					if (matchesLike(key, pattern)) {
						kvStore.delete(key)
					}
				}
			} else if (query.startsWith("DELETE FROM kv WHERE")) {
				kvStore.delete(params[0] as string)
			}

			if (query === "DELETE FROM kv") {
				kvStore.clear()
			}
		}

		return { rowsAffected: commands.length }
	})
}

function createCache(): Cache {
	return new Cache()
}

/**
 * Returns all [fieldName, PersistentMap] pairs discovered on a cache instance,
 * mirroring the same auto-discovery pattern the Cache class uses internally.
 */
function getPersistentMaps(cache: Cache): [string, PersistentMap<unknown>][] {
	const result: [string, PersistentMap<unknown>][] = []

	for (const [key, value] of Object.entries(cache)) {
		if (value instanceof PersistentMap) {
			result.push([key, value as PersistentMap<unknown>])
		}
	}

	return result
}

/** Returns the SQLite KV key for a given map field name + entry key. */
function kvKey(mapName: string, entryKey: string): string {
	return `${GLOBAL_PREFIX}:${mapName}:${entryKey}`
}

/** Creates a ready PersistentMap for unit tests (ready = true so writes are allowed). */
function createReadyMap<V>(onMutate: () => void = () => {}): PersistentMap<V> {
	const map = new PersistentMap<V>(onMutate)

	map.ready = true

	return map
}

// Minimal DriveItem factories —————————————————————————————————————————————————

function makeFileDriveItem(uuid: string): Extract<DriveItem, { type: "file" }> {
	return {
		type: "file",
		data: {
			uuid,
			size: 1024n,
			undecryptable: false,
			decryptedMeta: { name: "test.txt", mime: "text/plain", key: "", created: 0n, modified: 0n },
			parent: "parent-uuid",
			region: "eu-west-1",
			bucket: "filen-1",
			chunks: 1,
			version: 2,
			key: "",
			rm: "",
			timestamp: 0n,
			favorited: false,
			tagged: false
		} as any
	}
}

function makeDirectoryDriveItem(uuid: string, name?: string): Extract<DriveItem, { type: "directory" }> {
	return {
		type: "directory",
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta: name ? { name, color: null } : null,
			parent: "parent-uuid",
			timestamp: 0n,
			favorited: false,
			color: null
		} as any
	}
}

function makeSdkFile(uuid: string): any {
	return {
		uuid,
		parent: "parent-uuid",
		region: "eu-west-1",
		bucket: "filen-1",
		chunks: 1,
		version: 2,
		key: "",
		rm: "",
		timestamp: 0n,
		favorited: false,
		tagged: false
	}
}

function makeSdkDir(uuid: string): any {
	return {
		uuid,
		parent: "parent-uuid",
		timestamp: 0n,
		favorited: false,
		color: null
	}
}

// Shared / shared-root / linked SDK + DriveItem factories for the cacheNewShared*/Linked helpers.
function makeSdkSharedDir(uuid: string): any {
	return { uuid, sharingRole: "owner", inner: makeSdkDir(uuid), parent: "parent-uuid", timestamp: 0n, favorited: false }
}

function makeSdkSharedRootDir(uuid: string): any {
	return { uuid, sharingRole: "owner", parent: "parent-uuid", timestamp: 0n, favorited: false }
}

function makeSdkSharedFile(uuid: string): any {
	return { ...makeSdkFile(uuid), sharingRole: "owner" }
}

function makeSdkLinkedDir(uuid: string): any {
	return { uuid, inner: makeSdkDir(uuid) }
}

function makeSharedDirDriveItem(uuid: string, name?: string): any {
	return {
		type: "sharedDirectory",
		data: { uuid, size: 0n, undecryptable: false, decryptedMeta: name ? { name, color: null } : null, sharingRole: "owner" }
	}
}

function makeSharedRootDirDriveItem(uuid: string, name?: string): any {
	return {
		type: "sharedRootDirectory",
		data: { uuid, size: 0n, undecryptable: false, decryptedMeta: name ? { name, color: null } : null }
	}
}

function makeSharedFileDriveItem(uuid: string): any {
	return { type: "sharedFile", data: { uuid, size: 0n, undecryptable: false, decryptedMeta: null } }
}

function makeSharedRootFileDriveItem(uuid: string): any {
	return { type: "sharedRootFile", data: { uuid, size: 0n, undecryptable: false, decryptedMeta: null } }
}

function makeLinkMeta(): any {
	return { linkUuid: "l-uuid", linkKey: "key" }
}

// —————————————————————————————————————————————————————————————————————————————

describe("PersistentMap", () => {
	it("throws on set before ready", () => {
		const map = new PersistentMap<string>(() => {})

		expect(() => map.set("key", "value")).toThrow("Cache not restored yet")
	})

	it("throws on delete before ready", () => {
		const map = new PersistentMap<string>(() => {})

		expect(() => map.delete("key")).toThrow("Cache not restored yet")
	})

	it("throws on clear before ready", () => {
		const map = new PersistentMap<string>(() => {})

		expect(() => map.clear()).toThrow("Cache not restored yet")
	})

	it("allows reads before ready", () => {
		const map = new PersistentMap<string>(() => {})

		expect(map.get("key")).toBeUndefined()
		expect(map.has("key")).toBe(false)
		expect(map.size).toBe(0)
	})

	it("calls onMutate when set is called", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.set("key", "value")

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.get("key")).toBe("value")
	})

	it("calls onMutate when delete removes an existing key", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.set("key", "value")
		onMutate.mockClear()

		map.delete("key")

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.has("key")).toBe(false)
	})

	it("does not call onMutate when delete targets a missing key", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.delete("nonexistent")

		expect(onMutate).not.toHaveBeenCalled()
	})

	it("calls onMutate when clear is called on a non-empty map", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.set("a", "1")
		map.set("b", "2")
		onMutate.mockClear()

		map.clear()

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.size).toBe(0)
	})

	it("does not call onMutate when clear is called on an empty map", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.clear()

		expect(onMutate).not.toHaveBeenCalled()
	})

	it("returns this from set for chaining", () => {
		const map = createReadyMap<string>()

		const result = map.set("a", "1").set("b", "2")

		expect(result).toBe(map)
		expect(map.size).toBe(2)
	})

	it("inherits all Map methods (get, has, size, entries, forEach)", () => {
		const map = createReadyMap<number>()

		map.set("x", 10)
		map.set("y", 20)

		expect(map.get("x")).toBe(10)
		expect(map.has("y")).toBe(true)
		expect(map.size).toBe(2)
		expect([...map.entries()]).toEqual([
			["x", 10],
			["y", 20]
		])

		const collected: [string, number][] = []

		map.forEach((v, k) => {
			collected.push([k, v])
		})

		expect(collected).toEqual([
			["x", 10],
			["y", 20]
		])
	})

	it("calls onMutate for each set with a new value, skips for same-reference value", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.set("key", "first")
		map.set("key", "second")

		expect(onMutate).toHaveBeenCalledTimes(2)
		expect(map.get("key")).toBe("second")
	})

	it("skips onMutate when setting the same value reference again (identity dedup)", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.set("key", "value")
		map.set("key", "value")

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.get("key")).toBe("value")
	})

	it("delete returns true for existing key and false for missing key", () => {
		const map = createReadyMap<string>()

		map.set("key", "value")

		expect(map.delete("key")).toBe(true)
		expect(map.delete("key")).toBe(false)
		expect(map.delete("nonexistent")).toBe(false)
	})
})

describe("Cache", () => {
	beforeAll(async () => {
		// Initialize sqlite singleton once — mock implementations are set in beforeEach
		setupMockDb()

		const sqliteMod = await import("@/lib/sqlite")

		await sqliteMod.default.init()
	})

	beforeEach(() => {
		kvStore.clear()
		setupMockDb()
		vi.useFakeTimers()
		mockAppStateListeners.length = 0
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("constructor", () => {
		it("keeps the session-scoped metadata maps off the persistence registry", async () => {
			const cache = createCache()
			const names = getPersistentMaps(cache).map(([name]) => name)

			for (const plain of [
				"uuidToAnyDriveItem",
				"fileUuidToNormalFile",
				"directoryUuidToAnySharedDirWithContext",
				"directoryUuidToAnyNormalDir",
				"directoryUuidToAnyLinkedDirWithMeta",
				"chatAttachmentLayouts"
			]) {
				expect(names).not.toContain(plain)
			}
		})
	})

	describe("clear", () => {
		it("empties the session-scoped metadata maps too", async () => {
			const cache = createCache()

			await cache.restore()

			cache.uuidToAnyDriveItem.set("a", makeFileDriveItem("a"))
			cache.fileUuidToNormalFile.set("a", makeSdkFile("a"))
			cache.directoryUuidToAnySharedDirWithContext.set("a", {} as any)
			cache.directoryUuidToAnyNormalDir.set("a", {} as any)
			cache.directoryUuidToAnyLinkedDirWithMeta.set("a", { dir: {} as any, meta: {} as any })
			cache.chatAttachmentLayouts.set("a", { width: 1, height: 2 })

			cache.clear()

			expect(cache.uuidToAnyDriveItem.size).toBe(0)
			expect(cache.fileUuidToNormalFile.size).toBe(0)
			expect(cache.directoryUuidToAnySharedDirWithContext.size).toBe(0)
			expect(cache.directoryUuidToAnyNormalDir.size).toBe(0)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.size).toBe(0)
			expect(cache.chatAttachmentLayouts.size).toBe(0)
		})

		it("does not throw synchronously when SQLite keys do not exist", async () => {
			const cache = createCache()

			// cache.clear() fires sqlite.kvAsync.removeByPrefix() as fire-and-forget promises.
			// We verify the synchronous path doesn't throw; the async removal is fire-and-forget.
			expect(() => cache.clear()).not.toThrow()

			// Drain microtasks to ensure fire-and-forget promises resolve (not reject)
			// without propagating to the caller
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
		})

		it("also clears secureStore", async () => {
			const cache = createCache()

			cache.secureStore.set("secret-key", "secret-value")
			cache.secureStore.set("another-key", "another-value")

			expect(cache.secureStore.size).toBe(2)

			cache.clear()

			expect(cache.secureStore.size).toBe(0)
		})

		it("resets the session rootUuid to null", () => {
			const cache = createCache()

			cache.rootUuid = "root-uuid-session"

			cache.clear()

			expect(cache.rootUuid).toBeNull()
		})
	})

	describe("cacheNewFile", () => {
		it("inserts file into uuidToAnyDriveItem and fileUuidToNormalFile", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "file-uuid-1"
			const sdkFile = makeSdkFile(uuid)
			const driveItem = makeFileDriveItem(uuid)

			cache.cacheNewFile(sdkFile, driveItem)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(driveItem)
			expect(cache.fileUuidToNormalFile.get(uuid)).toBe(sdkFile)
		})

		it("overwrites an existing file entry", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "file-uuid-overwrite"
			const sdkFile1 = makeSdkFile(uuid)
			const sdkFile2 = { ...makeSdkFile(uuid), chunks: 99 }
			const driveItem1 = makeFileDriveItem(uuid)
			const driveItem2 = makeFileDriveItem(uuid)

			cache.cacheNewFile(sdkFile1, driveItem1)
			cache.cacheNewFile(sdkFile2, driveItem2)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(driveItem2)
			expect(cache.fileUuidToNormalFile.get(uuid)).toBe(sdkFile2)
		})

		it("keeps the file maps in memory only — a flush persists nothing (session-scoped)", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "file-uuid-persist"

			cache.cacheNewFile(makeSdkFile(uuid), makeFileDriveItem(uuid))

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(true)
			expect(kvStore.has(kvKey("uuidToAnyDriveItem", uuid))).toBe(false)
			expect(kvStore.has(kvKey("fileUuidToNormalFile", uuid))).toBe(false)
		})
	})

	describe("cacheNewNormalDir", () => {
		it("inserts dir into uuidToAnyDriveItem and directoryUuidToAnyNormalDir", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "dir-uuid-1"
			const sdkDir = makeSdkDir(uuid)
			const driveItem = makeDirectoryDriveItem(uuid, "My Documents")

			cache.cacheNewNormalDir(sdkDir, driveItem)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(driveItem)
			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(true)
		})

		it("constructs an AnyNormalDir.Dir wrapper around the raw dir", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "dir-uuid-wrapper"
			const sdkDir = makeSdkDir(uuid)
			const driveItem = makeDirectoryDriveItem(uuid, "Wrapped")

			cache.cacheNewNormalDir(sdkDir, driveItem)

			const normalDir = cache.directoryUuidToAnyNormalDir.get(uuid) as any

			// StubDir wraps the raw sdk dir
			expect(normalDir.tag).toBe("Dir")
			expect(normalDir.inner[0]).toBe(sdkDir)
		})
	})

	describe("cacheNewSharedDir", () => {
		it("seeds uuidToAnyDriveItem and the shared-context cache", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "shared-dir-1"

			cache.cacheNewSharedDir(makeSdkSharedDir(uuid), makeSharedDirDriveItem(uuid, "Shared"), { sharedOut: false })

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnySharedDirWithContext.has(uuid)).toBe(true)
		})

		it("does NOT seed directoryUuidToAnyNormalDir for a shared-IN dir (sharedOut: false)", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "shared-in-dir"

			cache.cacheNewSharedDir(makeSdkSharedDir(uuid), makeSharedDirDriveItem(uuid), { sharedOut: false })

			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(false)
		})

		it("ALSO seeds directoryUuidToAnyNormalDir (from the inner dir) for a shared-OUT dir", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "shared-out-dir"

			cache.cacheNewSharedDir(makeSdkSharedDir(uuid), makeSharedDirDriveItem(uuid), { sharedOut: true })

			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(true)
		})
	})

	describe("cacheNewSharedRootDir", () => {
		it("seeds the shared-context cache for a shared root dir", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "shared-root-dir"

			cache.cacheNewSharedRootDir(makeSdkSharedRootDir(uuid), makeSharedRootDirDriveItem(uuid, "Root"))

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnySharedDirWithContext.has(uuid)).toBe(true)
		})
	})

	describe("cacheNewSharedFile", () => {
		it("references a shared-IN file by uuid only (no fileUuidToNormalFile)", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "shared-in-file"

			cache.cacheNewSharedFile(makeSdkSharedFile(uuid), makeSharedFileDriveItem(uuid), { sharedOut: false })

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
		})

		it("ALSO seeds fileUuidToNormalFile with sharingRole stripped for a shared-OUT file", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "shared-out-file"

			cache.cacheNewSharedFile(makeSdkSharedFile(uuid), makeSharedFileDriveItem(uuid), { sharedOut: true })

			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(true)
			expect((cache.fileUuidToNormalFile.get(uuid) as { sharingRole?: unknown }).sharingRole).toBeUndefined()
		})
	})

	describe("cacheNewLinkedDir", () => {
		it("seeds the linked-meta cache when meta is present", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "linked-dir"

			cache.cacheNewLinkedDir(makeSdkLinkedDir(uuid), makeDirectoryDriveItem(uuid, "Linked"), makeLinkMeta())

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(true)
		})

		it("seeds only uuid when meta is null (no linked-meta cache)", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "linked-dir-nometa"

			cache.cacheNewLinkedDir(makeSdkLinkedDir(uuid), makeDirectoryDriveItem(uuid, "Linked"), null)

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(false)
		})
	})

	describe("cacheDriveItemReference", () => {
		it("seeds only uuidToAnyDriveItem, no derived caches", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "ref-uuid"
			const item = makeSharedRootFileDriveItem(uuid)

			cache.cacheDriveItemReference(item)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(item)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
		})
	})

	describe("cacheDriveItem (dispatch by item type)", () => {
		it("dispatches a file to cacheNewFile (uuid + fileUuidToNormalFile)", async () => {
			const cache = createCache()

			await cache.restore()

			cache.cacheDriveItem(makeFileDriveItem("cdi-file"))

			expect(cache.uuidToAnyDriveItem.has("cdi-file")).toBe(true)
			expect(cache.fileUuidToNormalFile.has("cdi-file")).toBe(true)
		})

		it("dispatches a directory to the normal caches", async () => {
			const cache = createCache()

			await cache.restore()

			cache.cacheDriveItem(makeDirectoryDriveItem("cdi-dir", "D"))

			expect(cache.directoryUuidToAnyNormalDir.has("cdi-dir")).toBe(true)
		})

		it("dispatches a sharedDirectory WITH sharingRole to the shared caches (default sharedOut: false → no normal-dir view)", async () => {
			const cache = createCache()

			await cache.restore()

			cache.cacheDriveItem(makeSharedDirDriveItem("cdi-shared", "S"))

			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-shared")).toBe(true)
			expect(cache.directoryUuidToAnyNormalDir.has("cdi-shared")).toBe(false)
		})

		it("passes opts.sharedOut through so a shared-OUT dir ALSO gets the normal-dir refinement", async () => {
			const cache = createCache()

			await cache.restore()

			cache.cacheDriveItem(makeSharedDirDriveItem("cdi-shared-out", "S"), { sharedOut: true })

			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-shared-out")).toBe(true)
			expect(cache.directoryUuidToAnyNormalDir.has("cdi-shared-out")).toBe(true)
		})

		it("falls back to a uuid-only reference for a sharedDirectory WITHOUT sharingRole", async () => {
			const cache = createCache()

			await cache.restore()

			const item = makeSharedDirDriveItem("cdi-norole")

			delete (item.data as { sharingRole?: unknown }).sharingRole

			cache.cacheDriveItem(item)

			expect(cache.uuidToAnyDriveItem.has("cdi-norole")).toBe(true)
			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-norole")).toBe(false)
		})

		it("dispatches a sharedRootDirectory to the shared caches", async () => {
			const cache = createCache()

			await cache.restore()

			cache.cacheDriveItem(makeSharedRootDirDriveItem("cdi-sharedroot", "R"))

			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-sharedroot")).toBe(true)
		})

		it("references a sharedRootFile by uuid only", async () => {
			const cache = createCache()

			await cache.restore()

			cache.cacheDriveItem(makeSharedRootFileDriveItem("cdi-srf"))

			expect(cache.uuidToAnyDriveItem.has("cdi-srf")).toBe(true)
			expect(cache.fileUuidToNormalFile.has("cdi-srf")).toBe(false)
		})
	})

	describe("forgetItem", () => {
		it("removes uuid from all five session-scoped per-uuid maps", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "forget-uuid-1"
			const sdkFile = makeSdkFile(uuid)
			const driveItem = makeFileDriveItem(uuid)

			cache.cacheNewFile(sdkFile, driveItem)

			// Manually seed the remaining maps
			cache.directoryUuidToAnyNormalDir.set(uuid, {} as any)
			cache.directoryUuidToAnySharedDirWithContext.set(uuid, {} as any)
			cache.directoryUuidToAnyLinkedDirWithMeta.set(uuid, { dir: {} as any, meta: {} as any })

			cache.forgetItem(uuid)

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(false)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(false)
			expect(cache.directoryUuidToAnySharedDirWithContext.has(uuid)).toBe(false)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(false)
		})

		it("removes directoryUuidToAnyLinkedDirWithMeta entry on forgetItem (regression: bug #12)", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "linked-dir-forget-uuid"

			cache.directoryUuidToAnyLinkedDirWithMeta.set(uuid, { dir: { tag: "LinkedDir" } as any, meta: { uuid } as any })

			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(true)

			cache.forgetItem(uuid)

			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(false)
		})

		it("is a no-op for a uuid that was never cached", async () => {
			const cache = createCache()

			await cache.restore()

			// Should not throw even when uuid doesn't exist in any map
			expect(() => cache.forgetItem("nonexistent-uuid")).not.toThrow()
		})

		it("only removes the specific uuid, not other entries", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid1 = "forget-specific-1"
			const uuid2 = "forget-specific-2"

			cache.cacheNewFile(makeSdkFile(uuid1), makeFileDriveItem(uuid1))
			cache.cacheNewFile(makeSdkFile(uuid2), makeFileDriveItem(uuid2))

			cache.forgetItem(uuid1)

			expect(cache.uuidToAnyDriveItem.has(uuid1)).toBe(false)
			expect(cache.uuidToAnyDriveItem.has(uuid2)).toBe(true)
			expect(cache.fileUuidToNormalFile.has(uuid1)).toBe(false)
			expect(cache.fileUuidToNormalFile.has(uuid2)).toBe(true)
		})

		it("removes the in-memory entries without touching SQLite (session-scoped)", async () => {
			const cache = createCache()

			await cache.restore()

			const uuid = "forget-persist-uuid"

			cache.cacheNewFile(makeSdkFile(uuid), makeFileDriveItem(uuid))

			mockDb.executeBatch.mockClear()

			cache.forgetItem(uuid)

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(false)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})
	})
})
