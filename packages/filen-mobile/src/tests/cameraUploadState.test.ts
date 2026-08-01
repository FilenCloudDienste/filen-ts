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
		// Single-statement spy — exposed on the fake DB alongside executeBatch so the two-tier fake
		// mirrors the real op-sqlite surface. The store's kv writes go through executeBatch; this is here
		// for inspectability/parity and stays a no-op unless a future path calls it.
		execute: vi.fn(async () => ({ rows: [], rowsAffected: 0, insertId: undefined })),
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
				}),
				getMany: vi.fn(async (keys: string[]) => {
					const found = new Map<string, unknown>()

					for (const key of keys) {
						const raw = kvStore.get(key)

						// Absent keys are ABSENT, not null — the contract the caller relies on to tell
						// "no shield entry" from "entry with a falsy value".
						if (raw !== undefined) {
							found.set(key, deserialize(raw))
						}
					}

					return found
				})
			}
		}
	}
})

vi.mock("@/lib/kvScan", () => ({
	// Mirrors the real prefixUpperBound contract: an empty or U+FFFF-terminated prefix cannot form a
	// valid exclusive upper bound, so the real function throws — the fake must too, or it could drift.
	prefixUpperBound: (prefix: string): string => {
		const lastIndex = prefix.length - 1

		if (prefix.length === 0 || prefix.charCodeAt(lastIndex) === 0xffff) {
			throw new Error("prefixUpperBound: prefix must be non-empty and must not end in U+FFFF")
		}

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

	it("skips a single corrupt row: commits the valid rows and DELETEs only the bad key", async () => {
		seedHash("good1", { md5: "m1", verifiedModificationTime: 1 })
		seedHash("good2", "legacy")
		// A value deserialize (JSON.parse) cannot parse — the per-row try/catch must drop just this one.
		kvStore.set(HASHES_PREFIX + "corrupt", "{ not valid json ")

		const state = make()
		const db = await sqlite.openDb()

		await state.loadHashes()

		// The two valid rows are committed to memory.
		expect(state.getHashSync("good1")).toEqual({ md5: "m1", verifiedModificationTime: 1 })
		expect(state.getHashSync("good2")).toBe("legacy")
		// The corrupt row is dropped from memory and range-deleted from kv.
		expect(state.getHashSync("corrupt")).toBeUndefined()
		expect(kvStore.has(HASHES_PREFIX + "corrupt")).toBe(false)
		expect(kvStore.has(HASHES_PREFIX + "good1")).toBe(true)

		// A DELETE targeting exactly the corrupt key was issued via the executeBatch spy.
		const deletedCorruptKey = vi
			.mocked(db.executeBatch)
			.mock.calls.some(([commands]) =>
				(commands as [string, unknown[]][]).some(
					([query, params]) => query.startsWith("DELETE FROM kv WHERE key = ?") && params[0] === HASHES_PREFIX + "corrupt"
				)
			)

		expect(deletedCorruptKey).toBe(true)
		expect(logger.warn).toHaveBeenCalled()
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

	it("dual-mode read: getHash point-reads kv WITHOUT a load; getHashSync serves memory AFTER a load", async () => {
		seedHash("dual", { md5: "m", verifiedModificationTime: 2 })

		// Fresh instance, no loadHashes: the async getHash point-reads the fake kv and returns the row.
		const fresh = make()

		expect(await fresh.getHash("dual")).toEqual({ md5: "m", verifiedModificationTime: 2 })
		expect(vi.mocked(sqlite.kvAsync.get)).toHaveBeenCalledWith(HASHES_PREFIX + "dual")

		// A loaded instance serves the same row synchronously from memory.
		const loaded = make()

		await loaded.loadHashes()

		expect(loaded.getHashSync("dual")).toEqual({ md5: "m", verifiedModificationTime: 2 })
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

	it("setHash updates memory synchronously BEFORE the kv write promise resolves (memory-first)", async () => {
		const state = make()

		// Gate the kv write so we can observe the store state mid-flight.
		let releaseSet!: () => void
		const setGate = new Promise<void>(resolve => {
			releaseSet = resolve
		})

		vi.mocked(sqlite.kvAsync.set).mockImplementationOnce(async (key: string, value: unknown) => {
			await setGate

			kvStore.set(key, serialize(value))

			return 1
		})

		const pending = state.setHash("mem", { md5: "m", verifiedModificationTime: 3 })

		// Memory already reflects the write while the kv write promise is still pending.
		expect(state.getHashSync("mem")).toEqual({ md5: "m", verifiedModificationTime: 3 })
		expect(kvStore.has(HASHES_PREFIX + "mem")).toBe(false)

		releaseSet()

		await pending

		// The gated write lands only after it resolves.
		expect(deserialize(kvStore.get(HASHES_PREFIX + "mem") as string)).toEqual({ md5: "m", verifiedModificationTime: 3 })
	})

	it("applyHashBatch stops issuing executeBatch chunks when a logout lands mid-wave", async () => {
		const state = make()
		const db = await sqlite.openDb()

		// 300 upserts → two chunks at APPLY_CHUNK_SIZE=256 (256 + 44).
		const upserts: [string, string][] = []

		for (let i = 0; i < 300; i++) {
			upserts.push([`asset${i}`, `md5-${i}`])
		}

		// After the first chunk lands, a logout latches the store — the per-chunk re-check must abort the tail.
		vi.mocked(db.executeBatch).mockImplementationOnce(async () => {
			state.clearForLogout()

			return { rowsAffected: 256 }
		})

		await state.applyHashBatch({ upserts })

		// Only the first chunk was written; the second chunk was refused by the mid-wave re-check.
		expect(vi.mocked(db.executeBatch)).toHaveBeenCalledTimes(1)
		expect((vi.mocked(db.executeBatch).mock.calls[0]?.[0] as unknown[]).length).toBe(256)
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

	it("issues NO kv command at all while locked (writes are pure no-ops)", async () => {
		const state = make()

		await state.loadHashes()
		await state.loadAborts()

		const db = await sqlite.openDb()

		state.clearForLogout()

		vi.mocked(sqlite.kvAsync.set).mockClear()
		vi.mocked(sqlite.kvAsync.remove).mockClear()
		vi.mocked(db.executeBatch).mockClear()

		await state.setHash("x", "v")
		await state.setAbort("x", 1)
		await state.deleteHash("x")
		await state.deleteAbort("x")
		await state.applyHashBatch({ upserts: [["y", "v"]], deletes: ["z"] })

		// Neither memory nor kv is touched — no set/remove/executeBatch command ever leaves the store.
		expect(state.getHashSync("x")).toBeUndefined()
		expect(state.getAbort("x")).toBeUndefined()
		expect(vi.mocked(sqlite.kvAsync.set)).not.toHaveBeenCalled()
		expect(vi.mocked(sqlite.kvAsync.remove)).not.toHaveBeenCalled()
		expect(vi.mocked(db.executeBatch)).not.toHaveBeenCalled()
	})

	it("zombie-load latch: a logout mid-scan keeps the store locked and drops the scanned rows", async () => {
		seedHash("zombie", "x")

		const state = make()

		// Hold the scan open so a logout can land while the load is in flight.
		let releaseScan!: () => void
		const scanGate = new Promise<void>(resolve => {
			releaseScan = resolve
		})

		vi.mocked(forEachKvRowByPrefix).mockImplementationOnce(async (_db, _prefix, onRow) => {
			await scanGate

			onRow(HASHES_PREFIX + "zombie", serialize("x"))

			return 1
		})

		const loadPromise = state.loadHashes()

		// Logout lands while the scan is held: latches `locked` and bumps the generation.
		state.clearForLogout()

		releaseScan()

		await loadPromise

		// The stale-generation load must neither unlatch the store nor commit its scanned rows.
		await state.setHash("after", "z")

		expect(state.getHashSync("after")).toBeUndefined()
		expect(state.getHashSync("zombie")).toBeUndefined()
		expect(state.hashKeys()).toEqual([])
	})

	it("un-latches only at the generation-checked commit, never at load entry", async () => {
		seedHash("fresh", "value")

		const state = make()

		// Start locked (post-logout).
		state.clearForLogout()

		// Hold the fresh load's scan so we can probe the store mid-load.
		let releaseScan!: () => void
		const scanGate = new Promise<void>(resolve => {
			releaseScan = resolve
		})

		vi.mocked(forEachKvRowByPrefix).mockImplementationOnce(async (_db, _prefix, onRow) => {
			await scanGate

			onRow(HASHES_PREFIX + "fresh", serialize("value"))

			return 1
		})

		const loadPromise = state.loadHashes()

		// Entry must NOT unlatch: a write while the scan is still in flight is still refused.
		await state.setHash("early", "nope")

		expect(state.getHashSync("early")).toBeUndefined()

		releaseScan()

		await loadPromise

		// Only the committed load unlatches — now writes reach memory + kv again.
		await state.setHash("late", "yes")

		expect(state.getHashSync("late")).toBe("yes")
		expect(kvStore.has(HASHES_PREFIX + "late")).toBe(true)
		// The scanned row committed to memory on the same generation-checked path.
		expect(state.getHashSync("fresh")).toBe("value")
	})
})

describe("getHashMany", () => {
	it("resolves many keys and strips the storage prefix", async () => {
		// The batched read exists because the delta gate consults the ledger for every asset whose
		// remote copy looks older — on a browsed library that is thousands of keys, and one serial
		// native round trip each is what it replaces. Getting the prefix strip wrong would return a
		// map nothing can look up, silently disabling the gate.
		const state = make()

		seedHash("asset-1", { md5: "a", verifiedModificationTime: 1 })
		seedHash("asset-2", { md5: "b", verifiedModificationTime: 2 })

		const found = await state.getHashMany(["asset-1", "asset-2"])

		expect(found.get("asset-1")).toMatchObject({ md5: "a" })
		expect(found.get("asset-2")).toMatchObject({ md5: "b" })
	})

	it("omits keys that have no entry rather than mapping them to null", async () => {
		// shieldCoversModification treats `undefined` as "not verified"; a null would have to be
		// special-cased at every call site to mean the same thing.
		const state = make()

		seedHash("asset-1", { md5: "a", verifiedModificationTime: 1 })

		const found = await state.getHashMany(["asset-1", "missing"])

		expect(found.has("missing")).toBe(false)
		expect(found.size).toBe(1)
	})

	it("returns an empty map for no keys without touching the database", async () => {
		const state = make()
		const found = await state.getHashMany([])

		expect(found.size).toBe(0)
		expect(vi.mocked(sqlite.kvAsync.getMany)).not.toHaveBeenCalled()
	})

	it("degrades to empty when the read fails, so a broken ledger costs a hash and never a backup", async () => {
		const state = make()

		vi.mocked(sqlite.kvAsync.getMany).mockRejectedValueOnce(new Error("io error"))

		await expect(state.getHashMany(["asset-1"])).resolves.toEqual(new Map())
	})

	it("answers from memory once the ledger is loaded, without a database read", async () => {
		// Foreground pages the whole index in, so the batch must not re-read what is already there.
		const state = make()

		seedHash("asset-1", { md5: "a", verifiedModificationTime: 1 })

		await state.loadHashes()

		vi.mocked(sqlite.kvAsync.getMany).mockClear()

		const found = await state.getHashMany(["asset-1"])

		expect(found.get("asset-1")).toMatchObject({ md5: "a" })
		expect(vi.mocked(sqlite.kvAsync.getMany)).not.toHaveBeenCalled()
	})
})

describe("destination pairing", () => {
	it("round-trips the recorded destination", async () => {
		const state = make()

		expect(await state.getSyncedDestination()).toBeNull()

		await state.setSyncedDestination("dir-a")

		expect(await state.getSyncedDestination()).toBe("dir-a")
	})

	it("propagates a read failure instead of reporting 'never recorded'", async () => {
		// The caller answers null by ADOPTING the current destination, so folding an error into null
		// would record the new destination against a shield built for the old one — and the mismatch
		// would then never be seen again. Rejecting lets the caller skip and retry next pass.
		const state = make()

		vi.mocked(sqlite.kvAsync.get).mockRejectedValueOnce(new Error("io error"))

		await expect(state.getSyncedDestination()).rejects.toThrow("io error")
	})

	it("refuses to record after logout, so no uuid leaks into the next account", async () => {
		const state = make()

		state.clearForLogout()

		await state.setSyncedDestination("dir-a")

		expect(kvStore.has("cameraUpload:destination")).toBe(false)
	})
})

describe("clearHashes", () => {
	it("removes the hash rows from the kv, not just from memory", async () => {
		// Memory-only would resurrect the whole shield on the next load — the new destination would
		// look fully backed up while being empty.
		const state = make()

		seedHash("asset-1", { md5: "a", verifiedModificationTime: 1 })

		await state.loadHashes()
		await state.clearHashes()

		expect(state.getHashSync("asset-1")).toBeUndefined()
		expect(kvStore.has(HASHES_PREFIX + "asset-1")).toBe(false)
	})

	it("leaves the abort ledger alone", async () => {
		// Abort counts mean "this asset never fits an OS background window", which stays true at a new
		// destination; clearing them would re-burn background budgets on assets that cannot finish.
		const state = make()

		seedAbort("asset-1", 3)

		await state.loadAborts()
		await state.clearHashes()

		expect(state.getAbort("asset-1")).toBe(3)
	})

	it("refuses after logout rather than writing into the next account's store", async () => {
		const state = make()

		seedHash("asset-1", { md5: "a", verifiedModificationTime: 1 })
		state.clearForLogout()

		await state.clearHashes()

		expect(kvStore.has(HASHES_PREFIX + "asset-1")).toBe(true)
	})

	it("discards a load that was already scanning when the wipe landed", async () => {
		// The load captures its generation BEFORE scanning; committing its pre-wipe rows afterwards
		// would resurrect the entire shield in memory over an emptied kv — every asset then reads as
		// backed up at a destination that has none of it.
		//
		// The scan is suspended mid-flight on purpose: the shared fake resolves synchronously, so
		// without this gate the load finishes before the clear and the race is never exercised.
		const state = make()

		seedHash("asset-1", { md5: "a", verifiedModificationTime: 1 })

		let release: () => void = () => {}
		const scanning = new Promise<void>(resolve => {
			release = resolve
		})

		vi.mocked(forEachKvRowByPrefix).mockImplementationOnce(
			async (_db: unknown, prefix: string, onRow: (key: string, value: string) => void) => {
				let total = 0

				// Rows are read FIRST, then the scan suspends — so the wipe lands between reading and
				// committing, which is the only ordering that exercises the guard. Suspending before
				// the read just scans an already-empty store and proves nothing.
				for (const [key, value] of kvStore) {
					if (key.startsWith(prefix)) {
						onRow(key, value)
						total++
					}
				}

				await scanning

				return total
			}
		)

		const loading = state.loadHashes()

		await state.clearHashes()

		release()

		await loading

		expect(state.getHashSync("asset-1")).toBeUndefined()
	})
})
