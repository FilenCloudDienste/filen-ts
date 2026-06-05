import { NoteType, type Note as SdkNote, type NoteTag as SdkNoteTag } from "@filen/sdk-rs"
import { type Note, type NoteTag } from "@/types"

export function wrapSdkNote(sdk: SdkNote): Note {
	return {
		...sdk,
		undecryptable: sdk.encryptionKey === undefined
	}
}

export function wrapSdkNoteTag(sdk: SdkNoteTag): NoteTag {
	return {
		...sdk,
		undecryptable: sdk.name === undefined
	}
}

export type EditorType = "text" | "code" | "markdown" | "richtext"

// Maps a note's type to the TextEditor `type` prop. Checklist notes never render
// through TextEditor (the content view branches them to <Checklist/>), so they fall
// through to "text" here.
export function noteTypeToEditorType(type: NoteType): EditorType {
	switch (type) {
		case NoteType.Code: {
			return "code"
		}

		case NoteType.Md: {
			return "markdown"
		}

		case NoteType.Rich: {
			return "richtext"
		}

		default: {
			return "text"
		}
	}
}

// Tri-state of a tag against a working set of notes:
//   "all"  — every note already carries this tag (tap → remove from all)
//   "some" — some but not all carry it (tap → add to the rest, promoting to "all")
//   "none" — no note carries it yet (tap → add to all)
export type TagState = "all" | "some" | "none"

export function computeTagState({ notes, tag }: { notes: readonly Note[]; tag: NoteTag }): TagState {
	if (notes.length === 0) {
		return "none"
	}

	let tagged = 0

	for (let i = 0; i < notes.length; i++) {
		const note = notes[i]

		if (note && note.tags.some(t => t.uuid === tag.uuid)) {
			tagged++
		}
	}

	if (tagged === 0) {
		return "none"
	}

	if (tagged === notes.length) {
		return "all"
	}

	return "some"
}
