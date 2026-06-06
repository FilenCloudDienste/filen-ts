import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state — captured updater callback from the mocked query function
// ---------------------------------------------------------------------------

const { capturedUpdaters, mockNotesWithContentQueryUpdate, mockFetchData, mockNotesWithContentQueryGet, mockEventsEmit } = vi.hoisted(
	() => {
		const capturedUpdaters: Array<(prev: unknown[]) => unknown[]> = []

		const mockNotesWithContentQueryUpdate = vi.fn(({ updater }: { updater: (prev: unknown[]) => unknown[] }) => {
			capturedUpdaters.push(updater)
		})

		return {
			capturedUpdaters,
			mockNotesWithContentQueryUpdate,
			mockFetchData: vi.fn().mockResolvedValue([]),
			mockNotesWithContentQueryGet: vi.fn().mockReturnValue([]),
			mockEventsEmit: vi.fn()
		}
	}
)

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

function makeTitleEditedEvent(noteUuid: string, newTitle: { tag: string; inner: string[] }): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.TitleEdited,
					inner: [{ note: noteUuid, newTitle }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeParticipantNewEvent(noteUuid: string, participant: Record<string, unknown>): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.ParticipantNew,
					inner: [{ note: noteUuid, participant }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeParticipantRemovedEvent(noteUuid: string, userId: bigint): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.ParticipantRemoved,
					inner: [{ note: noteUuid, userId }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeParticipantPermissionsEvent(noteUuid: string, userId: bigint, permissionsWrite: boolean): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.ParticipantPermissions,
					inner: [{ note: noteUuid, userId, permissionsWrite }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeNewEvent(): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.New,
					inner: [{}]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeContentEditedEvent(noteUuid: string, contentEdited: Record<string, unknown>): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: NoteEvent_Tags.ContentEdited,
					inner: [{ note: noteUuid, ...contentEdited }]
				}
			}
		]
	} as unknown as NoteSocketEvent
}

