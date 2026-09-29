import { describe, expect, it } from "vitest"
import { aggregateNoteSelectionFlags } from "@filen/shared"
import { selectableNotesForSelectAll } from "@/features/notes/lib/selectionFlags"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import { deriveEditorReadOnly } from "@/features/notes/hooks/useNoteEditor.logic"
import { testUuid } from "@/tests/support/uuid"
import { mockNote, mockNoteParticipant, undecryptableNote } from "@/tests/fixtures/notes"

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
})

describe("write-access SSOT", () => {
	it("hasWriteAccessToAll and deriveEditorReadOnly agree on the same note/user pair", () => {
		const readable = mockNote({ ownerId: 2n, participants: [mockNoteParticipant({ userId: OWNER, permissionsWrite: false })] })
		const writable = mockNote({ ownerId: 2n, participants: [mockNoteParticipant({ userId: OWNER, permissionsWrite: true })] })

		expect(aggregateNoteSelectionFlags([readable], OWNER, isNoteUndecryptable).hasWriteAccessToAll).toBe(false)
		expect(deriveEditorReadOnly(readable, OWNER)).toBe(true)

		expect(aggregateNoteSelectionFlags([writable], OWNER, isNoteUndecryptable).hasWriteAccessToAll).toBe(true)
		expect(deriveEditorReadOnly(writable, OWNER)).toBe(false)
	})
})
