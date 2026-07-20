/**
 * HARDENING suite for src/lib/cache.ts — contract tripwires added ahead of the perf
 * campaign (2026-06-11), mirroring the offline/cameraUpload/sort lesson: perf rewrites
 * exploit whatever the suite under-specifies.
 *
 * What this file pins that cache.test.ts does not:
 *
 * 1. TRAILING-DEBOUNCE WINDOW EXTENSION — a write inside the pending window pushes the
 *    persist out to (last write + PERSIST_DEBOUNCE); nothing lands before that. A
 *    rewrite of the per-mutation debounce machinery (the timer-churn optimization) must
 *    reproduce the extension semantics, not just "fires eventually".
 * 2. POST-CLEAR SESSION RE-PERSISTS IDENTICAL CONTENT — after clear() (logout) and a
 *    fresh restore() (next session), setting the SAME content that was persisted before
 *    the wipe must land in the (now empty) kv again. A flush-time "unchanged value"
 *    write-skip keyed on stale fingerprints would silently drop it — data loss.
 * 3. REFETCH-SIM STATE EQUALITY — setting equal-content FRESH object instances (the
 *    every-refetch reality: the SDK returns new objects each listing) followed by a
 *    flush leaves the kv byte-equal to serializing the live map contents. This is the
 *    correctness oracle that stays true whether or not a write-skip optimization
 *    suppresses redundant INSERTs.
 * 4. FAILED-BATCH RETRY STILL LANDS UNCHANGED CONTENT — when the first batch fails
 *    (executeBatch rejects), a later flush must land the value even though its content
 *    never changed in between. A write-skip that records its fingerprint BEFORE the
 *    batch succeeds would skip the retry — data loss.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const { mockDb, open } = vi.hoisted(() => {
	const mockDb = {
		execute: vi.fn(async (_query: unknown, _params?: unknown) => ({ rows: [] as never[], insertId: undefined, rowsAffected: 0 })),
		executeRaw: vi.fn(async (_query: unknown, _params?: unknown) => ({ rawRows: [] as unknown[][], columnNames: [] as string[], rowsAffected: 0 })),
		executeBatch: vi.fn(async (_commands: unknown) => ({ rowsAffected: 0 })),
		prepareStatement: vi.fn(() => ({
			bind: vi.fn(),
			bindSync: vi.fn(),
			execute: vi.fn(async () => ({ rows: [], insertId: undefined, rowsAffected: 0 }))
		})),
		close: vi.fn()
	}

	return { mockDb, open: vi.fn(() => mockDb) }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: () => ({ remove: () => {} })
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
	normalizeFilePathForSdk: (path: string) => path
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		Dir: class {
			public readonly tag = "Dir"
			public readonly inner: [unknown]
			public constructor(dir: unknown) {
				this.inner = [dir]
			}
		}
	},
	AnyDirWithContext: {
		Normal: class {
			public readonly tag = "Normal"
			public readonly inner: [unknown]
			public constructor(dir: unknown) {
				this.inner = [dir]
			}
		}
	}
}))

import { Cache } from "@/lib/cache"
import { serialize } from "@/lib/serializer"

// In-memory kv emulation matching the real SQLite shapes cache.ts uses.
const kvStore = new Map<string, string>()

function installKv(): void {
	mockDb.executeRaw.mockImplementation(async (query: unknown, params?: unknown) => {
		const sql = query as string
		const args = (params ?? []) as string[]

		if (sql.startsWith("SELECT key, value FROM kv WHERE key >= ?")) {
			const gte = args[0] as string
			const lt = args[1] as string
			const rows: [string, string][] = []

			for (const [key, value] of kvStore) {
				if (key >= gte && key < lt) {
					rows.push([key, value])
				}
			}

			return { rawRows: rows, columnNames: [], rowsAffected: 0 }
		}

		return { rawRows: [], columnNames: [], rowsAffected: 0 }
	})

	mockDb.executeBatch.mockImplementation(async (commands: unknown) => {
		for (const [sql, params] of commands as [string, unknown[]][]) {
			if (sql.startsWith("INSERT OR REPLACE")) {
				kvStore.set(params[0] as string, params[1] as string)
			} else if (sql.startsWith("DELETE FROM kv WHERE") && sql.includes("LIKE")) {
				const prefix = (params[0] as string).slice(0, -1)

				for (const key of [...kvStore.keys()]) {
					if (key.startsWith(prefix)) {
						kvStore.delete(key)
					}
				}
			} else if (sql.startsWith("DELETE FROM kv WHERE")) {
				kvStore.delete(params[0] as string)
			}
		}

		return { rowsAffected: (commands as unknown[]).length }
	})

	mockDb.execute.mockImplementation(async (query: unknown, params?: unknown) => {
		const sql = query as string
		const args = (params ?? []) as string[]

		if (sql.startsWith("DELETE FROM kv WHERE") && sql.includes("LIKE")) {
			const prefix = (args[0] as string).slice(0, -1)

			for (const key of [...kvStore.keys()]) {
				if (key.startsWith(prefix)) {
					kvStore.delete(key)
				}
			}
		}

		return { rows: [], insertId: undefined, rowsAffected: 0 }
	})
}

async function flushTimers(maxTicks = 30): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	kvStore.clear()
	mockDb.executeBatch.mockClear()
	installKv()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("hardening — trailing-debounce window extension", () => {
	it("a write inside the pending window pushes the persist out; nothing lands before last-write+debounce", async () => {
		const cache = new Cache()

		await cache.restore()

		cache.cameraUploadHashes.set("uuid-1", "first")

		// 600ms in: still inside the 1000ms window — nothing persisted.
		await vi.advanceTimersByTimeAsync(600)
		await flushTimers()

		expect(mockDb.executeBatch).not.toHaveBeenCalled()

		// Second write extends the window to t=1600.
		cache.cameraUploadHashes.set("uuid-2", "second")

		// t=1200: 600ms past the FIRST write's deadline but only 600ms past the second
		// write — still nothing.
		await vi.advanceTimersByTimeAsync(600)
		await flushTimers()

		expect(mockDb.executeBatch).not.toHaveBeenCalled()

		// t=1700: past last-write+1000 — exactly one batch with both entries.
		await vi.advanceTimersByTimeAsync(500)
		await flushTimers()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
		expect(kvStore.size).toBe(2)
	})
})

describe("hardening — post-clear session re-persists identical content", () => {
	it("the same content persisted before logout lands again after clear() + restore()", async () => {
		const cache = new Cache()

		await cache.restore()

		cache.cameraUploadHashes.set("uuid-1", "Documents")

		await cache.flushNow()

		const persistedKey = [...kvStore.keys()].find(key => key.endsWith(":uuid-1")) as string

		expect(persistedKey).toBeDefined()

		// Logout wipe: in-memory cleared, kv rows removed, persistence locked.
		cache.clear()
		await flushTimers()

		kvStore.clear()

		// Next authenticated session.
		await cache.restore()

		expect(kvStore.size).toBe(0)

		// Identical content as before the wipe — MUST land in the now-empty kv. A
		// write-skip keyed on fingerprints that survive clear() would drop this.
		cache.cameraUploadHashes.set("uuid-1", "Documents")

		await cache.flushNow()

		expect(kvStore.get(persistedKey)).toBe(serialize("Documents"))
	})
})

describe("hardening — refetch-sim state equality oracle", () => {
	it("setting equal-content FRESH objects then flushing leaves kv byte-equal to the live map", async () => {
		const cache = new Cache()

		await cache.restore()

		const makeLayout = (index: number) => ({
			width: 100 + (index % 7),
			height: 200 + (index % 5)
		})

		for (let i = 0; i < 50; i++) {
			cache.chatAttachmentLayouts.set(`uuid-${i}`, makeLayout(i))
		}

		await cache.flushNow()

		// Refetch reality: SAME content, FRESH object instances.
		for (let i = 0; i < 50; i++) {
			cache.chatAttachmentLayouts.set(`uuid-${i}`, makeLayout(i))
		}

		await cache.flushNow()

		// The kv must mirror the live map regardless of whether redundant INSERTs were
		// issued or skipped.
		for (let i = 0; i < 50; i++) {
			const key = [...kvStore.keys()].find(k => k.endsWith(`chatAttachmentLayouts:uuid-${i}`)) as string

			expect(key, `kv row uuid-${i}`).toBeDefined()
			expect(kvStore.get(key)).toBe(serialize(makeLayout(i)))
		}
	})
})

describe("hardening — failed batch retries unchanged content", () => {
	it("a value whose first batch failed lands on the next flush even though its content never changed", async () => {
		const cache = new Cache()

		await cache.restore()

		cache.cameraUploadHashes.set("uuid-1", "Documents")

		// First flush fails at the executeBatch boundary.
		mockDb.executeBatch.mockImplementationOnce(async () => {
			throw new Error("disk I/O error")
		})

		await cache.flushNow()

		expect(kvStore.size).toBe(0)

		// Retry with UNCHANGED content — must land. A write-skip recording its
		// fingerprint before the batch succeeded would skip this retry.
		await cache.flushNow()

		const key = [...kvStore.keys()].find(k => k.endsWith(":uuid-1")) as string

		expect(key).toBeDefined()
		expect(kvStore.get(key)).toBe(serialize("Documents"))
	})
})
