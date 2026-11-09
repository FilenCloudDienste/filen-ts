import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { StorageApi } from "@/workers/db.worker"

// Prefix sizes and the vacuum against a real sqlite (the package's node build, in memory); only the OPFS pool install
// is swapped out.

const mocks = vi.hoisted(() => ({
	expose: vi.fn(),
	db: null as { selectValue: (sql: string) => unknown } | null
}))

vi.mock("comlink", () => ({ expose: mocks.expose }))
vi.mock("@sqlite.org/sqlite-wasm", async importOriginal => {
	const actual = await importOriginal<typeof import("@sqlite.org/sqlite-wasm")>()

	return {
		default: async () => {
			const sqlite3 = await actual.default()

			class MemoryDb extends sqlite3.oo1.DB {
				public constructor() {
					super(":memory:")
					mocks.db = this
				}
			}

			return { installOpfsSAHPoolVfs: () => Promise.resolve({ OpfsSAHPoolDb: MemoryDb, wipeFiles: () => Promise.resolve() }) }
		}
	}
})

let api: StorageApi

beforeAll(async () => {
	vi.stubGlobal("navigator", {
		storage: { getDirectory: () => Promise.reject(new DOMException("missing", "NotFoundError")) }
	})
	await import("@/workers/db.worker")
	api = mocks.expose.mock.calls[0]?.[0] as StorageApi
	await api.open()
})

beforeEach(async () => {
	await api.kvDeletePrefix("")
})

describe("db.worker kvPrefixBytes", () => {
	it("sums the UTF-8 bytes of keys and values per prefix, in the order asked", async () => {
		await api.kvSet("rq.a", "12345")
		await api.kvSet("rq.b", "ü")
		await api.kvSet("audio.v1.tags.x", "日本")
		await api.kvSet("audio.v1.prefs", "keep")

		// "rq.a"+"12345" = 9, "rq.b"+"ü" = 4+2; "audio.v1.tags.x"+"日本" = 15+6.
		expect(await api.kvPrefixBytes(["rq.", "audio.v1.tags.", "missing."])).toEqual([15, 21, 0])
	})

	it("matches a prefix literally, so LIKE wildcards in it count nothing extra", async () => {
		await api.kvSet("a_b", "1")
		await api.kvSet("axb", "1")

		expect(await api.kvPrefixBytes(["a_"])).toEqual([4])
	})
})

describe("db.worker vacuum", () => {
	it("leaves a database with little free space alone", async () => {
		await api.kvSet("k", "v")

		expect(await api.vacuum()).toBe(0)
		expect(mocks.db?.selectValue("PRAGMA auto_vacuum")).toBe(0)
	})

	it("rebuilds once into incremental mode after a large delete, then frees incrementally", async () => {
		const value = "x".repeat(4000)

		for (let index = 0; index < 600; index++) {
			await api.kvSet(`rq.${String(index)}`, value)
		}

		await api.kvDeletePrefix("rq.")

		expect(await api.vacuum()).toBeGreaterThan(1_048_576)
		expect(mocks.db?.selectValue("PRAGMA auto_vacuum")).toBe(2)
		expect(mocks.db?.selectValue("PRAGMA freelist_count")).toBe(0)

		for (let index = 0; index < 600; index++) {
			await api.kvSet(`rq.${String(index)}`, value)
		}

		await api.kvDeletePrefix("rq.")

		expect(await api.vacuum()).toBeGreaterThan(1_048_576)
		expect(mocks.db?.selectValue("PRAGMA freelist_count")).toBe(0)
		expect(await api.kvGet("rq.1")).toBeNull()
	})
})
