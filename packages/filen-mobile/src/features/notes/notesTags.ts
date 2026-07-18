import auth from "@/lib/auth"
import { type Note, type NoteTag } from "@/types"
import { wrapSdkNote, wrapSdkNoteTag } from "@/features/notes/utils"
import { notesTagsQueryUpdate } from "@/features/notes/queries/useNotesTags.query"
import { notesQueryUpdate } from "@/features/notes/queries/useNotesQuery"

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

	notesQueryUpdate({
		updater: prev => prev.map(n => (n.uuid === modifiedNote.uuid ? modifiedNote : n))
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

	notesQueryUpdate({
		updater: prev => prev.map(n => (n.uuid === note.uuid ? note : n))
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

export function stripTagFromNotes<T extends { tags: { uuid: string }[] }>(notes: T[], tagUuid: string): T[] {
	return notes.map(n =>
		n.tags.some(t => t.uuid === tagUuid)
			? {
					...n,
					tags: n.tags.filter(t => t.uuid !== tagUuid)
				}
			: n
	)
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

	notesQueryUpdate({
		updater: prev => stripTagFromNotes(prev, tag.uuid)
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
