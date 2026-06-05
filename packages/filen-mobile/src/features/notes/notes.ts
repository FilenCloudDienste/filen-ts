import auth from "@/lib/auth"
import { NoteType, type Note as SdkNote } from "@filen/sdk-rs"
import { type Note, type NoteTag, type NoteHistory } from "@/types"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { createNotePreviewFromContentText } from "@filen/utils"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"
import JSZip from "jszip"
import { sanitizeFileName } from "@/lib/utils"
import { newTmpFile } from "@/lib/tmp"
import * as FileSystem from "expo-file-system"
import {
	addTag,
	removeTag,
	createTag,
	renameTag,
	deleteTag,
	favoriteTag
} from "@/features/notes/notesTags"
import {
	leave,
	removeParticipant,
	addParticipant,
	setParticipantPermission
} from "@/features/notes/notesParticipants"

function wrapSdkNote(sdk: SdkNote): Note {
	return {
		...sdk,
		undecryptable: sdk.encryptionKey === undefined
	}
}

class Notes {
	public addTag = addTag

	public removeTag = removeTag

	public createTag = createTag

	public renameTag = renameTag

	public deleteTag = deleteTag

	public favoriteTag = favoriteTag

	public leave = leave

	public removeParticipant = removeParticipant

	public addParticipant = addParticipant

	public setParticipantPermission = setParticipantPermission

	public async getContent({ note, signal }: { note: Note; signal?: AbortSignal }) {
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

	public async setContent({
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

	public async setType({
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

	public async setPinned({ note, pinned, signal }: { note: Note; pinned: boolean; signal?: AbortSignal }) {
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

	public async setFavorited({ note, favorite, signal }: { note: Note; favorite: boolean; signal?: AbortSignal }) {
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

	public async duplicate({ note, signal }: { note: Note; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()
		const [sdkResult, content] = await Promise.all([
			authedSdkClient.duplicateNote(
				note,
				signal
					? {
							signal
						}
					: undefined
			),
			this.getContent({
				note,
				signal
			})
		])

		const original = wrapSdkNote(sdkResult.original)
		const duplicated = wrapSdkNote(sdkResult.duplicated)
		const safeContent = content ?? ""

		notesWithContentQueryUpdate({
			updater: prev => [
				...prev.filter(n => n.uuid !== original.uuid && n.uuid !== duplicated.uuid),
				{
					...original,
					content: safeContent
				},
				{
					...duplicated,
					content: safeContent
				}
			]
		})

		return {
			original,
			duplicated
		}
	}

	public async export({ note, signal }: { note: Note; signal?: AbortSignal }) {
		if (note.undecryptable) {
			throw new Error("Cannot export an undecryptable note")
		}

		const content = await this.getContent({
			note,
			signal
		})

		if (content === undefined) {
			throw new Error("Note content is empty")
		}

		const file = newTmpFile(sanitizeFileName(`${note.title || note.uuid}.txt`))

		if (file.exists) {
			file.delete()
		}

		file.write(content, {
			encoding: "utf8"
		})

		return {
			file,
			cleanup: () => {
				if (file.exists) {
					file.delete()
				}
			}
		}
	}

	public async exportMultiple({ signal, notes }: { signal?: AbortSignal; notes: Note[] }) {
		const exportable = notes.filter(n => !n.undecryptable)

		if (exportable.length === 0) {
			throw new Error("No exportable notes provided")
		}

		const zip = new JSZip()

		await Promise.all(
			exportable.map(async note => {
				const content = await this.getContent({
					note,
					signal
				})

				if (content === undefined) {
					return
				}

				const sanitizedFileName = sanitizeFileName(`${note.title ? `${note.title}_` : ""}${note.uuid}.txt`)

				zip.file(sanitizedFileName, content)
			})
		)

		const buffer = await zip.generateAsync({ type: "uint8array" })
		const file = newTmpFile(sanitizeFileName(`notes_export_${Date.now()}.zip`))

		if (file.exists) {
			file.delete()
		}

		file.write(buffer)

		return {
			file,
			cleanup: () => {
				if (file.exists) {
					file.delete()
				}
			}
		}
	}

	public async archive({ note, signal }: { note: Note; signal?: AbortSignal }) {
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

	public async restore({ note, signal }: { note: Note; signal?: AbortSignal }) {
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

	public async restoreFromHistory({ note, history, signal }: { note: Note; history: NoteHistory; signal?: AbortSignal }) {
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

	public async trash({ note, signal }: { note: Note; signal?: AbortSignal }) {
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

	public async delete({ note, signal }: { note: Note; signal?: AbortSignal }) {
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

	public async setTitle({ note, newTitle, signal }: { note: Note; newTitle: string; signal?: AbortSignal }) {
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

	public async createWithOptionalTag({
		title,
		type,
		tag,
		signal
	}: {
		title: string
		type: NoteType
		tag?: NoteTag
		signal?: AbortSignal
	}): Promise<Note> {
		const note = await this.create({
			title,
			content: "",
			type,
			signal
		})

		if (tag) {
			return await this.addTag({
				note,
				tag,
				signal
			})
		}

		return note
	}

	public async importFromFile({
		uri,
		title,
		type,
		signal
	}: {
		uri: string
		title: string
		type: NoteType
		signal?: AbortSignal
	}): Promise<Note> {
		const file = new FileSystem.File(uri)

		if (!file.exists || file.size === 0) {
			throw new Error("Import file not found or empty")
		}

		const content = await file.text()

		return await this.create({
			title,
			content,
			type,
			signal
		})
	}

	public async create({ title, content, type, signal }: { title: string; content: string; type: NoteType; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()
		let note = wrapSdkNote(
			await authedSdkClient.createNote(
				title,
				signal
					? {
							signal
						}
					: undefined
			)
		)

		note = await this.setType({
			note,
			type,
			signal,
			knownContent: content
		})

		note = await this.setContent({
			note,
			content,
			signal,
			updateQuery: true
		})

		notesWithContentQueryUpdate({
			updater: prev => [
				...prev.filter(n => n.uuid !== note.uuid),
				{
					...note,
					content
				}
			]
		})

		return note
	}
}

const notes = new Notes()

export default notes