function makeUnknownEvent(): NoteSocketEvent {
	return {
		tag: SocketEvent_Tags.Note,
		inner: [
			{
				inner: {
					tag: "UnknownEventTagThatDoesNotExist",
					inner: [{}]
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
		mockEventsEmit.mockClear()
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

		it("patches only archive: true and preserves the exact shape (no phantom keys)", async () => {
			await handleNoteEvent({ event: makeArchivedEvent("uuid-1") })

			const updater = capturedUpdaters[0]!
			const result = updater([{ uuid: "uuid-1", archive: false, trash: false }]) as Array<Record<string, unknown>>

			// The source field is `archive` (not `archived`); an exact-shape match both pins the
			// flipped value and proves no spurious/misspelled key was introduced.
			expect(result[0]).toEqual({ uuid: "uuid-1", archive: true, trash: false })
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

		it("clears both archive and trash and preserves the exact shape (no phantom keys)", async () => {
			await handleNoteEvent({ event: makeRestoredEvent("uuid-1") })

			const updater = capturedUpdaters[0]!
			const result = updater([{ uuid: "uuid-1", archive: true, trash: true }]) as Array<Record<string, unknown>>

			// Source fields are `archive`/`trash` (not `archived`/`trashed`); exact-shape match pins
			// both cleared values and proves no spurious/misspelled key was introduced.
			expect(result[0]).toEqual({ uuid: "uuid-1", archive: false, trash: false })
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

	// ---------------------------------------------------------------------------
	// #38 — NoteEvent_Tags.Deleted filter updater
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.Deleted", () => {
		it("removes the note with the matching uuid", async () => {
			await handleNoteEvent({ event: makeDeletedEvent("uuid-X") })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-X", title: "To be deleted" },
				{ uuid: "uuid-Y", title: "Keep me" }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({ uuid: "uuid-Y" })
		})

		it("preserves all notes when uuid does not match", async () => {
			await handleNoteEvent({ event: makeDeletedEvent("uuid-X") })

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-A", title: "Note A" },
				{ uuid: "uuid-B", title: "Note B" }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result).toHaveLength(2)
		})

		it("calls notesWithContentQueryUpdate exactly once", async () => {
			await handleNoteEvent({ event: makeDeletedEvent("uuid-X") })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()
		})
	})

	// ---------------------------------------------------------------------------
	// #39 — NoteEvent_Tags.TitleEdited (Decrypted + Encrypted skip branches)
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.TitleEdited", () => {
		it("Decrypted: updates the title of the matching note", async () => {
			const { MaybeEncryptedUniffi_Tags } = await import("@filen/sdk-rs")

			await handleNoteEvent({
				event: makeTitleEditedEvent("uuid-1", {
					tag: MaybeEncryptedUniffi_Tags.Decrypted,
					inner: ["New Name"]
				})
			})

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", title: "Old Name" },
				{ uuid: "uuid-2", title: "Other Note" }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result[0]).toMatchObject({ uuid: "uuid-1", title: "New Name" })
			expect(result[1]).toMatchObject({ uuid: "uuid-2", title: "Other Note" })
		})

		it("Decrypted: leaves non-matching notes unchanged", async () => {
			const { MaybeEncryptedUniffi_Tags } = await import("@filen/sdk-rs")

			await handleNoteEvent({
				event: makeTitleEditedEvent("uuid-1", {
					tag: MaybeEncryptedUniffi_Tags.Decrypted,
					inner: ["Updated"]
				})
			})

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", title: "Old" },
				{ uuid: "uuid-other", title: "Unchanged" }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result[1]).toMatchObject({ uuid: "uuid-other", title: "Unchanged" })
		})

		it("Encrypted: does NOT call notesWithContentQueryUpdate (skip path)", async () => {
			const { MaybeEncryptedUniffi_Tags } = await import("@filen/sdk-rs")

			await handleNoteEvent({
				event: makeTitleEditedEvent("uuid-1", {
					tag: MaybeEncryptedUniffi_Tags.Encrypted,
					inner: ["encryptedBlob"]
				})
			})

			expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// #40 — NoteEvent_Tags.ParticipantNew upsert updater
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.ParticipantNew", () => {
		it("appends a brand-new participant to the matching note", async () => {
			const newParticipant = { userId: 200n, permissionsWrite: false, email: "new@example.com" }
			await handleNoteEvent({ event: makeParticipantNewEvent("uuid-1", newParticipant) })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [{ userId: 100n, permissionsWrite: true, email: "existing@example.com" }]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants).toHaveLength(2)
			expect(participants[1]).toMatchObject({ userId: 200n, email: "new@example.com" })
		})

		it("replaces an existing participant with the same userId (upsert)", async () => {
			const updatedParticipant = { userId: 100n, permissionsWrite: true, email: "updated@example.com" }
			await handleNoteEvent({ event: makeParticipantNewEvent("uuid-1", updatedParticipant) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [{ userId: 100n, permissionsWrite: false, email: "old@example.com" }]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants).toHaveLength(1)
			expect(participants[0]).toMatchObject({ userId: 100n, email: "updated@example.com", permissionsWrite: true })
		})

		it("leaves notes with non-matching uuid unchanged", async () => {
			const participant = { userId: 100n, permissionsWrite: false }
			await handleNoteEvent({ event: makeParticipantNewEvent("uuid-1", participant) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", participants: [] },
				{ uuid: "uuid-other", participants: [{ userId: 999n }] }
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const otherParticipants = result[1]?.["participants"] as Array<Record<string, unknown>>

			expect(otherParticipants).toHaveLength(1)
			expect(otherParticipants[0]).toMatchObject({ userId: 999n })
		})
	})

	// ---------------------------------------------------------------------------
	// #41 — NoteEvent_Tags.ParticipantRemoved filter updater
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.ParticipantRemoved", () => {
		it("removes the participant with the matching userId", async () => {
			await handleNoteEvent({ event: makeParticipantRemovedEvent("uuid-1", 100n) })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [
						{ userId: 100n, email: "removed@example.com" },
						{ userId: 200n, email: "kept@example.com" }
					]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants).toHaveLength(1)
			expect(participants[0]).toMatchObject({ userId: 200n })
		})

		it("preserves participants with other userIds", async () => {
			await handleNoteEvent({ event: makeParticipantRemovedEvent("uuid-1", 100n) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [{ userId: 200n }, { userId: 300n }]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants).toHaveLength(2)
		})

		it("leaves notes with non-matching uuid unchanged", async () => {
			await handleNoteEvent({ event: makeParticipantRemovedEvent("uuid-1", 100n) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", participants: [{ userId: 100n }] },
				{ uuid: "uuid-other", participants: [{ userId: 100n }, { userId: 200n }] }
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const otherParticipants = result[1]?.["participants"] as Array<Record<string, unknown>>

			expect(otherParticipants).toHaveLength(2)
		})
	})

	// ---------------------------------------------------------------------------
	// #42 — NoteEvent_Tags.ParticipantPermissions permissionsWrite patch
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.ParticipantPermissions", () => {
		it("sets permissionsWrite=true for the matching userId", async () => {
			await handleNoteEvent({ event: makeParticipantPermissionsEvent("uuid-1", 100n, true) })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [{ userId: 100n, permissionsWrite: false }]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants[0]).toMatchObject({ userId: 100n, permissionsWrite: true })
		})

		it("sets permissionsWrite=false (write to read)", async () => {
			await handleNoteEvent({ event: makeParticipantPermissionsEvent("uuid-1", 100n, false) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [{ userId: 100n, permissionsWrite: true }]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants[0]).toMatchObject({ userId: 100n, permissionsWrite: false })
		})

		it("does not change permissionsWrite for non-matching participants", async () => {
			await handleNoteEvent({ event: makeParticipantPermissionsEvent("uuid-1", 100n, true) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{
					uuid: "uuid-1",
					participants: [
						{ userId: 100n, permissionsWrite: false },
						{ userId: 200n, permissionsWrite: false }
					]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<Record<string, unknown>>

			expect(participants[1]).toMatchObject({ userId: 200n, permissionsWrite: false })
		})

		it("leaves notes with non-matching uuid unchanged", async () => {
			await handleNoteEvent({ event: makeParticipantPermissionsEvent("uuid-1", 100n, true) })

			const updater = capturedUpdaters[0]!
			const prev = [
				{ uuid: "uuid-1", participants: [{ userId: 100n, permissionsWrite: false }] },
				{ uuid: "uuid-other", participants: [{ userId: 100n, permissionsWrite: false }] }
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const otherParticipants = result[1]?.["participants"] as Array<Record<string, unknown>>

			expect(otherParticipants[0]).toMatchObject({ userId: 100n, permissionsWrite: false })
		})
	})

	// ---------------------------------------------------------------------------
	// #44 — NoteEvent_Tags.New refetch-then-replace path
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.New", () => {
		it("calls notesWithContentQueryFetch once", async () => {
			const fetchedNotes = [{ uuid: "uuid-fetched", title: "Fetched" }]
			mockFetchData.mockResolvedValueOnce(fetchedNotes)

			await handleNoteEvent({ event: makeNewEvent() })

			expect(mockFetchData).toHaveBeenCalledOnce()
		})

		it("replaces the entire cache with the fetched result", async () => {
			const fetchedNotes = [{ uuid: "uuid-fetched", title: "Fetched" }]
			mockFetchData.mockResolvedValueOnce(fetchedNotes)

			await handleNoteEvent({ event: makeNewEvent() })

			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!
			const prev = [{ uuid: "uuid-old", title: "Stale" }]
			const result = updater(prev)

			expect(result).toEqual(fetchedNotes)
		})
	})

	// ---------------------------------------------------------------------------
	// #43 — NoteEvent_Tags.ContentEdited events.emit + not-found guard
	// ---------------------------------------------------------------------------

	describe("NoteEvent_Tags.ContentEdited", () => {
		it("emits 'noteContentEdited' when the note is found in the cache", async () => {
			const contentEditedPayload = { type: "md", chunkSize: 1024 }
			mockNotesWithContentQueryGet.mockReturnValueOnce([{ uuid: "uuid-1", title: "My Note" }])

			await handleNoteEvent({
				event: makeContentEditedEvent("uuid-1", contentEditedPayload)
			})

			expect(mockEventsEmit).toHaveBeenCalledOnce()
			expect(mockEventsEmit).toHaveBeenCalledWith("noteContentEdited", {
				noteUuid: "uuid-1",
				contentEdited: expect.objectContaining({ note: "uuid-1" })
			})
		})

		it("does NOT emit when the note is not found in the cache", async () => {
			mockNotesWithContentQueryGet.mockReturnValueOnce([])

			await handleNoteEvent({
				event: makeContentEditedEvent("uuid-missing", {})
			})

			expect(mockEventsEmit).not.toHaveBeenCalled()
		})

		it("does not throw when the note is not found", async () => {
			mockNotesWithContentQueryGet.mockReturnValueOnce([])

			await expect(handleNoteEvent({ event: makeContentEditedEvent("uuid-missing", {}) })).resolves.toBeUndefined()
		})
	})

	// ---------------------------------------------------------------------------
	// #45/#159 — default case throws 'Unhandled note event'
	// ---------------------------------------------------------------------------

	describe("default case — unhandled event tag", () => {
		it("throws 'Unhandled note event' for an unknown event tag", async () => {
			await expect(handleNoteEvent({ event: makeUnknownEvent() })).rejects.toThrow("Unhandled note event")
		})
	})
})
