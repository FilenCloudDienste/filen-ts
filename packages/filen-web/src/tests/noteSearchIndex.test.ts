import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Note } from "@filen/sdk-rs"
import type { StorageApi } from "@/workers/db.worker"
import { mockNote } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"

// The search index and a search session over the real db worker (sqlite in memory, FTS5 included). A "session"
// is a fresh NoteSearchIndex + NoteSearchSession over the same database: what a reload keeps.

const mocks = vi.hoisted(() => ({ expose: vi.fn() }))

vi.mock("comlink", () => ({ expose: mocks.expose }))
vi.mock("@sqlite.org/sqlite-wasm", async importOriginal =>
	(await import("@/tests/support/dbWorkerSqlite")).memorySqliteModule(await importOriginal(), {
		onOpen: () => undefined,
		wipeFiles: () => Promise.resolve()
	})
)
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/storage/adapter", () => ({
	storage: () => Promise.reject(new Error("unused")),
	isMissingStorageMethod: (e: unknown) => e instanceof Error && e.name === "TypeError"
}))

const { NoteSearchIndex, NoteSearchSession, noteSearchEmptyState } = await import("@/features/notes/lib/searchIndex")

let api: StorageApi
let account = "account-a"
const reads = vi.fn<(note: Note) => Promise<string | undefined>>()
const bodies = new Map<string, string>()

function newIndex(over: Partial<StorageApi> = {}) {
	return new NoteSearchIndex({
		api: () => Promise.resolve({ ...api, ...over }),
		account: () => Promise.resolve(account),
		readContent: reads
	})
}

function note(label: string, title: string, editedTimestamp = 1n): Note {
	return mockNote({ uuid: testUuid(label), title, preview: "", noteType: "text", editedTimestamp })
}

const NOTES = [note("a", "alpha"), note("b", "beta"), note("c", "gamma"), note("d", "launch plan")]

function setBodies(notes: readonly Note[]): void {
	for (const n of notes) {
		bodies.set(n.uuid, `${n.title ?? ""} body`)
	}
}

// Runs a search until it has nothing left to read and its query has answered.
async function searchOnce(index: InstanceType<typeof NoteSearchIndex>, notes: readonly Note[], key: string, online = true) {
	const session = new NoteSearchSession(index)

	session.update(notes, key, online)
	await vi.waitFor(
		() => {
			expect(session.getState().pending).toBe(0)
		},
		{ interval: 1, timeout: 5000 }
	)

	const state = session.getState()

	session.stop()

	return state
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
	account = "account-a"
	bodies.clear()
	setBodies(NOTES)
	reads.mockReset()
	reads.mockImplementation(n => Promise.resolve(bodies.get(n.uuid)))
})

