import auth from "@/lib/auth"
import { NoteType } from "@filen/sdk-rs"
import { type Note, type NoteTag } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"
import JSZip from "jszip"
import { sanitizeFileName } from "@/lib/utils"
import { newTmpFile } from "@/lib/tmp"
import * as FileSystem from "expo-file-system"
import { addTag, removeTag, createTag, renameTag, deleteTag, favoriteTag } from "@/features/notes/notesTags"
import { leave, removeParticipant, addParticipant, addParticipants, setParticipantPermission } from "@/features/notes/notesParticipants"
import { getContent, setContent, setType, setTitle } from "@/features/notes/notesContent"
import { setPinned, setFavorited, archive, restore, restoreFromHistory, trash, deleteNote } from "@/features/notes/notesLifecycle"

const notes = {
	addTag,
	removeTag,
	createTag,
	renameTag,
	deleteTag,
	favoriteTag,
	leave,
	removeParticipant,
	addParticipant,
	addParticipants,
	setParticipantPermission,
	getContent,
	setContent,
	setType,
	setTitle,
	setPinned,
	setFavorited,
	archive,
	restore,
	restoreFromHistory,
	trash,
	delete: deleteNote,

	async duplicate({ note, signal }: { note: Note; signal?: AbortSignal }) {
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
	},

	async export({ note, signal }: { note: Note; signal?: AbortSignal }) {
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
	},

	async exportMultiple({ signal, notes }: { signal?: AbortSignal; notes: Note[] }) {
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
	},

	async createWithOptionalTag({
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
	},

	async importFromFile({
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
	},

	async create({ title, content, type, signal }: { title: string; content: string; type: NoteType; signal?: AbortSignal }) {
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

export default notes
