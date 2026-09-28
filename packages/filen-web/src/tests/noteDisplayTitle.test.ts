import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { Note } from "@filen/sdk-rs"
import { noteDisplayTitle } from "@/features/notes/lib/displayTitle"

const t = ((key: string): string => key) as unknown as TFunction<["notes", "common"]>

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "note-0000-0000-0000-000000000000",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "note-key",
		title: "Groceries",
		preview: "",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

// exactOptionalPropertyTypes models the SDK's absent fields as missing keys, never `= undefined`.
function untitled(note: Note): Note {
	const copy: Note = { ...note }

	delete copy.title

	return copy
}

function undecryptable(note: Note): Note {
	const copy = untitled(note)

	delete copy.encryptionKey

	return copy
}

describe("noteDisplayTitle", () => {
	it("uses the decrypted title", () => {
		expect(noteDisplayTitle(mockNote(), t)).toBe("Groceries")
	})

	it("falls back to the untitled label for a readable note with no title", () => {
		expect(noteDisplayTitle(mockNote({ title: "" }), t)).toBe("noteUntitled")
		expect(noteDisplayTitle(untitled(mockNote()), t)).toBe("noteUntitled")
	})

	it("labels an undecryptable note as such, never as untitled", () => {
		expect(noteDisplayTitle(undecryptable(mockNote()), t)).toBe("common:cannotDecryptTitle")
	})
})
