import { vi, describe, it, expect, beforeEach } from "vitest"
import { type Note } from "@/types"

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockCacheSet, mockQueryUpdaterSet } = vi.hoisted(() => ({
	mockCacheSet: vi.fn(),
	// Mirror queryUpdater.set closely enough for the test: invoke the passed updater with no prior
	// data so the side-effecting cache seed inside notesQueryUpdate actually runs, and expose its
	// return value (the list the real updater would persist) via the mock result.
	mockQueryUpdaterSet: vi.fn((_key: unknown, updater: unknown) =>
		typeof updater === "function" ? (updater as (prev: unknown) => unknown)(undefined) : updater
	)
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: { set: mockQueryUpdaterSet }
}))

vi.mock("@/lib/auth", () => ({ default: {} }))

vi.mock("@/lib/cache", () => ({
	default: {
		noteUuidToNote: { get: vi.fn(), set: mockCacheSet }
	}
}))

import { notesQueryUpdate } from "@/features/notes/queries/useNotesQuery"

const makeNote = (uuid: string): Note => ({ uuid, title: `note-${uuid}` }) as unknown as Note

// notesQueryUpdate is the optimistic path used by note create/rename/etc. cache.noteUuidToNote is
// otherwise seeded ONLY by the list query's fetchData, so an optimistically-added note would be
// missing from the cache — and useNoteContentQuery.fetchData resolves notes by uuid FROM that cache,
// returning undefined on a miss (which TanStack rejects, crashing the query on note open). These
// tests lock the invariant that notesQueryUpdate keeps cache.noteUuidToNote in sync.
describe("notesQueryUpdate cache sync", () => {
	beforeEach(() => {
		mockCacheSet.mockClear()
		mockQueryUpdaterSet.mockClear()
	})

	it("seeds cache.noteUuidToNote for every note in a direct-array update", () => {
		const a = makeNote("a")
		const b = makeNote("b")

		notesQueryUpdate({ updater: [a, b] })

		expect(mockCacheSet).toHaveBeenCalledWith("a", a)
		expect(mockCacheSet).toHaveBeenCalledWith("b", b)
	})

	it("seeds cache.noteUuidToNote for a note added by a function updater (the create → navigate path)", () => {
		const created = makeNote("new")

		notesQueryUpdate({ updater: prev => [...prev, created] })

		expect(mockCacheSet).toHaveBeenCalledWith("new", created)
	})

	it("returns the resulting list unchanged", () => {
		const a = makeNote("a")

		notesQueryUpdate({ updater: [a] })

		expect(mockQueryUpdaterSet).toHaveBeenCalledTimes(1)
		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([a])
	})
})
