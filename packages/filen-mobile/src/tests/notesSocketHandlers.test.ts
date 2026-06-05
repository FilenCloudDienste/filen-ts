import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state — captured updater callback from the mocked query function
// ---------------------------------------------------------------------------

const { capturedUpdaters, mockNotesWithContentQueryUpdate, mockFetchData, mockNotesWithContentQueryGet } = vi.hoisted(() => {
	const capturedUpdaters: Array<(prev: unknown[]) => unknown[]> = []

	const mockNotesWithContentQueryUpdate = vi.fn(({ updater }: { updater: (prev: unknown[]) => unknown[] }) => {
		capturedUpdaters.push(updater)
	})

	return {
		capturedUpdaters,
		mockNotesWithContentQueryUpdate,
		mockFetchData: vi.fn().mockResolvedValue([]),
		mockNotesWithContentQueryGet: vi.fn().mockReturnValue([])
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
		emit: vi.fn(),
		subscribe: vi.fn()
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
// Helpers — build minimal socket-event shapes matching the handler's destructure:
//   const [eventInner] = event.inner
//   eventInner.inner.tag  → NoteEvent_Tags.*
//   const [inner] = eventInner.inner.inner
//   inner.note            → note uuid string
// ---------------------------------------------------------------------------

function makeArchivedEvent(noteUuid: string): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.Archived,
					inner: [{ note: noteUuid }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeRestoredEvent(noteUuid: string): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.Restored,
					inner: [{ note: noteUuid }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleNoteEvent — notes socket handler", () => {
	beforeEach(() => {
		capturedUpdaters.length = 0
		mockNotesWithContentQueryUpdate.mockClear()
		mockFetchData.mockClear()
		mockNotesWithContentQueryGet.mockClear()
	})

	describe("NoteEvent_Tags.Archived", () => {
		it("sets archive: true on the matching note", async () => {
			await handleNoteEvent({ event: makeArchivedEvent("uuid-1") })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]

			expect(updater).toBeDefined()

			const prev = [
				{ uuid: "uuid-1", archive: false, trash: false },
				{ uuid: "uuid-2", archive: false, trash: false }
			]
			const result = updater!(prev)

			expect(result[0]).toMatchObject({ uuid: "uuid-1", archive: true })
		})

		it("does NOT add a phantom 'archived' key", async () => {
			await handleNoteEvent({ event: makeArchivedEvent("uuid-1") })

			const updater = capturedUpdaters[0]!
			const result = updater([{ uuid: "uuid-1", archive: false, trash: false }]) as Array<Record<string, unknown>>

			expect("archived" in result[0]!).toBe(false)
		})

		it("leaves non-matching notes unchanged", async () => {
			await handleNoteEvent({ event: makeArchivedEvent("uuid-1") })

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", archive: false, trash: false },
				{ uuid: "uuid-other", archive: false, trash: false }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result[1]).toMatchObject({ uuid: "uuid-other", archive: false })
		})
	})

	describe("NoteEvent_Tags.Restored", () => {
		it("sets archive: false and trash: false on the matching note", async () => {
			await handleNoteEvent({ event: makeRestoredEvent("uuid-1") })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [{ uuid: "uuid-1", archive: true, trash: true }]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result[0]).toMatchObject({ uuid: "uuid-1", archive: false, trash: false })
		})

		it("does NOT add phantom 'archived' or 'trashed' keys", async () => {
			await handleNoteEvent({ event: makeRestoredEvent("uuid-1") })

			const updater = capturedUpdaters[0]!
			const result = updater([{ uuid: "uuid-1", archive: true, trash: true }]) as Array<Record<string, unknown>>

			expect("archived" in result[0]!).toBe(false)
			expect("trashed" in result[0]!).toBe(false)
		})

		it("leaves non-matching notes unchanged", async () => {
			await handleNoteEvent({ event: makeRestoredEvent("uuid-1") })

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", archive: true, trash: true },
				{ uuid: "uuid-other", archive: true, trash: false }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result[1]).toMatchObject({ uuid: "uuid-other", archive: true, trash: false })
		})
	})
})
