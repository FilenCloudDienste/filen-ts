import auth from "@/lib/auth"
import { type Note, type NoteHistory } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { sync } from "@/features/notes/components/sync"

export async function setPinned({ note, pinned, signal }: { note: Note; pinned: boolean; signal?: AbortSignal }) {
	if (pinned === note.pinned) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.setNotePinned(
			note,
			pinned,
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...note,
							content: n.content
						}
					: n
			)
	})

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
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...note,
							content: n.content
						}
					: n
			)
	})

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
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...note,
							content: n.content
						}
					: n
			)
	})

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
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...note,
							content: n.content
						}
					: n
			)
	})

	return note
}

export async function restoreFromHistory({ note, history, signal }: { note: Note; history: NoteHistory; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.restoreNoteFromHistory(
			note,
			history,
			signal
				? {
						signal
					}
				: undefined
		)
	)

	// A restore makes the note's content the restored version's content. The
	// history entry's content is optional: when present, optimistically paint it
	// into both caches; when absent (unknown), leave the cached content untouched
	// and let the next per-note fetch reconcile — never blank the note.
	const restoredContent = history.content

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...note,
							content: typeof restoredContent === "string" ? restoredContent : n.content
						}
					: n
			)
	})

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

	// Drop any unsynced local content for this note. Otherwise sync.tsx would
	// later push the still-queued pre-restore inflight content back to the
	// server, overwriting the version we just restored from history. Mirrors the
	// onContentEditedRemotely teardown in components/content/index.tsx.
	useNotesInflightStore.getState().setInflightContent(prev => {
		const updated = {
			...prev
		}

		delete updated[note.uuid]

		return updated
	})

	// VC3: this clear happens outside a sync pass, so reset the note's strike count too —
	// otherwise a stale count leaks into the next editing session.
	sync.clearRejections(note.uuid)

	await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

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
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...note,
							content: n.content
						}
					: n
			)
	})

	return note
}

export async function deleteNote({ note, signal }: { note: Note; signal?: AbortSignal }) {
	if (!note.trash) {
		return
	}

	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.deleteNote(
		note,
		signal
			? {
					signal
				}
			: undefined
	)

	// Drop the note from the selection immediately so the list header's
	// selectedNotes.length count stays correct and bulk ops can't target a note
	// that no longer exists. The query cache update below runs inside a 3s
	// timeout, so we must NOT wait for it to clear the selection.
	useNotesStore.getState().setSelectedNotes(prev => prev.filter(n => n.uuid !== note.uuid))

	// We have to set a timeout here, otherwise the main chat _layout redirect kicks in too early and which feels janky and messes with the navigation stack
	setTimeout(() => {
		notesWithContentQueryUpdate({
			updater: prev => prev.filter(n => n.uuid !== note.uuid)
		})

		noteContentQueryUpdate({
			params: {
				uuid: note.uuid
			},
			updater: () => undefined
		})
	}, 3000)
}
