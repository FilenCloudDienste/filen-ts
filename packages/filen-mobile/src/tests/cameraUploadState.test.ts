import { vi, describe, it, expect, beforeEach } from "vitest"

// Shared in-memory kv, stored as SERIALIZED strings (mirrors the real kv + cache.test.ts): the store
// writes serialize(value) and reads deserialize back. executeBatch and forEachKvRowByPrefix operate
// on the same map.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, string>() }))

vi.mock("@/lib/logger", () => ({
	default: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn()
	}
}))

vi.mock("@/lib/sqlite", async () => {
	const { serialize, deserialize } = await import("@/lib/serializer")

	const db = {
		executeBatch: vi.fn(async (commands: [string, unknown[]][]) => {
			for (const [query, params] of commands) {
				if (query.startsWith("INSERT OR REPLACE")) {
					kvStore.set(params[0] as string, params[1] as string)
				} else if (query.startsWith("INSERT OR IGNORE")) {
					if (!kvStore.has(params[0] as string)) {
						kvStore.set(params[0] as string, params[1] as string)
					}
				} else if (query.startsWith("DELETE FROM kv WHERE key >= ?")) {
					const lower = params[0] as string
					const upper = params[1] as string

					for (const key of [...kvStore.keys()]) {
						if (key >= lower && key < upper) {
							kvStore.delete(key)
						}
					}
				} else if (query.startsWith("DELETE FROM kv WHERE key = ?")) {
					kvStore.delete(params[0] as string)
				}
			}

			return { rowsAffected: commands.length }
		})
	}

	return {
		default: {
			openDb: vi.fn(async () => db),
			kvAsync: {
				get: vi.fn(async (key: string) => {
					const raw = kvStore.get(key)

					return raw === undefined ? null : deserialize(raw)
				}),
				set: vi.fn(async (key: string, value: unknown) => {
					kvStore.set(key, serialize(value))

					return 1
				}),
				remove: vi.fn(async (key: string) => {
					kvStore.delete(key)
				})
			}
		}
	}
})

vi.mock("@/lib/kvScan", () => ({
	prefixUpperBound: (prefix: string): string => {
		if (prefix.length === 0) {
			return prefix
		}

		const lastIndex = prefix.length - 1

		return prefix.slice(0, lastIndex) + String.fromCharCode(prefix.charCodeAt(lastIndex) + 1)
	},
	forEachKvRowByPrefix: vi.fn(async (_db: unknown, prefix: string, onRow: (key: string, value: string) => void) => {
		const keys = [...kvStore.keys()].filter(key => key.startsWith(prefix)).sort()

		for (const key of keys) {
			onRow(key, kvStore.get(key) as string)
		}

		return keys.length
	})
}))

import { CameraUploadState } from "@/features/cameraUpload/cameraUploadState"
import { serialize, deserialize } from "@/lib/serializer"
import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix } from "@/lib/kvScan"
import logger from "@/lib/logger"

const HASHES_PREFIX = "cameraUpload:hashes:"
const ABORTS_PREFIX = "cameraUpload:aborts:"

function make(): CameraUploadState {
	return new CameraUploadState()
}

function seedHash(key: string, value: unknown): void {
	kvStore.set(HASHES_PREFIX + key, serialize(value))
}

function seedAbort(id: string, count: number): void {
	kvStore.set(ABORTS_PREFIX + id, serialize(count))
}

beforeEach(() => {
	kvStore.clear()
	vi.clearAllMocks()
})

describe("loadHashes", () => {
	it("pages new-prefix rows into memory (object + legacy string values)", async () => {
		seedHash("asset1", { md5: "m1", verifiedModificationTime: 5 })
		seedHash("asset2", "bare-md5")
		seedHash("/album/photo.jpg", "legacy-path")

		const state = make()

		await state.loadHashes()

		expect(state.getHashSync("asset1")).toEqual({ md5: "m1", verifiedModificationTime: 5 })
		expect(state.getHashSync("asset2")).toBe("bare-md5")
		expect(state.getHashSync("/album/photo.jpg")).toBe("legacy-path")
		expect(state.hashKeys().sort()).toEqual(["/album/photo.jpg", "asset1", "asset2"])
	})

	it("is single-flight — a second call after load does not re-scan", async () => {
		seedHash("asset1", "x")

		const state = make()

		await state.loadHashes()
		await state.loadHashes()

		expect(vi.mocked(forEachKvRowByPrefix)).toHaveBeenCalledTimes(1)
	})

	it("discards results when a clear bumps the generation mid-scan", async () => {
		seedHash("asset1", { md5: "m1", verifiedModificationTime: 5 })

		const state = make()

		vi.mocked(forEachKvRowByPrefix).mockImplementationOnce(async (_db, _prefix, onRow) => {
			onRow(HASHES_PREFIX + "asset1", serialize({ md5: "m1", verifiedModificationTime: 5 }))

			// A logout wipe lands mid-scan: bumps the generation and empties memory.
			state.clearForLogout()

			return 1
		})

		await state.loadHashes()

		// The scanned rows must NOT repopulate the just-wiped memory.
		expect(state.hashKeys()).toEqual([])
	})

	it("a corrupt scan logs a warn, range-deletes the prefix, and proceeds empty", async () => {
		seedHash("asset1", "x")
		seedHash("asset2", "y")

		const state = make()

		vi.mocked(forEachKvRowByPrefix).mockRejectedValueOnce(new Error("corrupt row"))

		await state.loadHashes()

		expect(logger.warn).toHaveBeenCalled()
		// Corrupt prefix wiped from kv.
		expect(kvStore.has(HASHES_PREFIX + "asset1")).toBe(false)
		expect(kvStore.has(HASHES_PREFIX + "asset2")).toBe(false)
		// Loaded empty — a subsequent read self-heals via re-verification.
		expect(state.hashKeys()).toEqual([])
		expect(state.getHashSync("asset1")).toBeUndefined()
	})
})

