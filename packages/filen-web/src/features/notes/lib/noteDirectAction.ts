import type { TFunction } from "i18next"
import { toast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { copyText } from "@/lib/copyText"
import type { VoidActionOutcome } from "@/lib/actions/outcome"
import { runOutcomeActivity } from "@/lib/activity/activity"
import type { ActivityKeys, ActivityValues } from "@/lib/activity/activity.logic"
import {
	togglePinned,
	toggleFavorited,
	duplicateNote,
	archiveNote,
	restoreNote,
	trashNote,
	resolveNoteContent
} from "@/features/notes/lib/actions"
import { exportNote } from "@/features/notes/lib/export"
import {
	NOTES_ARCHIVE,
	NOTES_DUPLICATE,
	NOTES_FAVORITE,
	NOTES_PIN,
	NOTES_RESTORE,
	NOTES_TRASH,
	NOTES_UNFAVORITE,
	NOTES_UNPIN,
	noteActivityName
} from "@/features/notes/lib/activity"
import type { NoteActionId } from "@/features/notes/components/noteMenu.logic"

// Direct server writes, each run as an activity in its own words. Keyed off the note as the menu saw it:
// a pin or favorite says which way it flips.
const ACTIVITY_ACTIONS: Partial<
	Record<NoteActionId, { keys: (note: Note) => ActivityKeys; run: (note: Note) => Promise<VoidActionOutcome> }>
> = {
	pin: { keys: note => (note.pinned ? NOTES_UNPIN : NOTES_PIN), run: togglePinned },
	favorite: { keys: note => (note.favorite ? NOTES_UNFAVORITE : NOTES_FAVORITE), run: toggleFavorited },
	archive: { keys: () => NOTES_ARCHIVE, run: archiveNote },
	restore: { keys: () => NOTES_RESTORE, run: restoreNote },
	trash: { keys: () => NOTES_TRASH, run: trashNote }
}

export function runNoteActivity(
	note: Note,
	keys: ActivityKeys,
	run: (note: Note) => Promise<VoidActionOutcome>,
	values?: ActivityValues
): void {
	void runOutcomeActivity(note, { keys, name: noteActivityName, run, ...(values !== undefined ? { values } : {}) })
}

// What a note menu's "direct" entry does, for the menu (noteMenu.tsx) and the notes shortcuts (notesSidebar.tsx)
// alike. The caller has gated it already (noteMenu.logic.ts).
export async function runNoteDirectAction(
	note: Note,
	id: NoteActionId,
	t: TFunction<["notes", "common"]>,
	onDuplicated: ((duplicated: Note) => void) | undefined
): Promise<void> {
	const activity = ACTIVITY_ACTIONS[id]

	if (activity) {
		runNoteActivity(note, activity.keys(note), activity.run)
		return
	}

	switch (id) {
		case "duplicate": {
			runNoteActivity(note, NOTES_DUPLICATE, async target => {
				const outcome = await duplicateNote(target)

				if (outcome.status === "success") {
					onDuplicated?.(outcome.item)
				}

				return outcome
			})
			return
		}
		// A file save, not a server write: only a failure toasts.
		case "export": {
			const outcome = await exportNote(note)

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))
			}

			return
		}
		case "copyId": {
			await copyText(note.uuid, t("noteCopyIdToast"))

			return
		}
		case "copyContent": {
			try {
				const content = await resolveNoteContent(note)
				await navigator.clipboard.writeText(content)
				toast.success(t("noteCopyContentToast"))
			} catch (e) {
				toast.error(errorLabel(e))
			}

			return
		}
	}
}
