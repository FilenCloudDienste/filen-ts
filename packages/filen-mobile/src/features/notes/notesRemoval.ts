import { noteContentQueryKey } from "@/features/notes/queries/useNoteContent.query"
import { removeQueryEverywhere } from "@/queries/client"
import { notesQueryUpdate } from "@/features/notes/queries/useNotesQuery"
import useNotesStore from "@/features/notes/store/useNotes.store"

// Drops a note this account no longer has from local state. The selection purge is always
// immediate so the header's selection count stays right and bulk ops can't target a ghost (#42).
export function dropNoteLocally(uuid: string, { deferListRemoval }: { deferListRemoval: boolean }): void {
	useNotesStore.getState().setSelectedNotes(prev => prev.filter(n => n.uuid !== uuid))

	const drop = () => {
		notesQueryUpdate({
			updater: prev => prev.filter(n => n.uuid !== uuid)
		})

		// removeQueryEverywhere, not `updater: () => undefined`: query-core's setQueryData bails out
		// when the updater yields undefined (`if (data === void 0) return`), so the old form was a
		// silent no-op and this note's decrypted body survived in memory and on disk. This also drops
		// the persisted row, which removeQueries alone would leave behind.
		removeQueryEverywhere(noteContentQueryKey({ uuid }))
	}

	if (!deferListRemoval) {
		drop()

		return
	}

	// Local delete/leave: removing the note at once fires the note route's redirect too early, which
	// is janky and messes with the navigation stack.
	setTimeout(drop, 3000)
}
