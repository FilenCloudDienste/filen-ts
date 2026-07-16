import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state
// ---------------------------------------------------------------------------

const { mockDb, open } = vi.hoisted(() => {
	const mockDb = {
		execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeRaw: vi.fn().mockResolvedValue({ rawRows: [] as unknown[][], columnNames: [] as string[], rowsAffected: 0 }),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		prepareStatement: vi.fn(() => ({
			bind: vi.fn(),
			bindSync: vi.fn(),
			execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 })
		})),
		close: vi.fn()
	}

	return { mockDb, open: vi.fn(() => mockDb) }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: () => ({ remove: () => {} })
	},
	Platform: {
		OS: "ios",
		select: <T>(specifics: { ios?: T; default?: T }) => specifics["ios"] ?? specifics["default"]
	}
}))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix, KV_RESTORE_PAGE_SIZE } from "@/lib/kvScan"
import { isKvRangeScanQuery, kvRangeScanRows } from "@/tests/mocks/kvExecuteRaw"
import type { DB } from "@op-engineering/op-sqlite"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const kvStore = new Map<string, string>()

// Faithful stand-in for the kv table: ORDER BY key + LIMIT + keyset continuation.
function pagerDb(): { db: DB; queryCount: () => number } {
	let count = 0

	const db = {
		executeRaw: async (query: string, params?: unknown[]) => {
			count++

			if (isKvRangeScanQuery(query)) {
				return { rawRows: kvRangeScanRows(kvStore, query, params), columnNames: [], rowsAffected: 0 }
			}

			return { rawRows: [], columnNames: [], rowsAffected: 0 }
		}
	} as unknown as DB

	return { db, queryCount: () => count }
}

function seedRows(prefix: string, count: number): string[] {
	const keys: string[] = []

	for (let i = 0; i < count; i++) {
		const key = `${prefix}${String(i).padStart(6, "0")}`

		kvStore.set(key, `value-${i}`)
		keys.push(key)
	}

	return keys
}

beforeEach(() => {
	kvStore.clear()
})

// ---------------------------------------------------------------------------
// forEachKvRowByPrefix — keyset paging
// ---------------------------------------------------------------------------

describe("forEachKvRowByPrefix", () => {
	it("visits every row in the prefix range exactly once, in key order, across pages", async () => {
		const expected = seedRows("p:", 600)

		// Noise outside the prefix range on both sides must not be visited.
		kvStore.set("o:before", "noise")
		kvStore.set("q:after", "noise")

		const { db, queryCount } = pagerDb()
		const visited: [string, string][] = []

		const total = await forEachKvRowByPrefix(db, "p:", (key, value) => {
			visited.push([key, value])
		})

		expect(total).toBe(600)
		expect(visited.map(([key]) => key)).toEqual(expected)
		expect(new Set(visited.map(([key]) => key)).size).toBe(600)
		expect(visited[0]).toEqual(["p:000000", "value-0"])
		expect(visited[599]).toEqual(["p:000599", "value-599"])
		// 600 rows = 256 + 256 + 88 → three page queries.
		expect(queryCount()).toBe(Math.ceil(600 / KV_RESTORE_PAGE_SIZE))
	})

	it("ends cleanly on an exact page multiple without duplicating the boundary row", async () => {
		seedRows("p:", KV_RESTORE_PAGE_SIZE * 2)

		const { db, queryCount } = pagerDb()
		const visited: string[] = []

		const total = await forEachKvRowByPrefix(db, "p:", key => {
			visited.push(key)
		})

		expect(total).toBe(KV_RESTORE_PAGE_SIZE * 2)
		expect(new Set(visited).size).toBe(KV_RESTORE_PAGE_SIZE * 2)
		// Two full pages + one empty terminating query.
		expect(queryCount()).toBe(3)
	})

	it("returns zero for an empty range after a single query", async () => {
		kvStore.set("q:other", "noise")

		const { db, queryCount } = pagerDb()

		const total = await forEachKvRowByPrefix(db, "p:", () => {
			throw new Error("should not be called")
		})

		expect(total).toBe(0)
		expect(queryCount()).toBe(1)
	})

	it("propagates an onRow throw to the caller mid-iteration", async () => {
		seedRows("p:", 10)

		const { db } = pagerDb()
		const visited: string[] = []

		await expect(
			forEachKvRowByPrefix(db, "p:", key => {
				if (visited.length === 5) {
					throw new Error("corrupt row")
				}

				visited.push(key)
			})
		).rejects.toThrow("corrupt row")

		expect(visited.length).toBe(5)
	})
})

// ---------------------------------------------------------------------------
// kvStats — boot-time size diagnostics
// ---------------------------------------------------------------------------

describe("kvStats", () => {
	it("maps totals and the largest rows", async () => {
		mockDb.executeRaw.mockImplementation(async (query: string) => {
			if (query.startsWith("SELECT COUNT(*)")) {
				return { rawRows: [[3, 12345]], columnNames: [], rowsAffected: 0 }
			}

			if (query.startsWith("SELECT key, LENGTH")) {
				return {
					rawRows: [
						["reactQuery_v1:big", 9000],
						["cache:x", 200],
						["cache:y", 100]
					],
					columnNames: [],
					rowsAffected: 0
				}
			}

			return { rawRows: [], columnNames: [], rowsAffected: 0 }
		})

		const stats = await sqlite.kvStats()

		expect(stats).toEqual({
			rows: 3,
			totalBytes: 12345,
			largest: [
				{ key: "reactQuery_v1:big", bytes: 9000 },
				{ key: "cache:x", bytes: 200 },
				{ key: "cache:y", bytes: 100 }
			]
		})
	})

	it("returns zeros for an empty table", async () => {
		mockDb.executeRaw.mockResolvedValue({ rawRows: [], columnNames: [], rowsAffected: 0 })

		const stats = await sqlite.kvStats()

		expect(stats).toEqual({ rows: 0, totalBytes: 0, largest: [] })
	})
})
