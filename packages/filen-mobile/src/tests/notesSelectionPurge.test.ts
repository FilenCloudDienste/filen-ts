import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ---------------------------------------------------------------------------
// Hoisted state — captured updater callbacks and store mock
// ---------------------------------------------------------------------------

const {
	capturedQueryUpdaters,
	capturedStoreUpdaters,
	mockNotesWithContentQueryUpdate,
	mockSetSelectedNotes,
	mockGetState,
	mockFetchData,
	mockNotesWithContentQueryGet,
	mockEventsEmit
} = vi.hoisted(() => {
	const capturedQueryUpdaters: Array<(prev: unknown[]) => unknown[]> = []
	const capturedStoreUpdaters: Array<(prev: unknown[]) => unknown[]> = []

	const mockSetSelectedNotes = vi.fn((fn: (prev: unknown[]) => unknown[]) => {
		capturedStoreUpdaters.push(fn)
	})

	const mockGetState = vi.fn(() => ({
		setSelectedNotes: mockSetSelectedNotes
	}))

	const mockNotesWithContentQueryUpdate = vi.fn(({ updater }: { updater: (prev: unknown[]) => unknown[] }) => {
		capturedQueryUpdaters.push(updater)
	})

	return {
		capturedQueryUpdaters,
		capturedStoreUpdaters,
		mockNotesWithContentQueryUpdate,
		mockSetSelectedNotes,
		mockGetState,
		mockFetchData: vi.fn().mockResolvedValue([]),
		mockNotesWithContentQueryGet: vi.fn().mockReturnValue([]),
		mockEventsEmit: vi.fn()
	}
})

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that pull in the modules
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/features/notes/queries/useNotesWithContent.query", () => ({
	notesWithContentQueryUpdate: mockNotesWithContentQueryUpdate,
	fetchData: mockFetchData,
	notesWithContentQueryGet: mockNotesWithContentQueryGet
}))

vi.mock("@/lib/events", () => ({
	default: {
		emit: mockEventsEmit,
		subscribe: vi.fn()
	}
}))

vi.mock("@/features/notes/store/useNotes.store", () => ({
	default: {
		getState: mockGetState
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	NoteEvent_Tags: {
		Archived: "Archived",
		Deleted: "Deleted",
		Restored: "Restored",
		TitleEdited: "TitleEdited",
		ParticipantNew: "ParticipantNew",
		ParticipantRemoved: "ParticipantRemoved",
		ParticipantPermissions: "ParticipantPermissions",
		New: "New",
		ContentEdited: "ContentEdited"
	},
	MaybeEncryptedUniffi_Tags: {
		Decrypted: "Decrypted",
		Encrypted: "Encrypted"
	},
	SocketEvent_Tags: {
		Note: "Note",
		Drive: "Drive"
	}
}))

// ---------------------------------------------------------------------------
// Import the unit under test AFTER all vi.mock declarations
// ---------------------------------------------------------------------------

import { handleNoteEvent, type NoteSocketEvent } from "@/features/notes/socketHandlers"
import { NoteEvent_Tags, SocketEvent_Tags } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeletedEvent(noteUuid: string): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.Deleted,
					inner: [{ note: noteUuid }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

// ---------------------------------------------------------------------------
// Tests — #42 selectedNotes purge on remote Deleted
// ---------------------------------------------------------------------------

describe("handleNoteEvent — #42 selectedNotes ghost purge on Deleted", () => {
	beforeEach(() => {
		capturedQueryUpdaters.length = 0
		capturedStoreUpdaters.length = 0
		mockNotesWithContentQueryUpdate.mockClear()
		mockSetSelectedNotes.mockClear()
		mockGetState.mockClear()
		mockFetchData.mockClear()
		mockNotesWithContentQueryGet.mockClear()
		mockEventsEmit.mockClear()
	})

	it("calls setSelectedNotes when a Deleted event arrives", async () => {
		await handleNoteEvent({ event: makeDeletedEvent("uuid-gone") })

		expect(mockSetSelectedNotes).toHaveBeenCalledOnce()
	})

	it("removes the deleted uuid from selectedNotes", async () => {
		await handleNoteEvent({ event: makeDeletedEvent("uuid-gone") })

		const storeUpdater = capturedStoreUpdaters[0]

		expect(storeUpdater).toBeDefined()

		const prev = [
			{ uuid: "uuid-gone", title: "Deleted remotely" },
			{ uuid: "uuid-keep", title: "Still here" }
		]
		const result = storeUpdater!(prev) as Array<{ uuid: string }>

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ uuid: "uuid-keep" })
	})

	it("leaves selectedNotes unchanged when the deleted uuid is not selected", async () => {
		await handleNoteEvent({ event: makeDeletedEvent("uuid-gone") })

		const storeUpdater = capturedStoreUpdaters[0]!
		const prev = [
			{ uuid: "uuid-a", title: "Note A" },
			{ uuid: "uuid-b", title: "Note B" }
		]
		const result = storeUpdater(prev) as Array<{ uuid: string }>

		expect(result).toHaveLength(2)
	})

	it("still updates the query cache (notesWithContentQueryUpdate called once)", async () => {
		await handleNoteEvent({ event: makeDeletedEvent("uuid-gone") })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

		const queryUpdater = capturedQueryUpdaters[0]!
		const prev = [{ uuid: "uuid-gone" }, { uuid: "uuid-keep" }]
		const result = queryUpdater(prev) as Array<{ uuid: string }>

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ uuid: "uuid-keep" })
	})

	it("select-all on the live set after a remote delete excludes the deleted note", async () => {
		// Simulate: notes list had 3 items, one is remotely deleted.
		// The reconciliation effect (index.tsx) prunes selectedNotes to the live uuid set.
		// Here we verify the STORE purge updater produces the correct subset when applied
		// to a selectedNotes that still contains the ghost.
		await handleNoteEvent({ event: makeDeletedEvent("uuid-x") })

		const storeUpdater = capturedStoreUpdaters[0]!

		// selectedNotes contains two items including the ghost
		const selectedNotes = [{ uuid: "uuid-x" }, { uuid: "uuid-y" }]
		const purged = storeUpdater(selectedNotes) as Array<{ uuid: string }>

		// After purge the ghost is gone: select-all count would be 1, not 2
		expect(purged).toHaveLength(1)
		expect(purged[0]).toMatchObject({ uuid: "uuid-y" })
	})
})