describe("note search request counts", () => {
	it("reads every title miss in the first session and none in the next one over unchanged notes", async () => {
		const first = await searchOnce(newIndex(), NOTES, "body")

		expect(reads).toHaveBeenCalledTimes(NOTES.length)
		expect([...first.hits.body.keys()].sort()).toEqual(NOTES.map(n => n.uuid).sort())

		reads.mockClear()

		const second = await searchOnce(newIndex(), NOTES, "body")

		expect(reads).not.toHaveBeenCalled()
		expect([...second.hits.body.keys()].sort()).toEqual(NOTES.map(n => n.uuid).sort())
		expect(noteSearchEmptyState(second)).toBe("empty")
	})

	it("reads only the notes edited since they were indexed", async () => {
		await searchOnce(newIndex(), NOTES, "body")
		reads.mockClear()

		const edited = NOTES.map(n => (n.uuid === testUuid("b") ? { ...n, editedTimestamp: 5n } : n))

		bodies.set(testUuid("b"), "rewritten zebra")

		const state = await searchOnce(newIndex(), edited, "zebra")

		expect(reads.mock.calls.map(([n]) => n.uuid)).toEqual([testUuid("b")])
		expect([...state.hits.body.keys()]).toEqual([testUuid("b")])
	})

	it("never reads a note whose title already matches", async () => {
		await searchOnce(newIndex(), NOTES, "alpha")

		expect(reads.mock.calls.map(([n]) => n.uuid).sort()).toEqual(
			NOTES.filter(n => n.title !== "alpha")
				.map(n => n.uuid)
				.sort()
		)
	})

	it("reads nothing for a blank search", async () => {
		const session = new NoteSearchSession(newIndex())

		session.update(NOTES, "", true)
		await new Promise(resolve => setTimeout(resolve, 10))

		expect(reads).not.toHaveBeenCalled()
		expect(session.getState().pending).toBe(0)
	})

	it("needs no read for text recorded from the editor, the outbox or a socket edit", async () => {
		const index = newIndex()

		for (const n of NOTES) {
			index.record(n, bodies.get(n.uuid) ?? "")
		}

		await vi.waitFor(async () => {
			expect(await api.noteIndexStamps(account)).toHaveLength(NOTES.length)
		})

		await searchOnce(newIndex(), NOTES, "body")

		expect(reads).not.toHaveBeenCalled()
	})

	it("counts stale bodies as unsearched while offline, without reading them", async () => {
		const state = await searchOnce(newIndex(), NOTES, "body", false)

		expect(reads).not.toHaveBeenCalled()
		expect(state.failed).toBe(NOTES.length)
		expect(noteSearchEmptyState(state)).toBe("unsearched")
	})

	it("counts a failed or undecryptable read as unsearched, and keeps the preview fallback for it", async () => {
		reads.mockImplementation(n =>
			n.uuid === testUuid("a")
				? Promise.reject(new Error("network"))
				: n.uuid === testUuid("b")
					? Promise.resolve(undefined)
					: Promise.resolve("x")
		)

		const state = await searchOnce(newIndex(), NOTES, "body")

		expect(state.failed).toBe(2)
		expect(state.hits.indexed.has(testUuid("a"))).toBe(false)
		expect(state.hits.indexed.has(testUuid("c"))).toBe(true)
	})
})

describe("note search results", () => {
	it("ranks the better match first and returns a snippet around the hit", async () => {
		bodies.set(testUuid("a"), "launch launch launch")
		bodies.set(testUuid("b"), "one launch among many other words in this longer body of text")

		const state = await searchOnce(newIndex(), NOTES, "launch")

		expect(state.hits.body.get(testUuid("a"))?.rank).toBe(0)
		expect(state.hits.body.get(testUuid("b"))?.rank).toBe(1)
		expect(state.hits.body.get(testUuid("b"))?.snippet).toContain("launch")
	})
})

describe("note search index upkeep", () => {
	it("drops a removed note's text", async () => {
		const index = newIndex()

		await searchOnce(index, NOTES, "body")
		index.remove([testUuid("a")])

		await vi.waitFor(async () => {
			expect((await api.noteIndexStamps(account)).map(([uuid]) => uuid)).not.toContain(testUuid("a"))
		})
	})

	it("prunes notes no longer listed when a search starts", async () => {
		await searchOnce(newIndex(), NOTES, "body")
		await searchOnce(newIndex(), NOTES.slice(1), "body")

		expect((await api.noteIndexStamps(account)).map(([uuid]) => uuid)).not.toContain(testUuid("a"))
	})

	it("serves nothing of another account's text", async () => {
		await searchOnce(newIndex(), NOTES, "body")
		account = "account-b"
		reads.mockClear()

		await searchOnce(newIndex(), NOTES, "body")

		expect(reads).toHaveBeenCalledTimes(NOTES.length)
	})

	it("writes nothing once closed for sign-out", async () => {
		const index = newIndex()

		index.close()
		index.record(NOTES[0] ?? note("x", "x"), "late write")
		await new Promise(resolve => setTimeout(resolve, 10))

		expect(await api.noteIndexStamps(account)).toEqual([])
	})

	it("falls back to unsearched bodies when the leader has no index", async () => {
		const missing = (): Promise<never> => Promise.reject(new TypeError("no such method"))
		const state = await searchOnce(newIndex({ noteIndexStamps: missing }), NOTES, "body")

		expect(reads).not.toHaveBeenCalled()
		expect(state.failed).toBe(NOTES.length)
	})
})
