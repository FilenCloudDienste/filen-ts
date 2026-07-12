import { describe, expect, it } from "vitest"
import type { Note, NoteParticipant, NoteTag, UuidStr } from "@filen/sdk-rs"
import {
	noteRowPreview,
	noteRowSharedByEmail,
	noteRowTags,
	noteRowParticipants,
	participantAvatarSource
} from "@/features/notes/lib/noteRow.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short label, same as notesSort.test.ts.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: testUuid("tag"),
		name: "tag",
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n,
		...overrides
	}
}

function mockParticipant(overrides: Partial<NoteParticipant> = {}): NoteParticipant {
	return {
		userId: 1n,
		isOwner: false,
		email: "user@example.com",
		nickName: "",
		permissionsWrite: false,
		addedTimestamp: 0n,
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
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

// A note with its `preview` key absent entirely (not set to `undefined` — exactOptionalPropertyTypes
// forbids that via an override).
function mockNoteNoPreview(): Note {
	const base = mockNote()

	return {
		uuid: base.uuid,
		ownerId: base.ownerId,
		lastEditorId: base.lastEditorId,
		favorite: base.favorite,
		pinned: base.pinned,
		tags: base.tags,
		noteType: base.noteType,
		trash: base.trash,
		archive: base.archive,
		createdTimestamp: base.createdTimestamp,
		editedTimestamp: base.editedTimestamp,
		participants: base.participants
	}
}

// A tag with its `name` key absent entirely (undecryptable) — same exactOptionalPropertyTypes reason.
function mockTagNoName(uuid: UuidStr): NoteTag {
	return { uuid, favorite: false, editedTimestamp: 0n, createdTimestamp: 0n }
}

describe("noteRow.logic — noteRowPreview", () => {
	it("returns the preview when present", () => {
		expect(noteRowPreview(mockNote({ preview: "hello" }))).toBe("hello")
	})

	it("omits (undefined) when the preview is absent or empty — no title-duplication fallback", () => {
		expect(noteRowPreview(mockNoteNoPreview())).toBeUndefined()
		expect(noteRowPreview(mockNote({ preview: "" }))).toBeUndefined()
	})
})

describe("noteRow.logic — noteRowSharedByEmail", () => {
	it("returns the owning participant's email when the current user is a non-owner participant", () => {
		const note = mockNote({
			ownerId: 5n,
			participants: [mockParticipant({ userId: 5n, isOwner: true, email: "owner@example.com" }), mockParticipant({ userId: 9n })]
		})

		expect(noteRowSharedByEmail(note, 9n)).toBe("owner@example.com")
	})

	it("returns null when the current user owns the note", () => {
		const note = mockNote({ ownerId: 9n, participants: [mockParticipant({ userId: 9n, isOwner: true, email: "me@example.com" })] })

		expect(noteRowSharedByEmail(note, 9n)).toBeNull()
	})

	it("returns null when no current user is resolved yet", () => {
		const note = mockNote({ ownerId: 5n, participants: [mockParticipant({ userId: 5n, isOwner: true, email: "owner@example.com" })] })

		expect(noteRowSharedByEmail(note, undefined)).toBeNull()
	})

	it("returns null when no participant is flagged the owner", () => {
		const note = mockNote({ ownerId: 5n, participants: [mockParticipant({ userId: 9n, isOwner: false })] })

		expect(noteRowSharedByEmail(note, 9n)).toBeNull()
	})
})

describe("noteRow.logic — noteRowTags", () => {
	it("sorts tags by display name (fastLocaleCompare), never mutating the input", () => {
		const zebra = mockTag({ uuid: testUuid("z"), name: "Zebra" })
		const apple = mockTag({ uuid: testUuid("a"), name: "apple" })
		const mango = mockTag({ uuid: testUuid("m"), name: "Mango" })
		const tags = [zebra, apple, mango]
		const note = mockNote({ tags })

		expect(noteRowTags(note).map(tag => tag.name)).toStrictEqual(["apple", "Mango", "Zebra"])
		// Input array order is untouched.
		expect(tags.map(tag => tag.name)).toStrictEqual(["Zebra", "apple", "Mango"])
	})

	it("falls back to the uuid for an undecryptable (nameless) tag", () => {
		const named = mockTag({ uuid: testUuid("zzz"), name: "beta" })
		const nameless = mockTagNoName(testUuid("aaa"))
		const note = mockNote({ tags: [named, nameless] })

		// "aaa-…" (the nameless tag's uuid) sorts before "beta".
		expect(noteRowTags(note).map(tag => tag.uuid)).toStrictEqual([nameless.uuid, named.uuid])
	})
})

describe("noteRow.logic — noteRowParticipants", () => {
	it("excludes the current user", () => {
		const note = mockNote({
			participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n }), mockParticipant({ userId: 3n })]
		})

		expect(noteRowParticipants(note, 2n).map(p => p.userId)).toStrictEqual([1n, 3n])
	})

	it("keeps every participant when no current user is resolved", () => {
		const note = mockNote({ participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n })] })

		expect(noteRowParticipants(note, undefined)).toHaveLength(2)
	})
})

describe("noteRow.logic — participantAvatarSource", () => {
	it("returns the avatar only when it is a real https URL", () => {
		expect(participantAvatarSource(mockParticipant({ avatar: "https://cdn.example/a.png" }))).toBe("https://cdn.example/a.png")
		expect(participantAvatarSource(mockParticipant({ avatar: "none" }))).toBeUndefined()
		// avatar absent (never set) → undefined.
		expect(participantAvatarSource(mockParticipant())).toBeUndefined()
	})
})
