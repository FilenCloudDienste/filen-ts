import { vi, describe, it, expect, beforeEach } from "vitest"
import { type Note } from "@/types"

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockQueryUpdaterSet } = vi.hoisted(() => ({
	// Mirror queryUpdater.set closely enough for the test: invoke the passed updater with no prior
	// data and expose its return value (the list the real updater would persist) via the mock result.
	mockQueryUpdaterSet: vi.fn((_key: unknown, updater: unknown) =>
		typeof updater === "function" ? (updater as (prev: unknown) => unknown)(undefined) : updater
	)
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: { set: mockQueryUpdaterSet }
}))

vi.mock("@/lib/auth", () => ({ default: {} }))

import { notesQueryUpdate } from "@/features/notes/queries/useNotesQuery"

const makeNote = (uuid: string): Note => ({ uuid, title: `note-${uuid}` }) as unknown as Note

// notesQueryUpdate is the optimistic path used by note create/rename/etc. It commits the computed
// list to the single notes-list query verbatim — that query is the sole substrate the note-content
// and note-history queries resolve a note against before they run.
describe("notesQueryUpdate", () => {
	beforeEach(() => {
		mockQueryUpdaterSet.mockClear()
	})

	it("returns the resulting list unchanged", () => {
		const a = makeNote("a")

		notesQueryUpdate({ updater: [a] })

		expect(mockQueryUpdaterSet).toHaveBeenCalledTimes(1)
		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([a])
	})
})
