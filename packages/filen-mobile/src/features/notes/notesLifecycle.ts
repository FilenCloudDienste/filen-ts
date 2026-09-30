import auth from "@/lib/auth"
import { type Note, type NoteHistory } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { notesQueryReplace } from "@/features/notes/queries/useNotesQuery"
import { dropNoteLocally } from "@/features/notes/notesRemoval"
import { sync } from "@/features/notes/components/sync"
import { toSignalOpts } from "@/lib/signals"

export async function setPinned({ note, pinned, signal }: { note: Note; pinned: boolean; signal?: AbortSignal }) {
	if (pinned === note.pinned) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.setNotePinned(
			note,
			pinned,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	return note
}

export async function setFavorited({ note, favorite, signal }: { note: Note; favorite: boolean; signal?: AbortSignal }) {
	if (favorite === note.favorite) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.setNoteFavorited(
			note,
			favorite,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	return note
}

export async function archive({ note, signal }: { note: Note; signal?: AbortSignal }) {
	if (note.archive || note.trash) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.archiveNote(
			note,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	return note
}

export async function restore({ note, signal }: { note: Note; signal?: AbortSignal }) {
	if (!(note.trash || note.archive)) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.restoreNote(
			note,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	return note
}

export async function restoreFromHistory({ note, history, signal }: { note: Note; history: NoteHistory; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.restoreNoteFromHistory(
			note,
			history,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	// A restore makes the note's content the restored version's content. The
	// history entry's content is optional: when present, optimistically paint it
	// into both caches; when absent (unknown), leave the cached content untouched
	// and let the next per-note fetch reconcile — never blank the note.
	const restoredContent = history.content

	if (typeof restoredContent === "string") {
		// Reseed the open editor: its remount key is this query's dataUpdatedAt, so
		// omitting dataUpdatedAt here bumps it and forces a repaint with the restored
		// text (mirrors how a remote-edit reload repaints the editor).
		noteContentQueryUpdate({
			params: {
				uuid: note.uuid
			},
			updater: restoredContent
		})
	}

	// Otherwise a pass would push the still-queued pre-restore edits back over the restored version.
	await sync.discardInflight(note.uuid)

	return note
}

export async function trash({ note, signal }: { note: Note; signal?: AbortSignal }) {
	if (note.trash) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.trashNote(
			note,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	return note
}

export async function deleteNote({ note, signal }: { note: Note; signal?: AbortSignal }) {
	if (!note.trash) {
		return
	}

	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.deleteNote(
		note,
		toSignalOpts(signal)
	)

	dropNoteLocally(note.uuid, { deferListRemoval: true })
}
