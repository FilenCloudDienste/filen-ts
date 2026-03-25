import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"

const { UniffiEnum } = vi.hoisted(() => ({
	UniffiEnum: class UniffiEnum {
		protected constructor(..._args: any[]) {}
	}
}))

const { mockDb, open } = vi.hoisted(() => {
	const mockDb = {
		execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		close: vi.fn()
	}

	return { mockDb, open: vi.fn(() => mockDb) }
})

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

import { PersistentMap } from "@/lib/cache"
import { pack, unpack } from "@/lib/msgpack"

type Cache = any

/**
 * In-memory KV store that simulates sqlite.kvAsync behavior.
 * Values are stored as msgpack blobs (Uint8Array) just like the real SQLite KV.
 */
const kvStore = new Map<string, Uint8Array>()

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
			const value = params![1] as Uint8Array

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

		if (query.startsWith("SELECT key, value FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: { key: string; value: ArrayBuffer }[] = []

			for (const [key, value] of kvStore) {
				if (matchesLike(key, pattern)) {
					rows.push({ key, value: value.buffer })
				}
			}

			return { rows, insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT value FROM kv")) {
			const key = params![0] as string
			const value = kvStore.get(key)

			return { rows: value ? [{ value: value.buffer }] : [], insertId: undefined, rowsAffected: 0 }
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

	mockDb.executeBatch.mockImplementation(async (commands: [string, unknown[]][]) => {
		for (const [query, params] of commands) {
			if (query.startsWith("INSERT OR REPLACE")) {
				kvStore.set(params[0] as string, params[1] as Uint8Array)
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

async function createCache(): Promise<Cache> {
	const mod = await import("@/lib/cache")

	return new (mod.default.constructor as new () => Cache)()
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

/** Returns the SQLite KV prefix for a given map field name. */
function kvPrefix(mapName: string): string {
	return `cache:v1:${mapName}`
}

/** Returns the SQLite KV key for a given map field name + entry key. */
function kvKey(mapName: string, entryKey: string): string {
	return `cache:v1:${mapName}:${entryKey}`
}

/** Creates a ready PersistentMap for unit tests (ready = true so writes are allowed). */
function createReadyMap<V>(onMutate: () => void = () => {}): PersistentMap<V> {
	const map = new PersistentMap<V>(onMutate)

	map.ready = true

	return map
}

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

	it("calls onMutate on every set, even overwrites", () => {
		const onMutate = vi.fn()
		const map = createReadyMap<string>(onMutate)

		map.set("key", "first")
		map.set("key", "second")

		expect(onMutate).toHaveBeenCalledTimes(2)
		expect(map.get("key")).toBe("second")
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
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("constructor", () => {
		it("maps are not ready before restore", async () => {
			const cache = await createCache()
			const { map } = getFirstMap(cache)

			expect(map.ready).toBe(false)
			expect(() => map.set("key", "value")).toThrow("Cache not restored yet")
		})

		it("has at least one PersistentMap field", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)

			expect(maps.length).toBeGreaterThan(0)
		})
	})

	describe("restore", () => {
		it("populates a map from per-key SQLite entries", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)

			kvStore.set(kvKey(name, "key-1"), new Uint8Array(pack("value-1")))
			kvStore.set(kvKey(name, "key-2"), new Uint8Array(pack("value-2")))

			const cache2 = await createCache()

			await cache2.restore()

			const restored = cache2[name] as PersistentMap<unknown>

			expect(restored.get("key-1")).toBe("value-1")
			expect(restored.get("key-2")).toBe("value-2")
			expect(restored.size).toBe(2)
		})

		it("sets all maps to ready after restore", async () => {
			const cache = await createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.ready).toBe(true)
			}

			const { map } = getFirstMap(cache)

			expect(() => map.set("key", "value")).not.toThrow()
		})

		it("restores all PersistentMap fields from separate SQLite keys", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)

			for (const [mapName] of maps) {
				kvStore.set(kvKey(mapName, `${mapName}-key`), new Uint8Array(pack(`${mapName}-value`)))
			}

			const cache2 = await createCache()

			await cache2.restore()

			for (const [mapName] of maps) {
				const restored = cache2[mapName] as PersistentMap<unknown>

				expect(restored.get(`${mapName}-key`)).toBe(`${mapName}-value`)
			}
		})

		it("does nothing when SQLite keys do not exist", async () => {
			const cache = await createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

		it("only populates the map with matching prefix entries", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)
			const firstMap = maps[0] as [string, PersistentMap<unknown>]

			kvStore.set(kvKey(firstMap[0], "k"), new Uint8Array(pack("v")))

			const cache2 = await createCache()

			await cache2.restore()

			expect((cache2[firstMap[0]] as PersistentMap<unknown>).get("k")).toBe("v")

			for (const [mapName, map] of getPersistentMaps(cache2)) {
				if (mapName !== firstMap[0]) {
					expect(map.size).toBe(0)
				}
			}
		})

		it("handles corrupted data for one map without affecting others", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)
			const firstMap = maps[0] as [string, PersistentMap<unknown>]
			const secondMap = maps[1] as [string, PersistentMap<unknown>]

			const corruptBlob = new Uint8Array([0xff, 0xfe, 0x00, 0xab, 0xcd])

			kvStore.set(kvKey(firstMap[0], "corrupt"), corruptBlob)
			kvStore.set(kvKey(secondMap[0], "good-key"), new Uint8Array(pack("good-value")))

			const cache2 = await createCache()

			await expect(cache2.restore()).resolves.toBeUndefined()

			expect((cache2[firstMap[0]] as PersistentMap<unknown>).size).toBe(0)
			expect((cache2[secondMap[0]] as PersistentMap<unknown>).get("good-key")).toBe("good-value")
		})

		it("does not trigger onMutate during restore (no write-back cycle)", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)

			kvStore.set(kvKey(name, "key-1"), new Uint8Array(pack("value-1")))

			const cache2 = await createCache()

			mockDb.executeBatch.mockClear()

			await cache2.restore()

			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
			expect((cache2[name] as PersistentMap<unknown>).get("key-1")).toBe("value-1")
		})
	})

	describe("persist (via flush)", () => {
		it("writes per-key entries to SQLite on flush", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("uuid-1", "Documents")
			map.set("uuid-2", "Photos")

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			const stored1 = kvStore.get(kvKey(name, "uuid-1"))
			const stored2 = kvStore.get(kvKey(name, "uuid-2"))

			expect(stored1).toBeInstanceOf(Uint8Array)
			expect(stored2).toBeInstanceOf(Uint8Array)
			expect(unpack(stored1 as Uint8Array)).toBe("Documents")
			expect(unpack(stored2 as Uint8Array)).toBe("Photos")
		})

		it("persists entries from each map under its own prefix", async () => {
			const cache = await createCache()

			await cache.restore()

			const maps = getPersistentMaps(cache)

			for (const [, map] of maps) {
				map.set("test-key", "test-value")
			}

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				const stored = kvStore.get(kvKey(mapName, "test-key"))

				expect(stored).toBeInstanceOf(Uint8Array)
				expect(unpack(stored as Uint8Array)).toBe("test-value")
			}
		})

		it("debounces multiple mutations into a single batch write", async () => {
			const cache = await createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			mockDb.executeBatch.mockClear()

			map.set("a", "1")
			map.set("b", "2")
			map.set("c", "3")

			expect(mockDb.executeBatch).not.toHaveBeenCalled()

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
		})

		it("only persists changed entries, not the entire map", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("a", "1")
			map.set("b", "2")

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			mockDb.executeBatch.mockClear()

			// Only change one entry
			map.set("a", "updated")

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const commands = mockDb.executeBatch.mock.calls[0]![0] as [string, unknown[]][]

			// Should only write the changed entry, not both
			expect(commands).toHaveLength(1)
			expect(commands[0]![1]![0]).toBe(kvKey(name, "a"))
		})

		it("persists data that survives a full restore round-trip", async () => {
			const cache1 = await createCache()

			await cache1.restore()

			const { name, map } = getFirstMap(cache1)

			map.set("round-trip-key", "round-trip-value")

			cache1.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			const cache2 = await createCache()

			await cache2.restore()

			expect((cache2[name] as PersistentMap<unknown>).get("round-trip-key")).toBe("round-trip-value")
		})
	})

	describe("clear", () => {
		it("empties all PersistentMap instances", async () => {
			const cache = await createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				map.set("key", "value")
			}

			cache.clear()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

		it("removes per-key entries from SQLite", async () => {
			const cache = await createCache()

			await cache.restore()

			const maps = getPersistentMaps(cache)

			for (const [, map] of maps) {
				map.set("key", "value")
			}

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				expect(kvStore.has(kvKey(mapName, "key"))).toBe(true)
			}

			cache.clear()
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				expect(kvStore.has(kvKey(mapName, "key"))).toBe(false)
			}
		})

		it("does not throw when SQLite keys do not exist", async () => {
			const cache = await createCache()

			expect(() => cache.clear()).not.toThrow()
		})

		it("also clears secureStore", async () => {
			const cache = await createCache()

			cache.secureStore.set("secret-key", "secret-value")
			cache.secureStore.set("another-key", "another-value")

			expect(cache.secureStore.size).toBe(2)

			cache.clear()

			expect(cache.secureStore.size).toBe(0)
		})

		it("cancels any pending debounced persist", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("key", "value")

			cache.clear()

			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name, "key"))).toBe(false)
		})

		it("does not trigger onMutate when clearing maps (uses Map.prototype.clear)", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("key", "value")
			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			kvStore.delete(kvKey(name, "key"))

			cache.clear()

			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name, "key"))).toBe(false)
		})
	})

	describe("auto-discovery", () => {
		it("persists exactly the PersistentMap fields found on the instance", async () => {
			const cache = await createCache()

			await cache.restore()

			const maps = getPersistentMaps(cache)

			for (const [, map] of maps) {
				map.set("test-key", "test-value")
			}

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				const stored = kvStore.get(kvKey(mapName, "test-key"))

				expect(stored).toBeInstanceOf(Uint8Array)
				expect(unpack(stored as Uint8Array)).toBe("test-value")
			}
		})

		it("does not persist non-PersistentMap fields", async () => {
			const cache = await createCache()

			await cache.restore()

			const { map } = getFirstMap(cache)

			map.set("key", "value")

			cache._testField = "should not persist"

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has("cache:v1:_testField")).toBe(false)
		})
	})
})
