import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

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

// eslint-disable-next-line import/first
import { PersistentMap } from "@/lib/cache"
// eslint-disable-next-line import/first
import { pack, unpack } from "@/lib/msgpack"
// eslint-disable-next-line import/first
import { fs } from "@/tests/mocks/expoFileSystem"

const CACHE_DIR_URI = "file:///shared/group.io.filen.app/cache"
const CACHE_FILE_URI = "file:///shared/group.io.filen.app/cache/cache.v1.bin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cache = any

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

describe("PersistentMap", () => {
	it("calls onMutate when set is called", () => {
		const onMutate = vi.fn()
		const map = new PersistentMap<string>(onMutate)

		map.set("key", "value")

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.get("key")).toBe("value")
	})

	it("calls onMutate when delete removes an existing key", () => {
		const onMutate = vi.fn()
		const map = new PersistentMap<string>(onMutate)

		map.set("key", "value")
		onMutate.mockClear()

		map.delete("key")

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.has("key")).toBe(false)
	})

	it("does not call onMutate when delete targets a missing key", () => {
		const onMutate = vi.fn()
		const map = new PersistentMap<string>(onMutate)

		map.delete("nonexistent")

		expect(onMutate).not.toHaveBeenCalled()
	})

	it("calls onMutate when clear is called on a non-empty map", () => {
		const onMutate = vi.fn()
		const map = new PersistentMap<string>(onMutate)

		map.set("a", "1")
		map.set("b", "2")
		onMutate.mockClear()

		map.clear()

		expect(onMutate).toHaveBeenCalledTimes(1)
		expect(map.size).toBe(0)
	})

	it("does not call onMutate when clear is called on an empty map", () => {
		const onMutate = vi.fn()
		const map = new PersistentMap<string>(onMutate)

		map.clear()

		expect(onMutate).not.toHaveBeenCalled()
	})

	it("returns this from set for chaining", () => {
		const map = new PersistentMap<string>(() => {})

		const result = map.set("a", "1").set("b", "2")

		expect(result).toBe(map)
		expect(map.size).toBe(2)
	})

	it("inherits all Map methods (get, has, size, entries, forEach)", () => {
		const map = new PersistentMap<number>(() => {})

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
		const map = new PersistentMap<string>(onMutate)

		map.set("key", "first")
		map.set("key", "second")

		expect(onMutate).toHaveBeenCalledTimes(2)
		expect(map.get("key")).toBe("second")
	})

	it("delete returns true for existing key and false for missing key", () => {
		const map = new PersistentMap<string>(() => {})

		map.set("key", "value")

		expect(map.delete("key")).toBe(true)
		expect(map.delete("key")).toBe(false)
		expect(map.delete("nonexistent")).toBe(false)
	})
})

