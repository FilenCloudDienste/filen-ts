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
import { serialize, deserialize } from "@/lib/serializer"
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

/** Returns the first PersistentMap found on the cache (for single-map tests). */
function getFirstMap(cache: Cache): { name: string; map: PersistentMap<unknown> } {
	const maps = getPersistentMaps(cache)

	expect(maps.length).toBeGreaterThan(0)

	const first = maps[0] as [string, PersistentMap<unknown>]

	return { name: first[0], map: first[1] }
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

/**
 * Await all pending microtasks and timers until executeBatch is called or we
 * exhaust MAX_TICKS. Returns whether executeBatch was actually invoked.
 */
async function drainUntilExecuteBatch(maxTicks = 20): Promise<boolean> {
	for (let i = 0; i < maxTicks; i++) {
		await Promise.resolve()

		if (mockDb.executeBatch.mock.calls.length > 0) {
			return true
		}
	}

	return false
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
		it("maps are not ready before restore", async () => {
			const cache = createCache()
			const { map } = getFirstMap(cache)

			expect(map.ready).toBe(false)
			expect(() => map.set("key", "value")).toThrow("Cache not restored yet")
		})

		it("registers exactly the two durable camera-upload maps (metadata maps are session-scoped plain Maps)", async () => {
			const cache = createCache()
			const names = getPersistentMaps(cache)
				.map(([name]) => name)
				.sort()

			expect(names).toEqual(["cameraUploadBackgroundAborts", "cameraUploadHashes"])
		})

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

	describe("restore", () => {
		it("populates a map from per-key SQLite entries", async () => {
			const cache = createCache()
			const { name } = getFirstMap(cache)

			kvStore.set(kvKey(name, "key-1"), serialize("value-1"))
			kvStore.set(kvKey(name, "key-2"), serialize("value-2"))

			const cache2 = createCache()

			await cache2.restore()

			const restored = (cache2 as unknown as Record<string, unknown>)[name] as PersistentMap<unknown>

			expect(restored.get("key-1")).toBe("value-1")
			expect(restored.get("key-2")).toBe("value-2")
			expect(restored.size).toBe(2)
		})

		it("restores a map across multiple pages with full fidelity", async () => {
			// The pager yields a real setTimeout between pages — fake timers would park it.
			vi.useRealTimers()

			// More rows than one restore page (KV_RESTORE_PAGE_SIZE = 256) so the keyset
			// continuation path runs; every row must land exactly once.
			const cache = createCache()
			const { name } = getFirstMap(cache)

			for (let i = 0; i < 600; i++) {
				kvStore.set(kvKey(name, `key-${String(i).padStart(4, "0")}`), serialize(`value-${i}`))
			}

			const cache2 = createCache()

			await cache2.restore()

			const restored = (cache2 as unknown as Record<string, unknown>)[name] as PersistentMap<unknown>

			expect(restored.size).toBe(600)
			expect(restored.get("key-0000")).toBe("value-0")
			expect(restored.get("key-0599")).toBe("value-599")
		})

		it("sets all maps to ready after restore", async () => {
			const cache = createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.ready).toBe(true)
			}

			const { map } = getFirstMap(cache)

			expect(() => map.set("key", "value")).not.toThrow()
		})

		it("restore() is once-per-session — a second call skips the SQLite scans (audit B2b)", async () => {
			// setup() can run more than once per process (iOS cold background launch runs the
			// task's setup AND RootLayout's; warm Android re-runs setup per WorkManager fire).
			// Re-restoring would redo full-table scans over every registered map and clobber
			// newer in-memory entries with older disk rows.
			const cache = createCache()

			await cache.restore()

			const scansAfterFirst = mockDb.executeRaw.mock.calls.length

			await cache.restore()

			expect(mockDb.executeRaw.mock.calls.length).toBe(scansAfterFirst)
		})

		it("clear() re-arms restore() for the next session", async () => {
			const cache = createCache()

			await cache.restore()
			cache.clear()

			const scansAfterClear = mockDb.executeRaw.mock.calls.length

			await cache.restore()

			expect(mockDb.executeRaw.mock.calls.length).toBeGreaterThan(scansAfterClear)
		})

		it("restores all PersistentMap fields from separate SQLite keys", async () => {
			const cache = createCache()
			const maps = getPersistentMaps(cache)

			for (const [mapName] of maps) {
				kvStore.set(kvKey(mapName, `${mapName}-key`), serialize(`${mapName}-value`))
			}

			const cache2 = createCache()

			await cache2.restore()

			for (const [mapName] of maps) {
				const restored = (cache2 as unknown as Record<string, unknown>)[mapName] as PersistentMap<unknown>

				expect(restored.get(`${mapName}-key`)).toBe(`${mapName}-value`)
			}
		})

		it("does nothing when SQLite keys do not exist", async () => {
			const cache = createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

		it("only populates the map with matching prefix entries", async () => {
			const cache = createCache()
			const maps = getPersistentMaps(cache)
			const firstMap = maps[0] as [string, PersistentMap<unknown>]

			kvStore.set(kvKey(firstMap[0], "k"), serialize("v"))

			const cache2 = createCache()

			await cache2.restore()

			expect(((cache2 as unknown as Record<string, unknown>)[firstMap[0]] as PersistentMap<unknown>).get("k")).toBe("v")

			for (const [mapName, map] of getPersistentMaps(cache2)) {
				if (mapName !== firstMap[0]) {
					expect(map.size).toBe(0)
				}
			}
		})

		it("handles corrupted data for one map without affecting others", async () => {
			const cache = createCache()
			const maps = getPersistentMaps(cache)
			const firstMap = maps[0] as [string, PersistentMap<unknown>]
			const secondMap = maps[1] as [string, PersistentMap<unknown>]

			kvStore.set(kvKey(firstMap[0], "corrupt"), "{invalid json!!")
			kvStore.set(kvKey(secondMap[0], "good-key"), serialize("good-value"))

			const cache2 = createCache()

			await expect(cache2.restore()).resolves.toBeUndefined()

			expect(((cache2 as unknown as Record<string, unknown>)[firstMap[0]] as PersistentMap<unknown>).size).toBe(0)
			expect(((cache2 as unknown as Record<string, unknown>)[secondMap[0]] as PersistentMap<unknown>).get("good-key")).toBe(
				"good-value"
			)
		})

		it("does not trigger onMutate during restore (no write-back cycle)", async () => {
			const cache = createCache()
			const { name } = getFirstMap(cache)

			kvStore.set(kvKey(name, "key-1"), serialize("value-1"))

			const cache2 = createCache()

			mockDb.executeBatch.mockClear()

			await cache2.restore()

			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
			expect(((cache2 as unknown as Record<string, unknown>)[name] as PersistentMap<unknown>).get("key-1")).toBe("value-1")
		})
	})

	describe("persist (via flush)", () => {
		it("writes per-key entries to SQLite on flush", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("uuid-1", "Documents")
			map.set("uuid-2", "Photos")

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			const stored1 = kvStore.get(kvKey(name, "uuid-1"))
			const stored2 = kvStore.get(kvKey(name, "uuid-2"))

			expect(typeof stored1).toBe("string")
			expect(typeof stored2).toBe("string")
			expect(deserialize(stored1 as string)).toBe("Documents")
			expect(deserialize(stored2 as string)).toBe("Photos")
		})

		it("persists entries from each map under its own prefix", async () => {
			const cache = createCache()

			await cache.restore()

			const maps = getPersistentMaps(cache)

			for (const [, map] of maps) {
				map.set("test-key", "test-value")
			}

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				const stored = kvStore.get(kvKey(mapName, "test-key"))

				expect(typeof stored).toBe("string")
				expect(deserialize(stored as string)).toBe("test-value")
			}
		})

		it("batches multiple mutations into a single write", async () => {
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			mockDb.executeBatch.mockClear()

			map.set("a", "1")
			map.set("b", "2")
			map.set("c", "3")

			expect(mockDb.executeBatch).not.toHaveBeenCalled()

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
		})

		it("only persists changed entries, not the entire map", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("a", "1")
			map.set("b", "2")

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			mockDb.executeBatch.mockClear()

			// Only change one entry
			map.set("a", "updated")

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const commands = mockDb.executeBatch.mock.calls[0]![0] as [string, unknown[]][]

			// Should only write the changed entry, not both
			expect(commands).toHaveLength(1)
			expect(commands[0]![1]![0]).toBe(kvKey(name, "a"))
		})

		it("persists data that survives a full restore round-trip", async () => {
			const cache1 = createCache()

			await cache1.restore()

			const { name, map } = getFirstMap(cache1)

			map.set("round-trip-key", "round-trip-value")

			cache1.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			const cache2 = createCache()

			await cache2.restore()

			expect(((cache2 as unknown as Record<string, unknown>)[name] as PersistentMap<unknown>).get("round-trip-key")).toBe(
				"round-trip-value"
			)
		})
	})

	describe("clear", () => {
		it("empties all PersistentMap instances", async () => {
			const cache = createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				map.set("key", "value")
			}

			cache.clear()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

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

		it("removes per-key entries from SQLite", async () => {
			const cache = createCache()

			await cache.restore()

			const maps = getPersistentMaps(cache)

			for (const [, map] of maps) {
				map.set("key", "value")
			}

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				expect(kvStore.has(kvKey(mapName, "key"))).toBe(true)
			}

			cache.clear()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				expect(kvStore.has(kvKey(mapName, "key"))).toBe(false)
			}
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

		it("cancels any pending debounced persist", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("key", "value")

			cache.clear()

			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name, "key"))).toBe(false)
		})

		it("does not trigger onMutate (uses Map.prototype.clear, bypassing PersistentMap)", async () => {
			// cache.clear() calls Map.prototype.clear.call(map) directly to bypass
			// PersistentMap.clear(), which would invoke onMutate and enqueue dirty state.
			// Verify: no executeBatch call is made after clear(), even with timer advancement.
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			map.set("key", "value")

			// Flush the initial set to SQLite so dirty state is clean
			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			mockDb.executeBatch.mockClear()

			// clear() should bypass onMutate — no new dirty entries should be enqueued
			cache.clear()

			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			// If onMutate were called by clear(), it would enqueue dirty entries and
			// eventually trigger executeBatch. Absence of calls confirms the bypass.
			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})
	})

	describe("auto-discovery", () => {
		it("does not persist non-PersistentMap fields", async () => {
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			map.set("key", "value")
			;(cache as unknown as { _testField?: string })._testField = "should not persist"

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(`${GLOBAL_PREFIX}:_testField`)).toBe(false)
		})
	})

	describe("flushNow", () => {
		it("synchronously persists dirty entries without waiting for the debounce timer", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("flush-key", "flush-value")

			mockDb.executeBatch.mockClear()

			// Call flushNow before the 1-second debounce would fire
			cache.flushNow()

			// Drain microtasks until executeBatch resolves — resilient to mock depth changes
			const called = await drainUntilExecuteBatch()

			expect(called).toBe(true)
			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const stored = kvStore.get(kvKey(name, "flush-key"))

			expect(typeof stored).toBe("string")
			expect(deserialize(stored as string)).toBe("flush-value")
		})

		it("cancels the pending debounce so the batch is not written twice", async () => {
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			map.set("k", "v")

			mockDb.executeBatch.mockClear()

			cache.flushNow()

			// Drain microtasks until the fire-and-forget executeBatch promise resolves
			await drainUntilExecuteBatch()

			// Now advance past the original debounce window — should NOT trigger a second batch
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
		})

		it("does nothing when there are no dirty entries", async () => {
			const cache = createCache()

			await cache.restore()

			mockDb.executeBatch.mockClear()

			cache.flushNow()

			await drainUntilExecuteBatch(10)

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
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

	describe("AppState background flush", () => {
		it("calls flushNow when AppState transitions to background", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("bg-key", "bg-value")

			mockDb.executeBatch.mockClear()

			// Trigger the AppState listener registered by this cache instance
			// (last registered listener = this cache instance)
			const listener = mockAppStateListeners[mockAppStateListeners.length - 1]

			expect(listener).toBeDefined()

			listener!("background")

			const called = await drainUntilExecuteBatch()

			expect(called).toBe(true)
			expect(kvStore.get(kvKey(name, "bg-key"))).toBeDefined()
			expect(deserialize(kvStore.get(kvKey(name, "bg-key")) as string)).toBe("bg-value")
		})

		it("does not flush when AppState transitions to active (not background)", async () => {
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			map.set("active-key", "active-value")

			mockDb.executeBatch.mockClear()

			const listener = mockAppStateListeners[mockAppStateListeners.length - 1]

			expect(listener).toBeDefined()

			listener!("active")

			await drainUntilExecuteBatch(5)

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})
	})

	describe("persistAsync clearGeneration guard", () => {
		it("aborts a stale in-flight persist if clear() is called before openDb resolves", async () => {
			// Simulate: persistAsync starts, awaits openDb(), clear() is called in between.
			// The generation check (generation !== this.clearGeneration) should prevent writing.
			let resolveOpenDb!: () => void
			const openDbPromise = new Promise<void>(resolve => {
				resolveOpenDb = resolve
			})

			// Intercept openDb to hold the promise until we call clear()
			let openDbCallCount = 0

			mockDb.executeBatch.mockClear()

			const originalExecuteBatch = mockDb.executeBatch

			// We'll use the real executeBatch but track it
			mockDb.executeBatch = vi.fn().mockImplementation(originalExecuteBatch)

			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("stale-key", "stale-value")

			// Override openDb on the sqlite singleton to intercept the async persist
			const sqliteMod = await import("@/lib/sqlite")
			const originalOpenDb = sqliteMod.default.openDb.bind(sqliteMod.default)

			sqliteMod.default.openDb = vi.fn().mockImplementation(async () => {
				openDbCallCount++

				if (openDbCallCount === 1) {
					// Block this first call to simulate in-flight persist
					await openDbPromise
				}

				return await originalOpenDb()
			})

			try {
				// Start the debounce timer which will trigger persistAsync
				cache.flush()
				vi.advanceTimersByTime(2000)

				// Advance timer to fire the debounce without awaiting the persist itself
				await Promise.resolve()

				// Now call clear() while the in-flight persist is awaiting openDb
				cache.clear()

				// Resolve the blocked openDb — persistAsync will check generation and abort
				resolveOpenDb()

				// Give the async chain time to complete (post-openDb path)
				await Promise.resolve()
				await Promise.resolve()
				await Promise.resolve()
				await Promise.resolve()
				await Promise.resolve()

				// executeBatch should NOT have been called because generation was incremented
				// by clear() between openDb start and openDb resolve
				expect(mockDb.executeBatch).not.toHaveBeenCalled()

				// The map should be empty after clear()
				expect(((cache as unknown as Record<string, unknown>)[name] as PersistentMap<unknown>).has("stale-key")).toBe(false)
			} finally {
				sqliteMod.default.openDb = originalOpenDb
			}
		})
	})

	describe("persistAsync concurrency dedup", () => {
		it("does not run two concurrent persistAsync calls for the same dirty batch", async () => {
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			// Trigger multiple mutations in rapid succession — they all share the same debounce window
			map.set("a", "1")
			map.set("b", "2")
			map.set("c", "3")

			mockDb.executeBatch.mockClear()

			// Manually fire the debounce twice to simulate concurrent trigger attempts
			cache.flush()
			cache.flush()

			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			// Despite two flush() calls, only one executeBatch should happen
			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
		})

		it("re-triggers a second persist for mutations that arrive during an in-flight persist", async () => {
			// The finally block of persistAsync calls persistDirty() if there are still dirty entries.
			// This test verifies mutations that arrive while a persist is in-flight are not lost.
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("first", "value-1")

			mockDb.executeBatch.mockClear()

			// Block executeBatch to hold persistAsync in the try block
			let resolveFirstBatch!: () => void
			const firstBatchPromise = new Promise<void>(resolve => {
				resolveFirstBatch = resolve
			})

			let batchCallCount = 0

			mockDb.executeBatch = vi.fn().mockImplementation(async (cmds: [string, unknown[]][]) => {
				batchCallCount++

				if (batchCallCount === 1) {
					await firstBatchPromise
				}

				// Run the real implementation
				for (const [query, params] of cmds) {
					if (query.startsWith("INSERT OR REPLACE")) {
						kvStore.set(params[0] as string, params[1] as string)
					}
				}

				return { rowsAffected: cmds.length }
			})

			// Kick off the first persist
			cache.flush()
			vi.advanceTimersByTime(2000)
			await Promise.resolve() // let persistAsync start

			// While first persist is blocked, add a new mutation
			map.set("second", "value-2")

			// Unblock the first batch
			resolveFirstBatch()

			// Let persistAsync's finally block fire, which should call persistDirty() again
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			// Advance time for the second debounce
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			// Both mutations should now be in the store
			expect(kvStore.has(kvKey(name, "first"))).toBe(true)
			expect(kvStore.has(kvKey(name, "second"))).toBe(true)
		})
	})

	// #1 — after the logout wipe (clear()), the cache is locked: no stray mutation, debounce, or
	// AppState-background flush may re-INSERT decrypted metadata into the just-emptied plaintext kv.
	// D6 fix: clear() also resets ready=false so stray set() calls are rejected at assertReady(),
	// not just silently mutated in-memory and then blocked at the persist layer.
	describe("logout wipe lock (#1)", () => {
		it("a set() after clear() throws (ready=false) and does not leave a retained in-memory entry", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("pre-clear", "value")

			cache.clear()

			// Stray set() must be rejected at assertReady() — not retained in-memory.
			expect(() => map.set("leaked", "decrypted-meta")).toThrow("Cache not restored yet")

			// The in-memory map must be empty: pre-clear entry gone, stray entry never stored.
			expect(map.size).toBe(0)
			expect(map.has("leaked")).toBe(false)
			expect(map.has("pre-clear")).toBe(false)

			// No SQLite write must have occurred.
			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name, "leaked"))).toBe(false)
		})

		it("all maps have ready=false immediately after clear()", async () => {
			const cache = createCache()

			await cache.restore()

			// Confirm all maps are ready before clear.
			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.ready).toBe(true)
			}

			cache.clear()

			// After clear, every map must be not-ready.
			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.ready).toBe(false)
			}
		})

		it("a set() after clear() does not persist on a debounced flush", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			cache.clear()

			// A stray mutation during the logout window must be rejected (ready=false).
			expect(() => map.set("leaked", "decrypted-meta")).toThrow("Cache not restored yet")

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name, "leaked"))).toBe(false)
		})

		it("a set() after clear() does not persist on a background flushNow()", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			cache.clear()

			// Stray set() is rejected at assertReady — nothing is enqueued.
			expect(() => map.set("leaked", "decrypted-meta")).toThrow("Cache not restored yet")

			mockDb.executeBatch.mockClear()

			// Simulate the AppState "background" flush path.
			const listener = mockAppStateListeners[mockAppStateListeners.length - 1]

			expect(listener).toBeDefined()

			listener!("background")

			await drainUntilExecuteBatch(10)

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
			expect(kvStore.has(kvKey(name, "leaked"))).toBe(false)
		})

		it("a fresh restore() after a wipe yields empty maps", async () => {
			const cache = createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			map.set("a", "1")
			map.set("b", "2")

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			// Logout wipe.
			cache.clear()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			// Next session hydrates from disk — everything is gone.
			const next = createCache()

			await next.restore()

			for (const [, m] of getPersistentMaps(next)) {
				expect(m.size).toBe(0)
			}
		})
	})

	// E4 — persistence must not lose updates: flushNow awaits the write, failed batches
	// re-mark their keys dirty (unless newer mutations superseded them), and the sync
	// flush path is serialized against the async chunked persist so an older batch can
	// never commit after (and overwrite) a newer one.
	describe("persist reliability (E4)", () => {
		it("flushNow resolves only after the batch has landed on disk", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("await-key", "await-value")

			await cache.flushNow()

			// No drain loop — the awaited promise itself must guarantee the write landed.
			expect(deserialize(kvStore.get(kvKey(name, "await-key")) as string)).toBe("await-value")
		})

		it("a failed batch re-marks its keys dirty and the next flush retries them", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("retry-key", "retry-value")

			mockDb.executeBatch.mockClear()
			mockDb.executeBatch.mockRejectedValueOnce(new Error("disk io error"))

			await cache.flushNow()

			// The first batch failed — nothing landed, nothing thrown.
			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
			expect(kvStore.has(kvKey(name, "retry-key"))).toBe(false)

			// The drained key was re-marked dirty — a second flush retries and succeeds.
			await cache.flushNow()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(2)
			expect(deserialize(kvStore.get(kvKey(name, "retry-key")) as string)).toBe("retry-value")
		})

		it("a failed delete is retried too", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("doomed", "value")

			await cache.flushNow()

			expect(kvStore.has(kvKey(name, "doomed"))).toBe(true)

			map.delete("doomed")

			mockDb.executeBatch.mockRejectedValueOnce(new Error("disk io error"))

			await cache.flushNow()

			// Failed — row still present.
			expect(kvStore.has(kvKey(name, "doomed"))).toBe(true)

			await cache.flushNow()

			// Retried — row gone.
			expect(kvStore.has(kvKey(name, "doomed"))).toBe(false)
		})

		it("does not resurrect a key whose newer mutation arrived after the failed drain", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("superseded", "old")

			// Hold the first batch in flight so a newer mutation can land mid-persist.
			let rejectFirstBatch!: (err: Error) => void

			mockDb.executeBatch.mockClear()
			mockDb.executeBatch.mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						rejectFirstBatch = reject
					})
			)

			const flushPromise = cache.flushNow()

			await drainUntilExecuteBatch()

			// Newer intent while the (about to fail) batch is in flight: delete the key.
			map.delete("superseded")

			rejectFirstBatch(new Error("boom"))

			await flushPromise

			// Retry must honor the newer delete — the key may not be re-INSERTed.
			await cache.flushNow()

			expect(kvStore.has(kvKey(name, "superseded"))).toBe(false)
		})

		it("does not re-mark a failed batch after clear() bumped the generation (logout leak guard)", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("leak-key", "decrypted-meta")

			let rejectFirstBatch!: (err: Error) => void

			mockDb.executeBatch.mockClear()
			mockDb.executeBatch.mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						rejectFirstBatch = reject
					})
			)

			const flushPromise = cache.flushNow()

			await drainUntilExecuteBatch()

			// Logout wipe lands while the batch is in flight, then the batch fails.
			cache.clear()

			rejectFirstBatch(new Error("boom"))

			await flushPromise

			// The failed keys must NOT have been re-marked — nothing may persist them again.
			await cache.flushNow()

			expect(kvStore.has(kvKey(name, "leak-key"))).toBe(false)
		})

		it("a flushNow landing during an in-flight persistAsync is serialized after it (newest value wins on disk)", async () => {
			const cache = createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			let resolveFirstBatch!: () => void
			const firstBatchGate = new Promise<void>(resolve => {
				resolveFirstBatch = resolve
			})
			let batchCalls = 0

			mockDb.executeBatch.mockClear()
			mockDb.executeBatch.mockImplementation(async (cmds: [string, unknown[]][]) => {
				batchCalls++

				if (batchCalls === 1) {
					await firstBatchGate
				}

				for (const [query, params] of cmds) {
					if (query.startsWith("INSERT OR REPLACE")) {
						kvStore.set(params[0] as string, params[1] as string)
					}
				}

				return { rowsAffected: cmds.length }
			})

			map.set("race-key", "old")

			// Fire the debounced persistAsync; it drains "old" and blocks inside executeBatch.
			cache.flush()
			vi.advanceTimersByTime(2000)
			await drainUntilExecuteBatch()

			expect(batchCalls).toBe(1)

			// Newer value + an immediate flush (the AppState background path).
			map.set("race-key", "new")

			const flushPromise = cache.flushNow()

			// Give the flush every chance to (incorrectly) jump the queue.
			for (let i = 0; i < 10; i++) {
				await Promise.resolve()
			}

			// Serialized writers: the flush must NOT have written while the older batch is in flight.
			expect(batchCalls).toBe(1)

			resolveFirstBatch()

			await flushPromise

			// Both batches landed in order — the newest value is what's on disk.
			expect(batchCalls).toBe(2)
			expect(deserialize(kvStore.get(kvKey(name, "race-key")) as string)).toBe("new")
		})
	})

	describe("logout wipe lock (#1) — re-arm", () => {
		it("restore() re-arms maps (ready=true) so the next session persists normally", async () => {
			const cache = createCache()

			await cache.restore()

			cache.clear()

			// All maps are not-ready after clear.
			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.ready).toBe(false)
			}

			// restore() (next authenticated session) must re-enable persistence.
			await cache.restore()

			// All maps must be ready again.
			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.ready).toBe(true)
			}

			const { name, map } = getFirstMap(cache)

			map.set("fresh", "value")

			cache.flush()
			vi.advanceTimersByTime(2000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name, "fresh"))).toBe(true)
		})
	})
})
