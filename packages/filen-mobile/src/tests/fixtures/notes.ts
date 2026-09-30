import { type Note } from "@/types"

export function makeNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "note-uuid-1",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "some-key",
		title: "Test Note",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 1000n,
		editedTimestamp: 2000n,
		participants: [],
		undecryptable: false,
		...overrides
	} as Note
}

// Simulates the SDK returning an updated Note (the encryptionKey keeps undecryptable false)
export function makeSdkNote(uuid: string, overrides: Partial<Note> = {}) {
	return {
		uuid,
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "some-key",
		title: "Test Note",
		trash: false,
		archive: false,
		createdTimestamp: 1000n,
		editedTimestamp: 2000n,
		participants: [],
		...overrides
	}
}
