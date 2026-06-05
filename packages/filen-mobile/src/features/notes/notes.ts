import auth from "@/lib/auth"
import { NoteType, type Note as SdkNote } from "@filen/sdk-rs"
import { type Note, type NoteTag } from "@/types"
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
import {
	getContent,
	setContent,
	setType,
	setTitle
} from "@/features/notes/notesContent"
import {
	setPinned,
	setFavorited,
	archive,
	restore,
	restoreFromHistory,
	trash,
	deleteNote
} from "@/features/notes/notesLifecycle"

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

	public getContent = getContent

	public setContent = setContent

	public setType = setType

	public setTitle = setTitle

	public setPinned = setPinned

	public setFavorited = setFavorited

	public archive = archive

	public restore = restore

	public restoreFromHistory = restoreFromHistory

	public trash = trash

	public delete = deleteNote

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
