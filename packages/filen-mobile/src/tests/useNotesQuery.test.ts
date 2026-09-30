import { vi, describe, it, expect, beforeEach } from "vitest"
import { type Note } from "@/types"

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockQueryUpdaterSet, cached } = vi.hoisted(() => {
	const cached: { value: unknown } = { value: undefined }

	return {
		cached,
		// Mirror queryUpdater.set closely enough for the test: invoke the passed updater with the
		// cached data and expose its return value (the list the real updater would persist) via the
		// mock result.
		mockQueryUpdaterSet: vi.fn((_key: unknown, updater: unknown) =>
			typeof updater === "function" ? (updater as (prev: unknown) => unknown)(cached.value) : updater
		)
	}
})

vi.mock("@/lib/signals", () => ({
	toSignalOpts: (signal?: AbortSignal) => (signal ? { signal } : undefined)
}))

vi.mock("@/queries/client", () => ({
	queryUpdater: { set: mockQueryUpdaterSet }
}))

vi.mock("@/lib/auth", () => ({ default: {} }))

// Real bindings need the native module; nothing here touches NoteType.
vi.mock("@filen/sdk-rs", () => ({}))

import { notesQueryUpdate, notesQueryReplace, notesQueryPatch, getNotesListGeneration } from "@/features/notes/queries/useNotesQuery"

const makeNote = (uuid: string): Note => ({ uuid, title: `note-${uuid}` }) as unknown as Note

// notesQueryUpdate is the optimistic path used by note create/rename/etc. It commits the computed
// list to the single notes-list query verbatim — that query is the sole substrate the note-content
// and note-history queries resolve a note against before they run.
describe("notesQueryUpdate", () => {
	beforeEach(() => {
		mockQueryUpdaterSet.mockClear()
		cached.value = undefined
	})

	it("returns the resulting list unchanged", () => {
		const a = makeNote("a")

		notesQueryUpdate({ updater: [a] })

		expect(mockQueryUpdaterSet).toHaveBeenCalledTimes(1)
		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([a])
	})
})

describe("notesQueryReplace / notesQueryPatch", () => {
	beforeEach(() => {
		mockQueryUpdaterSet.mockClear()
	})

	it("replaces only the note with the same uuid and bumps the generation", () => {
		const a = makeNote("a")
		const b = makeNote("b")
		const nextA = { ...a, title: "renamed" } as Note

		cached.value = [a, b]

		const before = getNotesListGeneration()

		notesQueryReplace(nextA)

		expect(getNotesListGeneration()).toBe(before + 1)
		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([nextA, b])
	})

	it("patches onto the live cache entry", () => {
		const a = makeNote("a")
		const b = makeNote("b")
		const liveA = { ...a, title: "live" } as Note

		cached.value = [liveA, b]

		const before = getNotesListGeneration()
		const patch = vi.fn((live: Note) => ({ pinned: live.title === "live" }))

		notesQueryPatch("a", patch)

		expect(getNotesListGeneration()).toBe(before + 1)
		expect(patch).toHaveBeenCalledTimes(1)
		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([{ ...liveA, pinned: true }, b])
	})
})
