import auth from "@/lib/auth"
import { type Note as SdkNote } from "@filen/sdk-rs"
import { type Note, type NoteHistory } from "@/types"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"

function wrapSdkNote(sdk: SdkNote): Note {
	return {
		...sdk,
		undecryptable: sdk.encryptionKey === undefined
	}
}

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