describe("getHash (background point reads)", () => {
	it("reads kv directly before any load", async () => {
		seedHash("asset1", { md5: "m1", verifiedModificationTime: 7 })

		const state = make()

		expect(await state.getHash("asset1")).toEqual({ md5: "m1", verifiedModificationTime: 7 })
	})

	it("returns undefined for a missing key", async () => {
		const state = make()

		expect(await state.getHash("nope")).toBeUndefined()
	})

	it("never throws when the kv read fails — degrades to undefined", async () => {
		seedHash("asset1", "x")

		const state = make()

		vi.mocked(sqlite.kvAsync.get).mockRejectedValueOnce(new Error("io error"))

		expect(await state.getHash("asset1")).toBeUndefined()
		expect(logger.warn).toHaveBeenCalled()
	})

	it("reads memory (not kv) once the index is loaded", async () => {
		seedHash("asset1", "x")

		const state = make()

		await state.loadHashes()

		vi.mocked(sqlite.kvAsync.get).mockClear()

		expect(await state.getHash("asset1")).toBe("x")
		expect(vi.mocked(sqlite.kvAsync.get)).not.toHaveBeenCalled()
	})
})

describe("write-through", () => {
	it("setHash updates memory immediately and writes the kv row", async () => {
		const state = make()

		await state.setHash("asset1", { md5: "m1", verifiedModificationTime: 9 })

		expect(state.getHashSync("asset1")).toEqual({ md5: "m1", verifiedModificationTime: 9 })
		expect(deserialize(kvStore.get(HASHES_PREFIX + "asset1") as string)).toEqual({ md5: "m1", verifiedModificationTime: 9 })
	})

	it("deleteHash removes from memory and kv", async () => {
		const state = make()

		await state.setHash("asset1", "x")
		await state.deleteHash("asset1")

		expect(state.getHashSync("asset1")).toBeUndefined()
		expect(kvStore.has(HASHES_PREFIX + "asset1")).toBe(false)
	})

	it("applyHashBatch applies upserts and deletes to memory and kv in one wave", async () => {
		const state = make()

		await state.loadHashes()
		await state.setHash("stale", "old")

		await state.applyHashBatch({
			upserts: [
				["a", { md5: "ma", verifiedModificationTime: 1 }],
				["b", "legacy"]
			],
			deletes: ["stale"]
		})

		expect(state.getHashSync("a")).toEqual({ md5: "ma", verifiedModificationTime: 1 })
		expect(state.getHashSync("b")).toBe("legacy")
		expect(state.getHashSync("stale")).toBeUndefined()
		expect(deserialize(kvStore.get(HASHES_PREFIX + "a") as string)).toEqual({ md5: "ma", verifiedModificationTime: 1 })
		expect(kvStore.has(HASHES_PREFIX + "stale")).toBe(false)
	})
})

describe("aborts ledger", () => {
	it("loadAborts pages the abort counts into memory", async () => {
		seedAbort("asset1", 2)
		seedAbort("asset2", 1)

		const state = make()

		await state.loadAborts()

		expect(state.getAbort("asset1")).toBe(2)
		expect(state.getAbort("asset2")).toBe(1)
	})

	it("setAbort / deleteAbort write through memory + kv", async () => {
		const state = make()

		await state.loadAborts()
		await state.setAbort("asset1", 1)

		expect(state.getAbort("asset1")).toBe(1)
		expect(deserialize(kvStore.get(ABORTS_PREFIX + "asset1") as string)).toBe(1)

		await state.setAbort("asset1", (state.getAbort("asset1") ?? 0) + 1)

		expect(state.getAbort("asset1")).toBe(2)

		await state.deleteAbort("asset1")

		expect(state.getAbort("asset1")).toBeUndefined()
		expect(kvStore.has(ABORTS_PREFIX + "asset1")).toBe(false)
	})
})

describe("clearForLogout", () => {
	it("empties both maps", async () => {
		seedHash("asset1", "x")
		seedAbort("asset1", 1)

		const state = make()

		await state.loadHashes()
		await state.loadAborts()

		expect(state.hashKeys()).toEqual(["asset1"])
		expect(state.getAbort("asset1")).toBe(1)

		state.clearForLogout()

		expect(state.hashKeys()).toEqual([])
		expect(state.getAbort("asset1")).toBeUndefined()
	})

	it("refuses writes while locked (a worker-tail write cannot re-insert)", async () => {
		const state = make()

		await state.loadHashes()

		state.clearForLogout()

		await state.setHash("leak", { md5: "secret", verifiedModificationTime: 1 })
		await state.setAbort("leak", 3)
		await state.applyHashBatch({ upserts: [["leak2", "x"]] })

		expect(state.getHashSync("leak")).toBeUndefined()
		expect(state.getHashSync("leak2")).toBeUndefined()
		expect(state.getAbort("leak")).toBeUndefined()
		expect(kvStore.has(HASHES_PREFIX + "leak")).toBe(false)
		expect(kvStore.has(ABORTS_PREFIX + "leak")).toBe(false)
	})

	it("the next load un-locks so the fresh session can write again", async () => {
		const state = make()

		state.clearForLogout()

		// A fresh session's load un-locks.
		await state.loadHashes()

		await state.setHash("fresh", "value")

		expect(state.getHashSync("fresh")).toBe("value")
		expect(kvStore.has(HASHES_PREFIX + "fresh")).toBe(true)
	})
})
