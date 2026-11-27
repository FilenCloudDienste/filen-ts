import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { StorageApi } from "@/workers/db.worker"
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "@/workers/noteIndex"

// The notes full-text index against the package's real sqlite build (in memory), FTS5 trigram tokenizer included:
// only the OPFS pool install is swapped out, so the SQL is what ships.

const mocks = vi.hoisted(() => ({
	expose: vi.fn(),
	db: null as { exec: (sql: string) => unknown; selectValue: (sql: string) => unknown } | null,
	wipeFiles: vi.fn<() => Promise<void>>(() => Promise.resolve())
}))

vi.mock("comlink", () => ({ expose: mocks.expose }))
vi.mock("@sqlite.org/sqlite-wasm", async importOriginal =>
	(await import("@/tests/support/dbWorkerSqlite")).memorySqliteModule(await importOriginal(), {
		onOpen: db => {
			mocks.db = db
		},
		wipeFiles: mocks.wipeFiles
	})
)

let api: StorageApi

const ACCOUNT = "account-a"

function row(uuid: string, edited: number, text: string) {
	return { uuid, edited: String(edited), text }
}

async function uuids(key: string): Promise<string[]> {
	return (await api.noteIndexSearch(ACCOUNT, key, 100)).map(([uuid]) => uuid)
}

beforeAll(async () => {
	vi.stubGlobal("navigator", {
		storage: { getDirectory: () => Promise.reject(new DOMException("missing", "NotFoundError")) }
	})
	await import("@/workers/db.worker")
	api = mocks.expose.mock.calls[0]?.[0] as StorageApi
	await api.open()
})

beforeEach(async () => {
	await api.noteIndexClear()
})

describe("note index", () => {
	it("stores rows with their edited stamp and matches every query part", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 10, "Quarterly onboarding metrics"), row("b", 20, "Groceries: milk, eggs")])

		expect((await api.noteIndexStamps(ACCOUNT)).sort()).toEqual([
			["a", "10"],
			["b", "20"]
		])
		expect(await uuids("onboard")).toEqual(["a"])
		expect(await uuids("milk eggs")).toEqual(["b"])
		expect(await uuids("milk onboarding")).toEqual([])
	})

	it("matches anywhere in a word, as the title search does", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "The quarterly REPORT is due"), row("b", 1, "nothing here")])

		expect(await uuids("port")).toEqual(["a"])
		expect(await uuids("arterl")).toEqual(["a"])
	})

	it("matches inside a run of CJK text", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "東京都庁舎の会議"), row("b", 1, "大阪")])

		expect(await uuids("京都庁")).toEqual(["a"])
		expect(await uuids("都庁")).toEqual(["a"])
		expect(await uuids("京")).toEqual(["a"])
	})

	it("answers one- and two-character queries, alone or beside a longer part", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 2, "Plan for Q3 launch"), row("b", 1, "q3 budget"), row("c", 3, "launch day")])

		expect((await uuids("q3")).sort()).toEqual(["a", "b"])
		expect(await uuids("q3 launch")).toEqual(["a"])
		expect(await uuids("x")).toEqual([])

		const [first] = await api.noteIndexSearch(ACCOUNT, "q3", 100)

		expect(first?.[0]).toBe("a")
		expect(first?.[1]).toContain(`${SNIPPET_OPEN}Q3${SNIPPET_CLOSE}`)
	})

	it("folds letter case and keeps diacritics, as the title search does", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "Die Übersicht"), row("b", 1, "Ubersicht"), row("c", 1, "ÜB")])

		expect(await uuids("übersicht")).toEqual(["a"])
		expect((await uuids("üb")).sort()).toEqual(["a", "c"])
	})

	it("ranks the denser match first and marks the hits in its snippet", async () => {
		await api.noteIndexPut(ACCOUNT, [
			row("sparse", 1, "a long note that mentions launch once among many other words about other things"),
			row("dense", 1, "launch launch launch")
		])

		const results = await api.noteIndexSearch(ACCOUNT, "launch", 100)

		expect(results.map(([uuid]) => uuid)).toEqual(["dense", "sparse"])
		expect(results[1]?.[1]).toContain(`${SNIPPET_OPEN}launch${SNIPPET_CLOSE}`)
	})

	it("replaces a row only with one at least as new", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 20, "newer text")])
		await api.noteIndexPut(ACCOUNT, [row("a", 10, "older text")])

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([["a", "20"]])
		expect(await uuids("older")).toEqual([])

		await api.noteIndexPut(ACCOUNT, [row("a", 30, "rewritten")])

		expect(await uuids("newer")).toEqual([])
		expect(await uuids("rewritten")).toEqual(["a"])
	})

	it("deletes rows and prunes rows of notes no longer listed, out of the full-text index too", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "shared word"), row("b", 1, "shared word"), row("c", 1, "shared word")])

		await api.noteIndexDelete(ACCOUNT, ["a"])
		await api.noteIndexPrune(ACCOUNT, ["b"])

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([["b", "1"]])
		expect(await uuids("shared")).toEqual(["b"])
	})

	it("drops another account's rows before serving this one", async () => {
		await api.noteIndexPut("account-b", [row("a", 1, "their secret")])

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([])
		expect(await uuids("secret")).toEqual([])
		expect(await api.noteIndexStamps("account-b")).toEqual([])
	})

	it("treats FTS5 syntax in a query as text", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, 'say "NEAR" or AND (x*)')])

		expect(await uuids('"near')).toEqual(["a"])
		expect(await uuids("and")).toEqual(["a"])
		expect(await uuids("(x*)")).toEqual(["a"])
		expect(await uuids('"')).toEqual(["a"])
	})

	it("drops the word-index tables of v1 and rebuilds on v2", async () => {
		await api.wipe()

		const db = mocks.db

		if (db === null) {
			throw new Error("no connection")
		}

		db.exec("CREATE TABLE note_search_v1 (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, edited TEXT NOT NULL, text TEXT NOT NULL)")
		db.exec("CREATE VIRTUAL TABLE note_search_fts_v1 USING fts5(text, content='note_search_v1', content_rowid='id')")
		db.exec("CREATE TABLE note_search_owner_v1 (account TEXT NOT NULL)")
		db.exec("INSERT INTO note_search_v1(uuid, edited, text) VALUES ('old', '1', 'old text')")

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([])
		expect(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name LIKE 'note_search%v1%'")).toBe(0)
	})

	it("is gone after the sign-out wipe and works again after it", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "before wipe")])

		await api.wipe()

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([])

		await api.noteIndexPut(ACCOUNT, [row("b", 1, "after wipe")])

		expect(await uuids("after")).toEqual(["b"])
	})
})
