import { type NoteTag } from "@/types"

export type NoteTagSelectionFlags = {
	count: number
	includesFavorited: boolean
}

export const EMPTY_NOTE_TAG_FLAGS: NoteTagSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false
}) as NoteTagSelectionFlags

export function aggregateNoteTagSelectionFlags(tags: readonly NoteTag[]): NoteTagSelectionFlags {
	if (tags.length === 0) {
		return EMPTY_NOTE_TAG_FLAGS
	}

	let includesFavorited = false

	for (let i = 0; i < tags.length; i++) {
		if (tags[i]!.favorite) {
			includesFavorited = true
		}
	}

	return {
		count: tags.length,
		includesFavorited
	}
}
