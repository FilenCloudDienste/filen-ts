import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"

const { UniffiEnum } = vi.hoisted(() => ({
	UniffiEnum: class UniffiEnum {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		protected constructor(..._args: any[]) {}
	}
}))

const { mockDb, openDatabaseAsync } = vi.hoisted(() => {
	const mockDb = {
		execAsync: vi.fn(),
		getFirstAsync: vi.fn(),
		getAllAsync: vi.fn(),
		runAsync: vi.fn()
	}

	const openDatabaseAsync = vi.fn().mockResolvedValue(mockDb)

	return { mockDb, openDatabaseAsync }
})

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-sqlite", () => ({
	openDatabaseAsync
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

// eslint-disable-next-line import/first
import { PersistentMap } from "@/lib/cache"
// eslint-disable-next-line import/first
import { pack, unpack } from "@/lib/msgpack"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cache = any

/**
 * In-memory KV store that simulates sqlite.kvAsync behavior.
 * Values are stored as msgpack blobs (Uint8Array) just like the real SQLite KV.
 */
const kvStore = new Map<string, Uint8Array>()

function setupMockDb(): void {
	mockDb.execAsync.mockResolvedValue(undefined)

	mockDb.runAsync.mockImplementation(async (query: string, params: unknown[]) => {
		if (query.startsWith("INSERT OR REPLACE")) {
			const key = params[0] as string
			const value = params[1] as Uint8Array

			kvStore.set(key, value)

			return { lastInsertRowId: 1, changes: 1 }
		}

		if (query.startsWith("DELETE FROM kv WHERE")) {
			const key = params[0] as string

			kvStore.delete(key)

			return { lastInsertRowId: 0, changes: 1 }
		}

		if (query === "DELETE FROM kv") {
			kvStore.clear()

			return { lastInsertRowId: 0, changes: kvStore.size }
		}

		return { lastInsertRowId: 0, changes: 0 }
	})

	mockDb.getFirstAsync.mockImplementation(async (query: string, params: unknown[]) => {
		if (query.startsWith("SELECT value FROM kv")) {
			const key = params[0] as string
			const value = kvStore.get(key)

			if (!value) {
				return null
			}

			return { value }
		}

		if (query.startsWith("SELECT key FROM kv WHERE")) {
			const key = params[0] as string

			return kvStore.has(key) ? { key } : null
		}

		return null
	})

	mockDb.getAllAsync.mockImplementation(async (query: string) => {
		if (query.startsWith("SELECT key FROM kv")) {
			return [...kvStore.keys()].map(key => ({ key }))
		}

		return []
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

/** Returns the SQLite KV key for a given map field name. */
function kvKey(mapName: string): string {
	return `cache:v1:${mapName}`
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
		it("populates a map from SQLite", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)
			const entries = [
				["key-1", "value-1"],
				["key-2", "value-2"]
			]

			kvStore.set(kvKey(name), new Uint8Array(pack(entries)))

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
				const entries = [[`${mapName}-key`, `${mapName}-value`]]

				kvStore.set(kvKey(mapName), new Uint8Array(pack(entries)))
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

		it("skips maps whose SQLite key returns null", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)
			const firstMap = maps[0] as [string, PersistentMap<unknown>]

			kvStore.set(kvKey(firstMap[0]), new Uint8Array(pack([["k", "v"]])))

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

			// Corrupt data for first map — getFirstAsync returns a blob that unpack will choke on
			const corruptBlob = new Uint8Array([0xff, 0xfe, 0x00, 0xab, 0xcd])

			kvStore.set(kvKey(firstMap[0]), corruptBlob)
			// Valid data for second map
			kvStore.set(kvKey(secondMap[0]), new Uint8Array(pack([["good-key", "good-value"]])))

			const cache2 = await createCache()

			await expect(cache2.restore()).resolves.toBeUndefined()

			expect((cache2[firstMap[0]] as PersistentMap<unknown>).size).toBe(0)
			expect((cache2[secondMap[0]] as PersistentMap<unknown>).get("good-key")).toBe("good-value")
		})

		it("does not trigger onMutate during restore (no write-back cycle)", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)

			kvStore.set(kvKey(name), new Uint8Array(pack([["key-1", "value-1"]])))

			const cache2 = await createCache()

			await cache2.restore()

			// Record the current INSERT call count
			const insertsBefore = mockDb.runAsync.mock.calls.filter(
				(call: unknown[]) => typeof call[0] === "string" && (call[0] as string).startsWith("INSERT")
			).length

			vi.advanceTimersByTime(5000)

			// Allow any pending microtasks to flush
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			const insertsAfter = mockDb.runAsync.mock.calls.filter(
				(call: unknown[]) => typeof call[0] === "string" && (call[0] as string).startsWith("INSERT")
			).length

			// No additional INSERT calls should have been made
			expect(insertsAfter).toBe(insertsBefore)
			expect((cache2[name] as PersistentMap<unknown>).get("key-1")).toBe("value-1")
		})
	})

	describe("persist (via flush)", () => {
		it("writes PersistentMap data to SQLite on flush", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("uuid-1", "Documents")
			map.set("uuid-2", "Photos")

			cache.flush()
			vi.advanceTimersByTime(5000)

			// Allow async SQLite write to complete
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			const stored = kvStore.get(kvKey(name))

			expect(stored).toBeInstanceOf(Uint8Array)

			const entries = unpack(stored as Uint8Array) as [string, unknown][]

			expect(entries).toEqual([
				["uuid-1", "Documents"],
				["uuid-2", "Photos"]
			])
		})

		it("persists each map to its own SQLite key", async () => {
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
				const stored = kvStore.get(kvKey(mapName))

				expect(stored).toBeInstanceOf(Uint8Array)

				const entries = unpack(stored as Uint8Array) as [string, unknown][]

				expect(entries).toEqual([["test-key", "test-value"]])
			}
		})

		it("debounces multiple mutations into a single write per map", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			let writeCount = 0
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const originalImpl = mockDb.runAsync.getMockImplementation() as (...args: any[]) => any

			mockDb.runAsync.mockImplementation(async (...args: unknown[]) => {
				const query = args[0] as string
				const params = args[1] as unknown[]

				if (query.startsWith("INSERT") && (params[0] as string) === kvKey(name)) {
					writeCount++
				}

				return originalImpl(...args)
			})

			map.set("a", "1")
			map.set("b", "2")
			map.set("c", "3")

			expect(writeCount).toBe(0)

			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(writeCount).toBe(1)

			mockDb.runAsync.mockImplementation(originalImpl)
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

		it("removes cache keys from SQLite", async () => {
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
				expect(kvStore.has(kvKey(mapName))).toBe(true)
			}

			cache.clear()
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			for (const [mapName] of maps) {
				expect(kvStore.has(kvKey(mapName))).toBe(false)
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

			// The key should have been removed by clear(), not written by the persist
			expect(kvStore.has(kvKey(name))).toBe(false)
		})

		it("does not trigger onMutate when clearing maps (uses Map.prototype.clear)", async () => {
			const cache = await createCache()

			await cache.restore()

			const { name, map } = getFirstMap(cache)

			map.set("key", "value")
			cache.flush()
			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			// Remove the key so we can detect if persist rewrites it
			kvStore.delete(kvKey(name))

			cache.clear()

			vi.advanceTimersByTime(5000)
			await vi.advanceTimersToNextTimerAsync().catch(() => {})

			expect(kvStore.has(kvKey(name))).toBe(false)
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
				const stored = kvStore.get(kvKey(mapName))

				expect(stored).toBeInstanceOf(Uint8Array)

				const entries = unpack(stored as Uint8Array) as [string, unknown][]

				expect(entries).toHaveLength(1)
				expect(entries[0]).toEqual(["test-key", "test-value"])
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
