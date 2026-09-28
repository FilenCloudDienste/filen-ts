import type { TFunction } from "i18next"
import type { Note } from "@filen/sdk-rs"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"

// The one label a note goes by in the list and the editor header. An undecryptable note's title stayed
// ciphertext (the SDK leaves it undefined), so it reads "cannot decrypt", never the misleading "Untitled
// note", which would suggest an empty note the user could edit.
export function noteDisplayTitle(note: Note, t: TFunction<["notes", "common"]>): string {
	if (isNoteUndecryptable(note)) {
		return t("common:cannotDecryptTitle")
	}

	return note.title !== undefined && note.title.length > 0 ? note.title : t("noteUntitled")
}
