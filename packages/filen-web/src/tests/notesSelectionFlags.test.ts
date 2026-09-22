import { describe, expect, it } from "vitest"
import type { Note, NoteParticipant, UuidStr } from "@filen/sdk-rs"

import { aggregateNoteSelectionFlags } from "@filen/shared"
import { selectableNotesForSelectAll } from "@/features/notes/lib/selectionFlags"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import { deriveEditorReadOnly } from "@/features/notes/hooks/useNoteEditor.logic"

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

describe("write-access SSOT", () => {
	it("hasWriteAccessToAll and deriveEditorReadOnly agree on the same note/user pair", () => {
		const readable = mockNote({ ownerId: 2n, participants: [participant({ userId: OWNER, permissionsWrite: false })] })
		const writable = mockNote({ ownerId: 2n, participants: [participant({ userId: OWNER, permissionsWrite: true })] })

		expect(aggregateNoteSelectionFlags([readable], OWNER, isNoteUndecryptable).hasWriteAccessToAll).toBe(false)
		expect(deriveEditorReadOnly(readable, OWNER)).toBe(true)

		expect(aggregateNoteSelectionFlags([writable], OWNER, isNoteUndecryptable).hasWriteAccessToAll).toBe(true)
		expect(deriveEditorReadOnly(writable, OWNER)).toBe(false)
	})
})
