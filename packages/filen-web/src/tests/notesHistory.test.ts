import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteHistory, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { restoreNoteFromHistoryOp } = vi.hoisted(() => ({ restoreNoteFromHistoryOp: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { restoreNoteFromHistory: restoreNoteFromHistoryOp } }))

// The sync outbox singleton — mocked so the restore action's inflight-clear seam calls are observable,
// same boundary notesSocketHandlers.test.ts uses for reloadRemoteEdit. The store it reads
// (useNotesInflight) is NOT mocked.
const { dropEntry, clearRejections, flushToDisk } = vi.hoisted(() => ({
	dropEntry: vi.fn<(uuid: string) => void>(),
	clearRejections: vi.fn<(uuid: string) => void>(),
	flushToDisk: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true))
}))

vi.mock("@/features/notes/lib/sync", () => ({ sync: { dropEntry, clearRejections, flushToDisk } }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { NOTES_QUERY_KEY, notesQueryGet } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { restoreNoteFromHistory } from "@/features/notes/lib/history"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
	flushToDisk.mockResolvedValue(true)
})

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "note title",
		preview: "note preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function mockHistory(overrides: Partial<NoteHistory> = {}): NoteHistory {
	return {
		id: 1n,
		editedTimestamp: 0n,
		editorId: 1n,
		noteType: "text",
		...overrides
	}
}

describe("restoreNoteFromHistory", () => {
	it("returns an error outcome on SDK rejection, without touching the outbox seam or any cache", async () => {
		const note = mockNote()
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])
		restoreNoteFromHistoryOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await restoreNoteFromHistory(note, mockHistory())

		expect(outcome.status).toBe("error")
		expect(dropEntry).not.toHaveBeenCalled()
		expect(clearRejections).not.toHaveBeenCalled()
		expect(flushToDisk).not.toHaveBeenCalled()
		expect(notesQueryGet()).toEqual([note])
	})

	it("upserts the note, then clears the outbox seam in order: dropEntry, clearRejections, flushToDisk", async () => {
		const note = mockNote()
		const updated = mockNote({ editedTimestamp: 1n })
		restoreNoteFromHistoryOp.mockResolvedValueOnce(updated)

		const callOrder: string[] = []
		dropEntry.mockImplementation(() => {
			callOrder.push("dropEntry")
		})
		clearRejections.mockImplementation(() => {
			callOrder.push("clearRejections")
		})
		flushToDisk.mockImplementation(() => {
			callOrder.push("flushToDisk")
			return Promise.resolve(true)
		})

		const outcome = await restoreNoteFromHistory(note, mockHistory({ content: "restored" }))

		expect(outcome).toEqual({ status: "success", item: updated })
		expect(notesQueryGet()).toEqual([updated])
		expect(dropEntry).toHaveBeenCalledExactlyOnceWith(updated.uuid)
		expect(clearRejections).toHaveBeenCalledExactlyOnceWith(updated.uuid)
		expect(callOrder).toEqual(["dropEntry", "clearRejections", "flushToDisk"])
	})

	it("known content: paints it directly into the content cache (bumps dataUpdatedAt for the editor remount key)", async () => {
		const note = mockNote()
		restoreNoteFromHistoryOp.mockResolvedValueOnce(note)
		const contentKey = noteContentQueryKey(note.uuid)
		// An explicit, deliberately-stale updatedAt (unlike sync.ts's own post-push write, which
		// PRESERVES the previous timestamp to avoid an editor remount) — restore must NOT preserve it.
		const staleUpdatedAt = 111_111
		testQueryClient.setQueryData(contentKey, "stale pre-restore content", { updatedAt: staleUpdatedAt })

		await restoreNoteFromHistory(note, mockHistory({ content: "restored content" }))

		expect(testQueryClient.getQueryData(contentKey)).toBe("restored content")
		expect(testQueryClient.getQueryState<string>(contentKey)?.dataUpdatedAt).not.toBe(staleUpdatedAt)
	})

	it("unknown content: never writes the content cache, invalidates it instead so the re-enabled query reconciles", async () => {
		const note = mockNote()
		restoreNoteFromHistoryOp.mockResolvedValueOnce(note)
		const contentKey = noteContentQueryKey(note.uuid)
		testQueryClient.setQueryData(contentKey, "still here")
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")

		await restoreNoteFromHistory(note, mockHistory())

		expect(testQueryClient.getQueryData(contentKey)).toBe("still here")
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: contentKey })
	})

	it("logs a warning (but still succeeds) when the outbox flush fails", async () => {
		const note = mockNote()
		restoreNoteFromHistoryOp.mockResolvedValueOnce(note)
		flushToDisk.mockResolvedValueOnce(false)

		const outcome = await restoreNoteFromHistory(note, mockHistory())

		expect(outcome.status).toBe("success")
		expect(logWarn).toHaveBeenCalledOnce()
	})
})
