import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ---------------------------------------------------------------------------
// Hoisted state — captured updater callback from the mocked query function
// ---------------------------------------------------------------------------

const {
	capturedUpdaters,
	mockNotesWithContentQueryUpdate,
	mockFetchData,
	mockNotesWithContentQueryGet,
	mockEventsEmit,
	mockGetNotesListGeneration,
	mockCurrentUserId,
	mockRemoveQueryEverywhere,
	mockForget,
	mockRefreshAfterRemoteEdit
} = vi.hoisted(() => {
	const capturedUpdaters: Array<(prev: unknown[]) => unknown[]> = []

	const mockNotesWithContentQueryUpdate = vi.fn(({ updater }: { updater: (prev: unknown[]) => unknown[] }) => {
		capturedUpdaters.push(updater)
	})

	return {
		capturedUpdaters,
		mockNotesWithContentQueryUpdate,
		mockFetchData: vi.fn().mockResolvedValue([]),
		mockNotesWithContentQueryGet: vi.fn().mockReturnValue([]),
		mockEventsEmit: vi.fn(),
		// Stable by default: the New handler's stale-snapshot guard sees no mid-fetch writes.
		mockGetNotesListGeneration: vi.fn().mockReturnValue(0),
		// null = "unknown", which the handler must read as "came from elsewhere" — the safe direction.
		mockCurrentUserId: vi.fn((): bigint | null => null),
		mockRemoveQueryEverywhere: vi.fn(),
		mockForget: vi.fn(async () => undefined),
		mockRefreshAfterRemoteEdit: vi.fn(async () => undefined)
	}
})

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that pull in the modules
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// socketHandlers reads the local user id to tell our own edits apart from another device's;
// auth reaches expo-secure-store, so it is stubbed. null = "unknown", which the handler treats as
// "came from elsewhere" — the safe reading, and the one that exercises the refresh path.
vi.mock("@/lib/auth", () => ({
	default: {
		currentUserId: () => mockCurrentUserId()
	}
}))

// notesOffline reaches SQLite; stubbed wholesale so this suite stays free of native modules.
vi.mock("@/features/notes/notesOffline", () => ({
	default: {
		sync: vi.fn(async () => undefined),
		cancel: vi.fn(),
		mark: vi.fn(async () => undefined),
		unmark: vi.fn(async () => undefined),
		refreshAfterRemoteEdit: mockRefreshAfterRemoteEdit,
		forget: mockForget,
		clearForLogout: vi.fn()
	}
}))
// socketHandlers now reclaims a deleted note's cached body; both of these reach SQLite.
vi.mock("@/queries/client", () => ({
	removeQueryEverywhere: mockRemoveQueryEverywhere
}))

vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	noteContentQueryKey: ({ uuid }: { uuid: string }) => ["useNoteContentQuery", { uuid }]
}))

