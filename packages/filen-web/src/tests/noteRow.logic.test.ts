import { describe, expect, it } from "vitest"
import { noteRowPreview, noteRowSharedByEmail, noteRowTags, noteRowParticipants } from "@/features/notes/lib/noteRow.logic"
import { testUuid } from "@/tests/support/uuid"
import { mockNote, mockNoteParticipant, mockNoteTag, noteWithoutPreview, tagWithoutName } from "@/tests/fixtures/notes"

describe("noteRow.logic — noteRowPreview", () => {
	it("returns the preview when present", () => {
		expect(noteRowPreview(mockNote({ preview: "hello" }))).toBe("hello")
	})

	it("omits (undefined) when the preview is absent or empty — no title-duplication fallback", () => {
		expect(noteRowPreview(noteWithoutPreview())).toBeUndefined()
		expect(noteRowPreview(mockNote({ preview: "" }))).toBeUndefined()
	})
})

describe("noteRow.logic — noteRowSharedByEmail", () => {
	it("returns the owning participant's email when the current user is a non-owner participant", () => {
		const note = mockNote({
			ownerId: 5n,
			participants: [
				mockNoteParticipant({ userId: 5n, isOwner: true, email: "owner@example.com" }),
				mockNoteParticipant({ userId: 9n })
			]
		})

		expect(noteRowSharedByEmail(note, 9n)).toBe("owner@example.com")
	})

	it("returns null when the current user owns the note", () => {
		const note = mockNote({ ownerId: 9n, participants: [mockNoteParticipant({ userId: 9n, isOwner: true, email: "me@example.com" })] })

		expect(noteRowSharedByEmail(note, 9n)).toBeNull()
	})

	it("returns null when no current user is resolved yet", () => {
		const note = mockNote({
			ownerId: 5n,
			participants: [mockNoteParticipant({ userId: 5n, isOwner: true, email: "owner@example.com" })]
		})

		expect(noteRowSharedByEmail(note, undefined)).toBeNull()
	})

	it("returns null when no participant is flagged the owner", () => {
		const note = mockNote({ ownerId: 5n, participants: [mockNoteParticipant({ userId: 9n, isOwner: false })] })

		expect(noteRowSharedByEmail(note, 9n)).toBeNull()
	})
})

describe("noteRow.logic — noteRowTags", () => {
	it("sorts tags by display name (fastLocaleCompare), never mutating the input", () => {
		const zebra = mockNoteTag({ uuid: testUuid("z"), name: "Zebra" })
		const apple = mockNoteTag({ uuid: testUuid("a"), name: "apple" })
		const mango = mockNoteTag({ uuid: testUuid("m"), name: "Mango" })
		const tags = [zebra, apple, mango]
		const note = mockNote({ tags })

		expect(noteRowTags(note).map(tag => tag.name)).toStrictEqual(["apple", "Mango", "Zebra"])
		// Input array order is untouched.
		expect(tags.map(tag => tag.name)).toStrictEqual(["Zebra", "apple", "Mango"])
	})

	it("falls back to the uuid for an undecryptable (nameless) tag", () => {
		const named = mockNoteTag({ uuid: testUuid("zzz"), name: "beta" })
		const nameless = tagWithoutName({ uuid: testUuid("aaa") })
		const note = mockNote({ tags: [named, nameless] })

		// "aaa-…" (the nameless tag's uuid) sorts before "beta".
		expect(noteRowTags(note).map(tag => tag.uuid)).toStrictEqual([nameless.uuid, named.uuid])
	})
})

describe("noteRow.logic — noteRowParticipants", () => {
	it("excludes the current user", () => {
		const note = mockNote({
			participants: [mockNoteParticipant({ userId: 1n }), mockNoteParticipant({ userId: 2n }), mockNoteParticipant({ userId: 3n })]
		})

		expect(noteRowParticipants(note, 2n).map(p => p.userId)).toStrictEqual([1n, 3n])
	})

	it("keeps every participant when no current user is resolved", () => {
		const note = mockNote({ participants: [mockNoteParticipant({ userId: 1n }), mockNoteParticipant({ userId: 2n })] })

		expect(noteRowParticipants(note, undefined)).toHaveLength(2)
	})
})
