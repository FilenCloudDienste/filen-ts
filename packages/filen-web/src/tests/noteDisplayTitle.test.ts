import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { Note } from "@filen/sdk-rs"
import { noteDisplayTitle } from "@/features/notes/lib/displayTitle"
import { mockNote, undecryptableNote } from "@/tests/fixtures/notes"

const t = ((key: string): string => key) as unknown as TFunction<["notes", "common"]>

// exactOptionalPropertyTypes models the SDK's absent fields as missing keys, never `= undefined`.
function untitled(note: Note): Note {
	const copy: Note = { ...note }

	delete copy.title

	return copy
}

describe("noteDisplayTitle", () => {
	it("uses the decrypted title", () => {
		expect(noteDisplayTitle(mockNote({ title: "Groceries" }), t)).toBe("Groceries")
	})

	it("falls back to the untitled label for a readable note with no title", () => {
		expect(noteDisplayTitle(mockNote({ title: "" }), t)).toBe("noteUntitled")
		expect(noteDisplayTitle(untitled(mockNote()), t)).toBe("noteUntitled")
	})

	it("labels an undecryptable note as such, never as untitled", () => {
		expect(noteDisplayTitle(undecryptableNote(), t)).toBe("common:cannotDecryptTitle")
	})
})
