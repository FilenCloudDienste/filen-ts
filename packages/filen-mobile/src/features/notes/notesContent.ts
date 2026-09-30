import auth from "@/lib/auth"
import { NoteType } from "@filen/sdk-rs"
import { type Note } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { createNotePreviewFromContentText, hashNoteContent } from "@filen/shared"
import { rememberNotePush } from "@/features/notes/pushEchoes"
import { notesQueryReplace } from "@/features/notes/queries/useNotesQuery"
import { toSignalOpts } from "@/lib/signals"

export async function getContent({ note, signal }: { note: Note; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getNoteContent(
		note,
		toSignalOpts(signal)
	)
}

export async function setContent({
	note,
	content,
	signal,
	updateQuery,
	contentHash
}: {
	note: Note
	content: string
	signal?: AbortSignal
	updateQuery?: boolean
	// hashNoteContent(content), when the caller already has it
	contentHash?: string
}) {
	const { authedSdkClient } = await auth.getSdkClients()

	// Before the push goes out: its socket echo can beat the response back, and must never read as an
	// edit made elsewhere.
	rememberNotePush(note.uuid, contentHash ?? hashNoteContent(content))

	note = wrapSdkNote(
		await authedSdkClient.setNoteContent(
			note,
			content,
			createNotePreviewFromContentText(
				note.noteType === NoteType.Checklist ? "checklist" : note.noteType === NoteType.Rich ? "rich" : "other",
				content
			),
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

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
	knownContent,
	knownContentHash
}: {
	note: Note
	type: NoteType
	signal?: AbortSignal
	knownContent?: string
	// hashNoteContent(knownContent), when the caller already has it
	knownContentHash?: string
}) {
	if (type === note.noteType) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	// A type change re-sends the content it was given, which echoes back like any content push.
	if (knownContent !== undefined) {
		rememberNotePush(note.uuid, knownContentHash ?? hashNoteContent(knownContent))
	}

	note = wrapSdkNote(
		await authedSdkClient.setNoteType(
			note,
			type,
			knownContent,
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

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
			toSignalOpts(signal)
		)
	)

	notesQueryReplace(note)

	return note
}
