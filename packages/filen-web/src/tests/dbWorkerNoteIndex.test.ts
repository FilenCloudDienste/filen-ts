import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { StorageApi } from "@/workers/db.worker"
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "@/workers/noteIndex"
import { buildNoteMatchQuery } from "@/features/notes/lib/searchIndex.logic"

// The notes full-text index against the package's real sqlite build (in memory), FTS5 included: only the OPFS pool
// install is swapped out, so the SQL is what ships.

const mocks = vi.hoisted(() => ({
	expose: vi.fn(),
	wipeFiles: vi.fn<() => Promise<void>>(() => Promise.resolve())
}))

vi.mock("comlink", () => ({ expose: mocks.expose }))
vi.mock("@sqlite.org/sqlite-wasm", async importOriginal =>
	(await import("@/tests/support/dbWorkerSqlite")).memorySqliteModule(await importOriginal(), {
		onOpen: () => undefined,
		wipeFiles: mocks.wipeFiles
	})
)

let api: StorageApi

const ACCOUNT = "account-a"

function row(uuid: string, edited: number, text: string) {
	return { uuid, edited: String(edited), text }
}

function search(key: string, account = ACCOUNT): Promise<[string, string][]> {
	const match = buildNoteMatchQuery(key)

	if (match === null) {
		throw new Error("no query")
	}

	return api.noteIndexSearch(account, match, 100)
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
	it("stores rows with their edited stamp and matches word prefixes", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 10, "Quarterly onboarding metrics"), row("b", 20, "Groceries: milk, eggs")])

		expect((await api.noteIndexStamps(ACCOUNT)).sort()).toEqual([
			["a", "10"],
			["b", "20"]
		])
		expect((await search("onboard")).map(([uuid]) => uuid)).toEqual(["a"])
		expect((await search("milk eggs")).map(([uuid]) => uuid)).toEqual(["b"])
		expect(await search("milk onboarding")).toEqual([])
	})

	it("folds letter case and keeps diacritics, as the title search does", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "Die Übersicht"), row("b", 1, "Ubersicht")])

		expect((await search("übersicht")).map(([uuid]) => uuid)).toEqual(["a"])
	})

	it("ranks the denser match first and marks the hits in its snippet", async () => {
		await api.noteIndexPut(ACCOUNT, [
			row("sparse", 1, "a long note that mentions launch once among many other words about other things"),
			row("dense", 1, "launch launch launch")
		])

		const results = await search("launch")

		expect(results.map(([uuid]) => uuid)).toEqual(["dense", "sparse"])
		expect(results[1]?.[1]).toContain(`${SNIPPET_OPEN}launch${SNIPPET_CLOSE}`)
	})

	it("replaces a row only with one at least as new", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 20, "newer text")])
		await api.noteIndexPut(ACCOUNT, [row("a", 10, "older text")])

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([["a", "20"]])
		expect(await search("older")).toEqual([])

		await api.noteIndexPut(ACCOUNT, [row("a", 30, "rewritten")])

		expect(await search("newer")).toEqual([])
		expect((await search("rewritten")).map(([uuid]) => uuid)).toEqual(["a"])
	})

	it("deletes rows and prunes rows of notes no longer listed, out of the full-text index too", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "shared word"), row("b", 1, "shared word"), row("c", 1, "shared word")])

		await api.noteIndexDelete(ACCOUNT, ["a"])
		await api.noteIndexPrune(ACCOUNT, ["b"])

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([["b", "1"]])
		expect((await search("shared")).map(([uuid]) => uuid)).toEqual(["b"])
	})

	it("drops another account's rows before serving this one", async () => {
		await api.noteIndexPut("account-b", [row("a", 1, "their secret")])

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([])
		expect(await search("secret")).toEqual([])
		expect(await api.noteIndexStamps("account-b")).toEqual([])
	})

	it("treats FTS5 syntax in a query as text", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, 'say "NEAR" or AND')])

		expect((await search('"near')).map(([uuid]) => uuid)).toEqual(["a"])
		expect((await search("and")).map(([uuid]) => uuid)).toEqual(["a"])
		expect(buildNoteMatchQuery("- ,")).toBeNull()
	})

	it("is gone after the sign-out wipe and works again after it", async () => {
		await api.noteIndexPut(ACCOUNT, [row("a", 1, "before wipe")])

		await api.wipe()

		expect(await api.noteIndexStamps(ACCOUNT)).toEqual([])

		await api.noteIndexPut(ACCOUNT, [row("b", 1, "after wipe")])

		expect((await search("after")).map(([uuid]) => uuid)).toEqual(["b"])
	})
})