vi.mock("@/features/notes/queries/useNotesQuery", () => ({
	notesQueryUpdate: mockNotesWithContentQueryUpdate,
	fetchData: mockFetchData,
	notesQueryGet: mockNotesWithContentQueryGet,
	getNotesListGeneration: mockGetNotesListGeneration
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

import loggerMock from "@/tests/mocks/logger"
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
		mockRefreshAfterRemoteEdit.mockClear()
		mockRemoveQueryEverywhere.mockClear()
		mockForget.mockClear()
		mockForget.mockResolvedValue(undefined)
		mockRefreshAfterRemoteEdit.mockResolvedValue(undefined)
		mockCurrentUserId.mockReturnValue(null)
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

		it("retries the fetch once when an optimistic write lands mid-fetch (stale snapshot must not clobber it)", async () => {
			const staleSnapshot = [{ uuid: "stale" }]
			const freshSnapshot = [{ uuid: "fresh" }]

			// Two generation reads per attempt (before + after the fetch): attempt 1 sees a write
			// land mid-fetch (0 -> 1), attempt 2 is stable (1 -> 1).
			mockGetNotesListGeneration.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(1)
			mockFetchData.mockResolvedValueOnce(staleSnapshot).mockResolvedValueOnce(freshSnapshot)

			await handleNoteEvent({ event: makeNewEvent() })

			expect(mockFetchData).toHaveBeenCalledTimes(2)
			expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedUpdaters[0]!

			expect(updater([])).toEqual(freshSnapshot)
		})

		it("gives up after two stale attempts without clobbering (the next focus refetch reconciles)", async () => {
			// Every attempt sees a mid-fetch write: 0 -> 1, then 2 -> 3.
			mockGetNotesListGeneration.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3)
			mockFetchData.mockResolvedValue([{ uuid: "snapshot" }])

			await handleNoteEvent({ event: makeNewEvent() })

			expect(mockFetchData).toHaveBeenCalledTimes(2)
			expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()
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

		// The refresh exists so a body we now KNOW to be wrong isn't served offline. The exclusion for
		// the note the user is looking at lives inside notesOffline; here we pin that the handler asks
		// for it at all, and with the event's OWN edit stamp — the cached note still carries the
		// pre-edit one, and stamping the ledger with that would re-fetch the same body on every pass.
		it("refreshes the cached body, stamped with the event's edit timestamp rather than the cached note's", async () => {
			mockNotesWithContentQueryGet.mockReturnValueOnce([{ uuid: "uuid-1", title: "My Note", editedTimestamp: 10n }])

			await handleNoteEvent({
				event: makeContentEditedEvent("uuid-1", { editorId: 999n, editedTimestamp: 20n })
			})

			expect(mockRefreshAfterRemoteEdit).toHaveBeenCalledOnce()
			expect(mockRefreshAfterRemoteEdit).toHaveBeenCalledWith({
				note: expect.objectContaining({ uuid: "uuid-1", editedTimestamp: 20n })
			})
		})

		// `editorId` is a USER id, not a device id — so filtering on it would also suppress an edit
		// this account made on ANOTHER device, which is the most common way a marked note goes stale
		// and exactly what this refresh exists to catch. The redundant fetch when the event echoes our
		// own push is the deliberate price; commitContent no-ops an identical body.
		it("refreshes even when the edit came from this account, because that may be another device", async () => {
			mockCurrentUserId.mockReturnValue(999n)
			mockNotesWithContentQueryGet.mockReturnValueOnce([{ uuid: "uuid-1", title: "My Note", editedTimestamp: 10n }])

			await handleNoteEvent({
				event: makeContentEditedEvent("uuid-1", { editorId: 999n, editedTimestamp: 20n })
			})

			expect(mockRefreshAfterRemoteEdit).toHaveBeenCalledOnce()
			expect(mockEventsEmit).toHaveBeenCalledOnce()
		})

		// Asserts the SWALLOW, not just that the handler resolved: the refresh is fire-and-forget, so
		// the handler resolves either way and removing the .catch would only turn the rejection into an
		// unhandled one that this suite never sees.
		it("swallows a refresh rejection into a warning rather than an unhandled rejection", async () => {
			const unhandled: unknown[] = []
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason)
			}

			process.on("unhandledRejection", onUnhandled)

			try {
				mockRefreshAfterRemoteEdit.mockRejectedValueOnce(new Error("network"))
				mockNotesWithContentQueryGet.mockReturnValueOnce([{ uuid: "uuid-1", title: "My Note", editedTimestamp: 10n }])

				await expect(
					handleNoteEvent({ event: makeContentEditedEvent("uuid-1", { editorId: 999n, editedTimestamp: 20n }) })
				).resolves.toBeUndefined()

				// Let the rejection settle through the .catch.
				await new Promise(resolve => setTimeout(resolve, 0))

				expect(unhandled).toEqual([])
				expect(loggerMock.warn).toHaveBeenCalledWith(
					"notes",
					expect.stringContaining("refresh after remote content edit"),
					expect.objectContaining({ noteUuid: "uuid-1" })
				)
			} finally {
				process.off("unhandledRejection", onUnhandled)
			}
		})
	})

	describe("NoteEvent_Tags.Deleted reclaims the note's cached body", () => {
		// The account no longer has this note, so holding its decrypted body is retention of data that
		// is gone. Previously only MARKED notes converged, via the sync pass's prune — a note merely
		// opened once kept its plaintext body until logout or the cache TTL.
		it("evicts the cached body and drops the ledger row", async () => {
			await handleNoteEvent({ event: makeDeletedEvent("uuid-1") })

			expect(mockRemoveQueryEverywhere).toHaveBeenCalledWith(["useNoteContentQuery", { uuid: "uuid-1" }])
			expect(mockForget).toHaveBeenCalledWith({ uuid: "uuid-1" })
		})

		it("does not throw when dropping the ledger row fails", async () => {
			mockForget.mockRejectedValueOnce(new Error("kv"))

			await expect(handleNoteEvent({ event: makeDeletedEvent("uuid-1") })).resolves.toBeUndefined()
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
