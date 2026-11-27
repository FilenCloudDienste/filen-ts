import { describe, expect, it } from "vitest"
import {
	noteRowPreview,
	noteRowSharedByEmail,
	noteRowTags,
	noteRowParticipants,
	noteRowSharedWithNames,
	noteRowTime
} from "@/features/notes/lib/noteRow.logic"
import { noteRowIcon, noteIcon, noteTypeIcon } from "@/features/notes/lib/icon.logic"
import { formatClockTime, formatShortDate, formatShortWeekday } from "@/lib/formatDate"
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

	it("breaks a shared name on the uuid, whatever the input order", () => {
		const first = mockNoteTag({ uuid: testUuid("a"), name: "Work" })
		const second = mockNoteTag({ uuid: testUuid("b"), name: "Work" })
		const expected = [first.uuid, second.uuid]

		expect(noteRowTags(mockNote({ tags: [second, first] })).map(tag => tag.uuid)).toStrictEqual(expected)
		expect(noteRowTags(mockNote({ tags: [first, second] })).map(tag => tag.uuid)).toStrictEqual(expected)
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

describe("noteRow.logic — noteRowSharedWithNames", () => {
	it("is null when nobody else is on the note", () => {
		expect(noteRowSharedWithNames(mockNote({ participants: [mockNoteParticipant({ userId: 1n })] }), 1n, null)).toBeNull()
	})

	it("lists the others by display name, leaving out the owner once the row names who shared it", () => {
		const note = mockNote({
			participants: [
				mockNoteParticipant({ userId: 1n }),
				mockNoteParticipant({ userId: 5n, isOwner: true, nickName: "Owner" }),
				mockNoteParticipant({ userId: 7n, nickName: "", email: "bob@example.com" })
			]
		})

		expect(noteRowSharedWithNames(note, 1n, null)).toContain("Owner")
		expect(noteRowSharedWithNames(note, 1n, "owner@example.com")).toBe("bob@example.com")
	})
})

describe("noteRow.logic — noteRowTime", () => {
	const now = 1_700_000_040_000
	const day = 24 * 60 * 60 * 1000

	it("narrows to the clock within a day, the weekday within a week, the date before that", () => {
		expect(noteRowTime(now - 60_000, now)).toBe(formatClockTime(now - 60_000))
		expect(noteRowTime(now - 3 * day, now)).toBe(formatShortWeekday(now - 3 * day))
		expect(noteRowTime(now - 10 * day, now)).toBe(formatShortDate(now - 10 * day))
	})

	it("shows the clock for a timestamp ahead of the local clock", () => {
		expect(noteRowTime(now + 60_000, now)).toBe(formatClockTime(now + 60_000))
	})
})

describe("icon.logic — noteRowIcon", () => {
	it("marks every note with its type, the default type included", () => {
		expect(noteRowIcon(mockNote({ noteType: "text" }), true)).toStrictEqual(noteTypeIcon("text"))
		expect(noteRowIcon(mockNote({ noteType: "md" }), false)).toStrictEqual(noteTypeIcon("md"))
		expect(noteRowIcon(mockNote({ noteType: "checklist" }), true)).toStrictEqual(noteTypeIcon("checklist"))
	})

	it("shows archive and trash only where no section says so", () => {
		const trashed = mockNote({ noteType: "code", trash: true })

		expect(noteRowIcon(trashed, true)).toStrictEqual(noteTypeIcon("code"))
		expect(noteRowIcon(trashed, false)).toStrictEqual(noteIcon(trashed))
		expect(noteRowIcon(mockNote({ noteType: "text", archive: true }), false)).toStrictEqual(noteIcon(mockNote({ archive: true })))
	})
})