describe("Cache", () => {
	beforeEach(() => {
		fs.clear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("constructor", () => {
		it("creates the cache directory if it does not exist", async () => {
			await createCache()

			expect(fs.get(CACHE_DIR_URI)).toBe("dir")
		})

		it("does not throw if the cache directory already exists", async () => {
			fs.set(CACHE_DIR_URI, "dir")

			await expect(createCache()).resolves.toBeDefined()
		})

		it("has at least one PersistentMap field", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)

			expect(maps.length).toBeGreaterThan(0)
		})
	})

	describe("restore", () => {
		it("populates a map from disk", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)

			const data: Record<string, [string, unknown][]> = {
				[name]: [
					["key-1", "value-1"],
					["key-2", "value-2"]
				]
			}

			fs.set(CACHE_DIR_URI, "dir")
			fs.set(CACHE_FILE_URI, pack(data))

			const cache2 = await createCache()

			await cache2.restore()

			const restored = cache2[name] as PersistentMap<unknown>

			expect(restored.get("key-1")).toBe("value-1")
			expect(restored.get("key-2")).toBe("value-2")
			expect(restored.size).toBe(2)
		})

		it("restores all PersistentMap fields from a single file", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)

			const data: Record<string, [string, unknown][]> = {}

			for (const [mapName] of maps) {
				data[mapName] = [[`${mapName}-key`, `${mapName}-value`]]
			}

			fs.set(CACHE_DIR_URI, "dir")
			fs.set(CACHE_FILE_URI, pack(data))

			const cache2 = await createCache()

			await cache2.restore()

			for (const [mapName] of maps) {
				const restored = cache2[mapName] as PersistentMap<unknown>

				expect(restored.get(`${mapName}-key`)).toBe(`${mapName}-value`)
			}
		})

		it("does nothing when file does not exist", async () => {
			const cache = await createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

		it("does nothing when file is empty", async () => {
			fs.set(CACHE_DIR_URI, "dir")
			fs.set(CACHE_FILE_URI, new Uint8Array([]))

			const cache = await createCache()

			await cache.restore()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

		it("skips unknown keys in persisted data", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)

			const data: Record<string, [string, unknown][]> = {
				[name]: [["real-key", "real-value"]],
				nonExistentMap: [["x", "y"]]
			}

			fs.set(CACHE_DIR_URI, "dir")
			fs.set(CACHE_FILE_URI, pack(data))

			const cache2 = await createCache()

			await cache2.restore()

			expect((cache2[name] as PersistentMap<unknown>).get("real-key")).toBe("real-value")
			expect(cache2["nonExistentMap"]).toBeUndefined()
		})

		it("does not throw on corrupted cache file and deletes it", async () => {
			fs.set(CACHE_DIR_URI, "dir")
			fs.set(CACHE_FILE_URI, new Uint8Array([0xff, 0xfe, 0x00, 0xab, 0xcd]))

			const cache = await createCache()

			await expect(cache.restore()).resolves.toBeUndefined()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}

			expect(fs.has(CACHE_FILE_URI)).toBe(false)
		})

		it("does not trigger onMutate during restore (no write-back cycle)", async () => {
			const cache = await createCache()
			const { name } = getFirstMap(cache)

			const data: Record<string, [string, unknown][]> = {
				[name]: [["key-1", "value-1"]]
			}

			fs.set(CACHE_DIR_URI, "dir")
			fs.set(CACHE_FILE_URI, pack(data))

			const cache2 = await createCache()

			await cache2.restore()

			expect(fs.get(CACHE_FILE_URI)).toBeInstanceOf(Uint8Array)

			// Wipe the file to detect if persist() rewrites it
			fs.delete(CACHE_FILE_URI)

			vi.advanceTimersByTime(5000)

			// File should still be deleted — no persist was triggered
			expect(fs.has(CACHE_FILE_URI)).toBe(false)
			expect((cache2[name] as PersistentMap<unknown>).get("key-1")).toBe("value-1")
		})
	})

	describe("persist (via flush)", () => {
		it("writes PersistentMap data to disk on flush", async () => {
			const cache = await createCache()
			const { name, map } = getFirstMap(cache)

			map.set("uuid-1", "Documents")
			map.set("uuid-2", "Photos")

			cache.flush()
			vi.advanceTimersByTime(5000)

			const bytes = fs.get(CACHE_FILE_URI) as Uint8Array

			expect(bytes).toBeInstanceOf(Uint8Array)

			const data = unpack(bytes) as Record<string, unknown>

			expect(data[name]).toEqual([
				["uuid-1", "Documents"],
				["uuid-2", "Photos"]
			])
		})

		it("debounces multiple mutations into a single write", async () => {
			const cache = await createCache()
			const { map } = getFirstMap(cache)

			let writeCount = 0
			const originalSet = fs.set.bind(fs)

			fs.set = (...args: Parameters<typeof originalSet>) => {
				if (typeof args[0] === "string" && args[0] === CACHE_FILE_URI) {
					writeCount++
				}

				return originalSet(...args)
			}

			map.set("a", "1")
			map.set("b", "2")
			map.set("c", "3")

			expect(writeCount).toBe(0)

			vi.advanceTimersByTime(5000)

			cache.flush()

			expect(writeCount).toBe(1)

			fs.set = originalSet
		})

		it("persists data that survives a full restore round-trip", async () => {
			const cache1 = await createCache()
			const { name, map } = getFirstMap(cache1)

			map.set("round-trip-key", "round-trip-value")

			cache1.flush()
			vi.advanceTimersByTime(5000)

			const cache2 = await createCache()

			await cache2.restore()

			expect((cache2[name] as PersistentMap<unknown>).get("round-trip-key")).toBe("round-trip-value")
		})

		it("persists all PersistentMap fields in a single file", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)

			for (const [mapName, map] of maps) {
				map.set(`${mapName}-key`, `${mapName}-value`)
			}

			cache.flush()
			vi.advanceTimersByTime(5000)

			const bytes = fs.get(CACHE_FILE_URI) as Uint8Array
			const data = unpack(bytes) as Record<string, [string, unknown][]>

			for (const [mapName] of maps) {
				expect(data[mapName]).toEqual([[`${mapName}-key`, `${mapName}-value`]])
			}
		})
	})

	describe("clear", () => {
		it("empties all PersistentMap instances", async () => {
			const cache = await createCache()

			for (const [, map] of getPersistentMaps(cache)) {
				map.set("key", "value")
			}

			cache.clear()

			for (const [, map] of getPersistentMaps(cache)) {
				expect(map.size).toBe(0)
			}
		})

		it("deletes the cache file from disk", async () => {
			const cache = await createCache()
			const { map } = getFirstMap(cache)

			map.set("key", "value")
			cache.flush()
			vi.advanceTimersByTime(5000)

			expect(fs.has(CACHE_FILE_URI)).toBe(true)

			cache.clear()

			expect(fs.has(CACHE_FILE_URI)).toBe(false)
		})

		it("does not throw when file does not exist", async () => {
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
			const { map } = getFirstMap(cache)

			map.set("key", "value")

			cache.clear()

			vi.advanceTimersByTime(5000)

			expect(fs.has(CACHE_FILE_URI)).toBe(false)
		})

		it("does not trigger onMutate when clearing maps (uses Map.prototype.clear)", async () => {
			const cache = await createCache()
			const { map } = getFirstMap(cache)

			map.set("key", "value")
			cache.flush()
			vi.advanceTimersByTime(5000)

			fs.delete(CACHE_FILE_URI)

			cache.clear()

			vi.advanceTimersByTime(5000)

			expect(fs.has(CACHE_FILE_URI)).toBe(false)
		})
	})

	describe("cleanupTmp", () => {
		it("removes stale .tmp files from the cache directory on construction", async () => {
			fs.set(CACHE_DIR_URI, "dir")
			fs.set(`${CACHE_DIR_URI}/cache.v1.bin.mock-uuid-0.tmp`, new Uint8Array([1, 2, 3]))
			fs.set(`${CACHE_DIR_URI}/cache.v1.bin.mock-uuid-1.tmp`, new Uint8Array([4, 5, 6]))
			fs.set(CACHE_FILE_URI, new Uint8Array([]))

			await createCache()

			expect(fs.has(`${CACHE_DIR_URI}/cache.v1.bin.mock-uuid-0.tmp`)).toBe(false)
			expect(fs.has(`${CACHE_DIR_URI}/cache.v1.bin.mock-uuid-1.tmp`)).toBe(false)
			expect(fs.has(CACHE_FILE_URI)).toBe(true)
		})
	})

	describe("auto-discovery", () => {
		it("persists exactly the PersistentMap fields found on the instance", async () => {
			const cache = await createCache()
			const maps = getPersistentMaps(cache)

			for (const [, map] of maps) {
				map.set("test-key", "test-value")
			}

			cache.flush()
			vi.advanceTimersByTime(5000)

			const bytes = fs.get(CACHE_FILE_URI) as Uint8Array
			const data = unpack(bytes) as Record<string, [string, unknown][]>
			const persistedKeys = Object.keys(data)
			const mapKeys = maps.map(([name]) => name)

			expect(persistedKeys.sort()).toEqual(mapKeys.sort())

			for (const entries of Object.values(data)) {
				expect(entries).toHaveLength(1)
				expect(entries[0]).toEqual(["test-key", "test-value"])
			}
		})

		it("does not persist non-PersistentMap fields", async () => {
			const cache = await createCache()
			const { map } = getFirstMap(cache)

			map.set("key", "value")

			cache._testField = "should not persist"

			cache.flush()
			vi.advanceTimersByTime(5000)

			const bytes = fs.get(CACHE_FILE_URI) as Uint8Array
			const data = unpack(bytes) as Record<string, unknown>

			expect(data["_testField"]).toBeUndefined()
		})
	})
})
