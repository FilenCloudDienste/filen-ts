import { vi, describe, it, expect, beforeEach } from "vitest"

const store = new Map<string, string>()

const { mockDb, open } = vi.hoisted(() => {
	const stmtStore = new Map<string, string>()

	function createStmt(query: string) {
		let params: unknown[] = []

		return {
			bind: vi.fn(async (p: unknown[]) => {
				params = p
			}),
			bindSync: vi.fn((p: unknown[]) => {
				params = p
			}),
			execute: vi.fn(async () => {
				if (query.startsWith("SELECT value")) {
					const value = stmtStore.get(params[0] as string)

					return { rows: value !== undefined ? [{ value }] : [], insertId: undefined, rowsAffected: 0 }
				}

				if (query.startsWith("INSERT")) {
					stmtStore.set(params[0] as string, params[1] as string)

					return { rows: [], insertId: 1, rowsAffected: 1 }
				}

				if (query.startsWith("DELETE")) {
					stmtStore.delete(params[0] as string)

					return { rows: [], insertId: undefined, rowsAffected: 1 }
				}

				if (query.startsWith("SELECT EXISTS")) {
					return { rows: [{ found: stmtStore.has(params[0] as string) ? 1 : 0 }], insertId: undefined, rowsAffected: 0 }
				}

				return { rows: [], insertId: undefined, rowsAffected: 0 }
			}),
			_getStore: () => stmtStore
		}
	}

	const mockDb = {
		execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeSync: vi.fn().mockReturnValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeRaw: vi.fn().mockResolvedValue([]),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		prepareStatement: vi.fn((query: string) => createStmt(query)),
		close: vi.fn()
	}

	return { mockDb, open: vi.fn(() => mockDb) }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import { serialize } from "@/lib/serializer"

type Sqlite = any

async function createSqlite(): Promise<Sqlite> {
	const mod = await import("@/lib/sqlite")

	return new (mod.default.constructor as new () => Sqlite)()
}

describe("Sqlite", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
		store.clear()
		open.mockReturnValue(mockDb)
		mockDb.execute.mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 })
		mockDb.executeRaw.mockResolvedValue([])
		mockDb.executeBatch.mockResolvedValue({ rowsAffected: 0 })
	})

	describe("init", () => {
		it("calls open, runs INIT_QUERIES, and prepares statements", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()

			expect(open).toHaveBeenCalledTimes(1)
			expect(open).toHaveBeenCalledWith({
				name: "sqlite.db",
				location: expect.any(String)
			})

			const execArg = mockDb.execute.mock.calls[0]![0] as string

			expect(execArg).toContain("PRAGMA journal_mode = WAL")
			expect(execArg).toContain("CREATE TABLE IF NOT EXISTS kv")
			expect(execArg).toContain("PRAGMA optimize")
			expect(execArg).not.toContain("foreign_keys")

			expect(mockDb.prepareStatement).toHaveBeenCalledTimes(4)
		})

		it("is idempotent — calling init twice only opens db once", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()
			await sqlite.init()

			expect(open).toHaveBeenCalledTimes(1)
		})
	})

	describe("openDb", () => {
		it("returns db after init", async () => {
			const sqlite = await createSqlite()
			const db = await sqlite.openDb()

			expect(db).toBe(mockDb)
		})

		it("throws if db is null after init", async () => {
			const sqlite = await createSqlite()

			;(sqlite as any).initDone = true
			;(sqlite as any).db = null

			await expect(sqlite.openDb()).rejects.toThrow("SQLite database not initialized")
		})
	})

	describe("kvAsync.set", () => {
		it("uses prepared statement and returns insertId", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("test-key", "test-value")

			expect(result).toBe(1)
		})

		it("returns null for null value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", null)

			expect(result).toBeNull()
		})

		it("returns null for undefined value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", undefined)

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.get", () => {
		it("returns null for missing key", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("nonexistent")

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.keys", () => {
		it("uses executeRaw and returns array of keys", async () => {
			mockDb.executeRaw.mockResolvedValue([["alpha"], ["beta"], ["gamma"]])

			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual(["alpha", "beta", "gamma"])
			expect(mockDb.executeRaw).toHaveBeenCalledWith("SELECT key FROM kv")
		})

		it("returns empty array when no rows", async () => {
			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual([])
		})
	})

	describe("kvAsync.contains", () => {
		it("returns true when key exists", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("existing", "value")

			const result = await sqlite.kvAsync.contains("existing")

			expect(result).toBe(true)
		})

		it("returns false when key does not exist", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.contains("missing")

			expect(result).toBe(false)
		})
	})

	describe("kvAsync.remove", () => {
		it("uses prepared statement for removal", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("doomed-key", "value")
			await sqlite.kvAsync.remove("doomed-key")

			const result = await sqlite.kvAsync.contains("doomed-key")

			expect(result).toBe(false)
		})
	})

	describe("kvAsync.clear", () => {
		it("calls execute with DELETE (no WHERE)", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.clear()

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("kvAsync.keysByPrefix", () => {
		it("uses executeRaw with LIKE query", async () => {
			mockDb.executeRaw.mockResolvedValue([["cache:v1:map:a"], ["cache:v1:map:b"]])

			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keysByPrefix("cache:v1:map:")

			expect(keys).toEqual(["cache:v1:map:a", "cache:v1:map:b"])
			expect(mockDb.executeRaw).toHaveBeenCalledWith("SELECT key FROM kv WHERE key LIKE ?", ["cache:v1:map:%"])
		})
	})

	describe("kvAsync.getByPrefix", () => {
		it("uses executeRaw and returns map of entries", async () => {
			const serialized = serialize("value")

			mockDb.executeRaw.mockResolvedValue([["cache:v1:map:a", serialized]])

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.getByPrefix("cache:v1:map:")

			expect(result.get("cache:v1:map:a")).toBe("value")
		})
	})

	describe("clearAsync", () => {
		it("calls execute with DELETE FROM kv", async () => {
			const sqlite = await createSqlite()

			await sqlite.clearAsync()

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("round-trip via prepared statements", () => {
		it("set then get preserves the value through serializer", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("roundtrip", { numbers: [1, 2, 3], nested: { ok: true } })
			const result = await sqlite.kvAsync.get("roundtrip")

			expect(result).toEqual({ numbers: [1, 2, 3], nested: { ok: true } })
		})

		it("set then get preserves string values", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("greeting", "hello world")
			const result = await sqlite.kvAsync.get("greeting")

			expect(result).toBe("hello world")
		})
	})

	describe("removeByPrefix", () => {
		it("removes all entries matching prefix", async () => {
			const stmtStoreRef = mockDb.prepareStatement("SELECT value")._getStore() as Map<string, string>

			mockDb.execute.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.includes("LIKE") && params?.[0]) {
					const prefix = (params[0] as string).replace(/%$/, "")

					for (const key of [...stmtStoreRef.keys()]) {
						if (key.startsWith(prefix)) {
							stmtStoreRef.delete(key)
						}
					}
				}

				return { rows: [], insertId: undefined, rowsAffected: 1 }
			})

			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("prefix_a", "one")
			await sqlite.kvAsync.set("prefix_b", "two")
			await sqlite.kvAsync.set("other_c", "three")

			await sqlite.kvAsync.removeByPrefix("prefix_")

			expect(await sqlite.kvAsync.get("prefix_a")).toBeNull()
			expect(await sqlite.kvAsync.get("prefix_b")).toBeNull()
			expect(await sqlite.kvAsync.get("other_c")).toBe("three")
		})
	})

	describe("getByPrefix", () => {
		it("returns empty Map when no rows match", async () => {
			mockDb.executeRaw.mockResolvedValue([])

			const sqlite = await createSqlite()

			const result = await sqlite.kvAsync.getByPrefix("nonexistent_")

			expect(result).toBeInstanceOf(Map)
			expect(result.size).toBe(0)
		})

		it("returns matching entries as a Map", async () => {
			const stmtStoreRef = mockDb.prepareStatement("SELECT value")._getStore() as Map<string, string>

			mockDb.executeRaw.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.includes("LIKE") && params?.[0]) {
					const prefix = (params[0] as string).replace(/%$/, "")
					const results: [string, string][] = []

					for (const [key, value] of stmtStoreRef.entries()) {
						if (key.startsWith(prefix)) {
							results.push([key, value])
						}
					}

					return results
				}

				return []
			})

			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("data_x", { value: 1 })
			await sqlite.kvAsync.set("data_y", { value: 2 })
			await sqlite.kvAsync.set("other_z", { value: 3 })

			const result = await sqlite.kvAsync.getByPrefix("data_") as Map<string, { value: number }>

			expect(result.size).toBe(2)
			expect(result.get("data_x")).toEqual({ value: 1 })
			expect(result.get("data_y")).toEqual({ value: 2 })
		})
	})
})
