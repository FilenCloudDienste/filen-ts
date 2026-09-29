import type { Note, NoteHistory, NoteParticipant, NoteTag } from "@filen/sdk-rs"
import { testUuid } from "@/tests/support/uuid"

export function mockNote(overrides: Partial<Note> = {}): Note {
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

export function mockNoteTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: testUuid("tag"),
		name: "tag",
		favorite: false,
		editedTimestamp: 1_700_000_000_000n,
		createdTimestamp: 1_700_000_000_000n,
		...overrides
	}
}

export function mockNoteParticipant(overrides: Partial<NoteParticipant> = {}): NoteParticipant {
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

export function mockNoteHistory(overrides: Partial<NoteHistory> = {}): NoteHistory {
	return {
		id: 1n,
		editedTimestamp: 1_700_000_000_000n,
		editorId: 1n,
		noteType: "text",
		...overrides
	}
}

// exactOptionalPropertyTypes rejects `key: undefined`, so the absent-key variants delete instead.
export function undecryptableNote(overrides: Partial<Note> = {}): Note {
	const note = mockNote(overrides)

	delete note.encryptionKey
	delete note.title

	return note
}

export function noteWithoutPreview(overrides: Partial<Note> = {}): Note {
	const note = mockNote(overrides)

	delete note.preview

	return note
}

export function tagWithoutName(overrides: Partial<NoteTag> = {}): NoteTag {
	const tag = mockNoteTag(overrides)

	delete tag.name

	return tag
}
