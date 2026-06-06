import auth from "@/lib/auth"
import { NoteType } from "@filen/sdk-rs"
import { type Note } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { createNotePreviewFromContentText } from "@filen/utils"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"

export async function getContent({ note, signal }: { note: Note; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getNoteContent(
		note,
		signal
			? {
					signal
				}
			: undefined
	)
}

export async function setContent({
	note,
	content,
	signal,
	updateQuery
}: {
	note: Note
	content: string
	signal?: AbortSignal
	updateQuery?: boolean
}) {
	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.setNoteContent(
			note,
			content,
			createNotePreviewFromContentText(
				note.noteType === NoteType.Checklist ? "checklist" : note.noteType === NoteType.Rich ? "rich" : "other",
				content
			),
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
							content
						}
					: n
			)
	})

	if (updateQuery) {
		noteContentQueryUpdate({
			params: {
				uuid: note.uuid
			},
			updater: content
		})
	}

	return note
}

export async function setType({
	note,
	type,
	signal,
	knownContent
}: {
	note: Note
	type: NoteType
	signal?: AbortSignal
	knownContent?: string
}) {
	if (type === note.noteType) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.setNoteType(
			note,
			type,
			knownContent,
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

export async function setTitle({ note, newTitle, signal }: { note: Note; newTitle: string; signal?: AbortSignal }) {
	if (newTitle === note.title || newTitle.trim().length === 0) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.setNoteTitle(
			note,
			newTitle,
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
