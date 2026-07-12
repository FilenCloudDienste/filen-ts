import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteParticipant, UuidStr } from "@filen/sdk-rs"

// selectionFlags.ts imports isNoteOwner from lib/actions.ts, which in turn imports the sdk client
// and query client modules — unresolvable/unwanted under node vitest, mirrors noteMenu.test.ts's own
// mock boundary.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { aggregateNoteSelectionFlags, selectableNotesForSelectAll } from "@/features/notes/lib/selectionFlags"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function participant(overrides: Partial<NoteParticipant> = {}): NoteParticipant {
	return {
		userId: 1n,
		isOwner: false,
		email: "participant@example.com",
		nickName: "participant",
		permissionsWrite: false,
		addedTimestamp: 1_700_000_000_000n,
		...overrides
	}
}

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "key",
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: [],
		...overrides
	}
}

// The SDK leaves encryptionKey absent (never `= undefined`) on an undecryptable note —
// exactOptionalPropertyTypes models that as a missing property, so this deletes rather than assigns
// undefined, mirroring noteMenu.test.ts's own undecryptableNote() convention.
function undecryptableNote(overrides: Partial<Note> = {}): Note {
	const note: Note = { ...mockNote(overrides) }

	delete note.encryptionKey

	return note
}

const OWNER = 1n

describe("aggregateNoteSelectionFlags — empty/degenerate input", () => {
	it("returns the empty-flags shape for an empty selection", () => {
		expect(aggregateNoteSelectionFlags([], OWNER)).toMatchObject({ count: 0, everyOwned: false })
	})

	it("returns the empty-flags shape when currentUserId is unresolved", () => {
		expect(aggregateNoteSelectionFlags([mockNote()], undefined)).toMatchObject({ count: 0, everyOwned: false })
	})
})

