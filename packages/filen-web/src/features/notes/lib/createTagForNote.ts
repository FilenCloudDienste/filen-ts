import type { Note, NoteTag } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { createNoteTag, addTagToNote } from "@/features/notes/lib/tags"
import { noteTagsQueryGet } from "@/features/notes/queries/noteTags"

// A tag an earlier attempt created before tagging the note failed, under the trimmed name it was asked for.
export interface CreatedTag {
	name: string
	tag: NoteTag
}

export type CreateTagForNoteOutcome = { status: "success" } | { status: "error"; dto: ErrorDTO; created?: CreatedTag }

// Creates a tag and tags the note with it. Tag names are encrypted client-side, so nothing server-side
// stops a duplicate: a retry after the tagging half failed reuses the tag the first attempt created
// (while it is still cached) instead of creating a second one with the same name.
export async function createTagForNote(note: Note, name: string, created: CreatedTag | undefined): Promise<CreateTagForNoteOutcome> {
	const trimmed = name.trim()
	let tag: NoteTag

	if (created?.name === trimmed && (noteTagsQueryGet() ?? []).some(t => t.uuid === created.tag.uuid)) {
		tag = created.tag
	} else {
		const tagOutcome = await createNoteTag(trimmed)

		if (tagOutcome.status === "error") {
			return tagOutcome
		}

		tag = tagOutcome.item
	}

	const tagged = await addTagToNote(note, tag)

	if (tagged.status === "error") {
		return { status: "error", dto: tagged.dto, created: { name: trimmed, tag } }
	}

	return { status: "success" }
}
