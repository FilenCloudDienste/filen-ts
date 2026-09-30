import auth from "@/lib/auth"
import logger from "@/lib/logger"
import { NoteType } from "@filen/sdk-rs"
import { type Note, type NoteTag } from "@/types"
import { noteExportFileName, wrapSdkNote } from "@/features/notes/utils"
import { notesQueryUpdate } from "@/features/notes/queries/useNotesQuery"
import JSZip from "jszip"
import { sanitizeFileName } from "@filen/shared"
import { writeTmpFile } from "@/lib/tmp"
import * as FileSystem from "expo-file-system"
import { addTag, removeTag, createTag, renameTag, deleteTag, favoriteTag } from "@/features/notes/notesTags"
import { leave, removeParticipant, addParticipant, addParticipants, setParticipantPermission } from "@/features/notes/notesParticipants"
import { getContent, setContent, setType, setTitle } from "@/features/notes/notesContent"
import { setPinned, setFavorited, archive, restore, restoreFromHistory, trash, deleteNote } from "@/features/notes/notesLifecycle"
import { toSignalOpts } from "@/lib/signals"

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
		const sdkResult = await authedSdkClient.duplicateNote(
			note,
			toSignalOpts(signal)
		)

		const original = wrapSdkNote(sdkResult.original)
		const duplicated = wrapSdkNote(sdkResult.duplicated)

		notesQueryUpdate({
			updater: prev => [...prev.filter(n => n.uuid !== original.uuid && n.uuid !== duplicated.uuid), original, duplicated]
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

		const exportName = noteExportFileName(note)

		return {
			...writeTmpFile(sanitizeFileName(exportName.fileName), content),
			// Share MIME matching the typed extension (#83) — callers pass it to the share sheet.
			mimeType: exportName.mimeType
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
					logger.warn("notes-export", "exportMultiple: getContent returned undefined for note; skipping", { noteUuid: note.uuid })

					return
				}

				const sanitizedFileName = sanitizeFileName(
					noteExportFileName(note, {
						includeUuidSuffix: true
					}).fileName
				)

				zip.file(sanitizedFileName, content)
			})
		)

		const buffer = await zip.generateAsync({ type: "uint8array" })

		return writeTmpFile(sanitizeFileName(`notes_export_${Date.now()}.zip`), buffer)
	},

	async createWithOptionalTag({
		title,
		type,
		tag,
		signal,
		content
	}: {
		title: string
		type: NoteType
		tag?: NoteTag
		signal?: AbortSignal
		content?: string
	}): Promise<Note> {
		const note = await this.create({
			title,
			content: content ?? "",
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
		tag,
		signal
	}: {
		uri: string
		title: string
		type: NoteType
		// Importing from a tag-filtered screen attaches that screen's tag, so the imported note lands
		// in the list being viewed.
		tag?: NoteTag
		signal?: AbortSignal
	}): Promise<Note> {
		const file = new FileSystem.File(uri)

		if (!file.exists || file.size === 0) {
			throw new Error("Import file not found or empty")
		}

		return await this.createWithOptionalTag({
			title,
			type,
			tag,
			signal,
			content: await file.text()
		})
	},

	async create({ title, content, type, signal }: { title: string; content: string; type: NoteType; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()
		let note = wrapSdkNote(
			await authedSdkClient.createNote(
				title,
				toSignalOpts(signal)
			)
		)

		// Listed before the follow-up writes: their socket echoes (New, ContentEdited) can arrive
		// before those writes resolve, and the handlers look the note up in this list.
		notesQueryUpdate({
			updater: prev => [...prev.filter(n => n.uuid !== note.uuid), note]
		})

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

		notesQueryUpdate({
			updater: prev => [...prev.filter(n => n.uuid !== note.uuid), note]
		})

		return note
	}
}

export default notes