describe("aggregateNoteSelectionFlags — includes* flags (any-of)", () => {
	it("includesFavorited/includesPinned/includesArchived/includesTrashed are true when ANY selected note has the flag", () => {
		const flags = aggregateNoteSelectionFlags(
			[mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b"), favorite: true, pinned: true, archive: true })],
			OWNER
		)

		expect(flags).toMatchObject({ includesFavorited: true, includesPinned: true, includesArchived: true })
	})

	it("includesUndecryptable is true when any selected note's metadata never decrypted", () => {
		const flags = aggregateNoteSelectionFlags([mockNote({ uuid: testUuid("a") }), undecryptableNote({ uuid: testUuid("b") })], OWNER)

		expect(flags.includesUndecryptable).toBe(true)
	})

	it("every include* flag is false when nothing in the selection has it", () => {
		const flags = aggregateNoteSelectionFlags([mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b") })], OWNER)

		expect(flags).toMatchObject({
			includesFavorited: false,
			includesPinned: false,
			includesArchived: false,
			includesTrashed: false,
			includesUndecryptable: false
		})
	})
})

describe("aggregateNoteSelectionFlags — everyOwned / hasWriteAccessToAll", () => {
	it("everyOwned is true only when the current user owns every selected note", () => {
		const allOwned = aggregateNoteSelectionFlags(
			[mockNote({ ownerId: OWNER, uuid: testUuid("a") }), mockNote({ ownerId: OWNER, uuid: testUuid("b") })],
			OWNER
		)
		const mixed = aggregateNoteSelectionFlags(
			[mockNote({ ownerId: OWNER, uuid: testUuid("a") }), mockNote({ ownerId: 2n, uuid: testUuid("b") })],
			OWNER
		)

		expect(allOwned.everyOwned).toBe(true)
		expect(mixed.everyOwned).toBe(false)
	})

	it("hasWriteAccessToAll is true for the owner regardless of a participants list", () => {
		const flags = aggregateNoteSelectionFlags([mockNote({ ownerId: OWNER, participants: [] })], OWNER)

		expect(flags.hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll is true for a write-permitted participant on every selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[mockNote({ ownerId: 2n, participants: [participant({ userId: OWNER, permissionsWrite: true })] })],
			OWNER
		)

		expect(flags.hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll is false when any selected note has the user as a read-only participant", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				mockNote({ ownerId: 2n, uuid: testUuid("a"), participants: [participant({ userId: OWNER, permissionsWrite: true })] }),
				mockNote({ ownerId: 2n, uuid: testUuid("b"), participants: [participant({ userId: OWNER, permissionsWrite: false })] })
			],
			OWNER
		)

		expect(flags.hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll is false when the current user isn't a participant on a selected note at all", () => {
		const flags = aggregateNoteSelectionFlags([mockNote({ ownerId: 2n, participants: [] })], OWNER)

		expect(flags.hasWriteAccessToAll).toBe(false)
	})
})

describe("aggregateNoteSelectionFlags — lifecycle gates (everyTrashed / everyArchivedOrTrashed)", () => {
	it("everyTrashed is true only when every selected note is trashed", () => {
		const allTrashed = aggregateNoteSelectionFlags(
			[mockNote({ uuid: testUuid("a"), trash: true }), mockNote({ uuid: testUuid("b"), trash: true })],
			OWNER
		)
		const mixed = aggregateNoteSelectionFlags(
			[mockNote({ uuid: testUuid("a"), trash: true }), mockNote({ uuid: testUuid("b"), trash: false })],
			OWNER
		)

		expect(allTrashed.everyTrashed).toBe(true)
		expect(mixed.everyTrashed).toBe(false)
	})

	it("everyArchivedOrTrashed is true when every note is archived, trashed, or both — false if any is active", () => {
		const nonActive = aggregateNoteSelectionFlags(
			[mockNote({ uuid: testUuid("a"), archive: true }), mockNote({ uuid: testUuid("b"), trash: true })],
			OWNER
		)
		const withActive = aggregateNoteSelectionFlags(
			[mockNote({ uuid: testUuid("a"), archive: true }), mockNote({ uuid: testUuid("b") })],
			OWNER
		)

		expect(nonActive.everyArchivedOrTrashed).toBe(true)
		expect(withActive.everyArchivedOrTrashed).toBe(false)
	})
})

describe("aggregateNoteSelectionFlags — participantOfEveryAndNotOwner (Leave gate)", () => {
	it("is true when the current user is a participant (not owner) on every selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				mockNote({ uuid: testUuid("a"), ownerId: 2n, participants: [participant({ userId: OWNER })] }),
				mockNote({ uuid: testUuid("b"), ownerId: 3n, participants: [participant({ userId: OWNER })] })
			],
			OWNER
		)

		expect(flags.participantOfEveryAndNotOwner).toBe(true)
	})

	it("is false when the current user owns any selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				mockNote({ uuid: testUuid("a"), ownerId: OWNER }),
				mockNote({ uuid: testUuid("b"), ownerId: 2n, participants: [participant({ userId: OWNER })] })
			],
			OWNER
		)

		expect(flags.participantOfEveryAndNotOwner).toBe(false)
	})

	it("is false when the current user isn't a participant on some selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				mockNote({ uuid: testUuid("a"), ownerId: 2n, participants: [participant({ userId: OWNER })] }),
				mockNote({ uuid: testUuid("b"), ownerId: 3n, participants: [] })
			],
			OWNER
		)

		expect(flags.participantOfEveryAndNotOwner).toBe(false)
	})
})

describe("selectableNotesForSelectAll", () => {
	it("excludes undecryptable notes", () => {
		const decryptable = mockNote({ uuid: testUuid("a") })
		const undecryptable = undecryptableNote({ uuid: testUuid("b") })

		expect(selectableNotesForSelectAll([decryptable, undecryptable])).toEqual([decryptable])
	})

	it("returns every note unchanged when none are undecryptable", () => {
		const notes = [mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b") })]

		expect(selectableNotesForSelectAll(notes)).toEqual(notes)
	})

	it("collapses a note that appears twice (once per expanded tag group in the tags view) to a single entry", () => {
		const note = mockNote({ uuid: testUuid("a") })
		const other = mockNote({ uuid: testUuid("b") })

		expect(selectableNotesForSelectAll([note, other, note])).toEqual([note, other])
	})
})
