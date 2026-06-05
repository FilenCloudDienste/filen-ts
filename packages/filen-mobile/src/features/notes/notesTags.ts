import auth from "@/lib/auth"
import { type Note, type NoteTag } from "@/types"
import { wrapSdkNote, wrapSdkNoteTag } from "@/features/notes/utils"
import { notesTagsQueryUpdate } from "@/features/notes/queries/useNotesTags.query"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"

export async function addTag({ note, tag, signal }: { note: Note; tag: NoteTag; signal?: AbortSignal }) {
	if (note.tags.find(t => t.uuid === tag.uuid)) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const { note: modifiedNoteSdk } = await authedSdkClient.addTagToNote(
		note,
		tag,
		signal
			? {
					signal
				}
			: undefined
	)

	const modifiedNote = wrapSdkNote(modifiedNoteSdk)

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === modifiedNote.uuid
					? {
							...modifiedNote,
							content: n.content
						}
					: n
			)
	})

	return modifiedNote
}

export async function removeTag({ note, tag, signal }: { note: Note; tag: NoteTag; signal?: AbortSignal }) {
	if (!note.tags.find(t => t.uuid === tag.uuid)) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.removeTagFromNote(
			note,
			tag,
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

export async function createTag({ name, signal }: { name: string; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()
	const tag = wrapSdkNoteTag(
		await authedSdkClient.createNoteTag(
			name,
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesTagsQueryUpdate({
		updater: prev => [...prev.filter(t => t.uuid !== tag.uuid), tag]
	})

	return tag
}

export async function renameTag({ tag, newName, signal }: { tag: NoteTag; newName: string; signal?: AbortSignal }) {
	if (newName === tag.name || newName.trim().length === 0) {
		return tag
	}

	const { authedSdkClient } = await auth.getSdkClients()

	tag = wrapSdkNoteTag(
		await authedSdkClient.renameNoteTag(
			tag,
			newName,
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesTagsQueryUpdate({
		updater: prev => prev.map(t => (t.uuid === tag.uuid ? tag : t))
	})

	return tag
}

export async function deleteTag({ tag, signal }: { tag: NoteTag; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.deleteNoteTag(
		tag,
		signal
			? {
					signal
				}
			: undefined
	)

	notesTagsQueryUpdate({
		updater: prev => prev.filter(t => t.uuid !== tag.uuid)
	})
}

export async function favoriteTag({ tag, signal, favorite }: { tag: NoteTag; signal?: AbortSignal; favorite: boolean }) {
	if (tag.favorite === favorite) {
		return tag
	}

	const { authedSdkClient } = await auth.getSdkClients()

	tag = wrapSdkNoteTag(
		await authedSdkClient.setNoteTagFavorited(
			tag,
			favorite,
			signal
				? {
						signal
					}
				: undefined
		)
	)

	notesTagsQueryUpdate({
		updater: prev => prev.map(t => (t.uuid === tag.uuid ? tag : t))
	})

	return tag
}
