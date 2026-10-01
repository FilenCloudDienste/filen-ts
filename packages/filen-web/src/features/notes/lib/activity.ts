import type { Note } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ActionOutcome } from "@/lib/actions/outcome"
import type { BulkOutcome, BulkProgress } from "@/lib/actions/bulk"
import { type ActivityKeys, type ActivityValues, activityKeys } from "@/lib/activity/activity.logic"
import { runActivity, type BulkActivitySpec } from "@/lib/activity/activity"
import { noteDisplayTitle } from "@/features/notes/lib/displayTitle"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"

// The notes' actions in the words their activity toasts use (locales/en/notes.ts, "Activity toasts").
export const NOTES_PIN = activityKeys("notes:notesPin")

export const NOTES_UNPIN = activityKeys("notes:notesUnpin")

// A tag's favorite toggle too: one subject, so only the `_one` words, which name it, ever show.
export const NOTES_FAVORITE = activityKeys("notes:notesFavorite")

export const NOTES_UNFAVORITE = activityKeys("notes:notesUnfavorite")

export const NOTES_DUPLICATE = activityKeys("notes:notesDuplicate")

// Takes a `type` value: the new type's label.
export const NOTES_CHANGE_TYPE = activityKeys("notes:notesChangeType")

// Takes a `tag` value: the tag's name, as NOTES_UNTAG does.
export const NOTES_TAG = activityKeys("notes:notesTag")

export const NOTES_UNTAG = activityKeys("notes:notesUntag")

export const NOTES_ARCHIVE = activityKeys("notes:notesArchive")

export const NOTES_RESTORE = activityKeys("notes:notesRestore")

export const NOTES_TRASH = activityKeys("notes:notesTrash")

export const NOTES_DELETE_PERMANENTLY = activityKeys("notes:notesDeletePermanently")

export const NOTES_LEAVE = activityKeys("notes:notesLeave")

// A note as its activity names it: the title the list shows.
export function noteActivityName(note: Note): string {
	return noteDisplayTitle(note, i18n.getFixedT(null, ["notes", "common"]))
}

// A bulk-bar or bulk-dialog action over the selection as an activity: the succeeded notes leave the
// selection once it ends, a failed one stays selected so the user can retry without re-selecting.
export function notesActivity(
	notes: readonly Note[],
	keys: ActivityKeys,
	run: (notes: Note[], onSettled: BulkProgress) => Promise<BulkOutcome<Note>>,
	values?: ActivityValues
): BulkActivitySpec<Note> {
	return {
		items: notes,
		keys,
		name: noteActivityName,
		run,
		onDone: outcome => {
			useNotesSelectionStore.getState().removeFromSelection(outcome.succeeded.map(note => note.uuid))
		},
		...(values !== undefined ? { values } : {})
	}
}

// A creation's outcome, with the words for what failed: the create itself, or a step after it (the tag a
// note created in a tag could not take).
export type NoteCreateOutcome = { status: "success"; item: Note } | { status: "error"; dto: ErrorDTO; title: string }

export function createFailedAs(outcome: ActionOutcome<Note>, title: string): NoteCreateOutcome {
	return outcome.status === "success" ? outcome : { ...outcome, title }
}

// A new note opens once created, which is its own result: the toast shows only while it runs, then goes,
// or turns into why it failed. Resolves the note to open, or null.
export async function runNoteCreateActivity(label: string, run: () => Promise<NoteCreateOutcome>): Promise<Note | null> {
	const outcome = await runActivity({
		label,
		run,
		result: outcome =>
			outcome.status === "success" ? null : { tone: "error", title: outcome.title, description: errorLabel(outcome.dto) }
	})

	return outcome.status === "success" ? outcome.item : null
}
