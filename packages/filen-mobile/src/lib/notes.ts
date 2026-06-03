import auth from "@/lib/auth"
import { NoteType, type Contact, type Note as SdkNote, type NoteTag as SdkNoteTag } from "@filen/sdk-rs"
import { type Note, type NoteTag, type NoteParticipant, type NoteHistory } from "@/types"
import { noteContentQueryUpdate } from "@/queries/useNoteContent.query"
import { createNotePreviewFromContentText } from "@filen/utils"
import { notesTagsQueryUpdate } from "@/queries/useNotesTags.query"
import { notesWithContentQueryUpdate } from "@/queries/useNotesWithContent.query"
import JSZip from "jszip"
import { sanitizeFileName } from "@/lib/utils"
import { newTmpFile } from "@/lib/tmp"

function wrapSdkNote(sdk: SdkNote): Note {
	return {
		...sdk,
		undecryptable: sdk.encryptionKey === undefined
	}
}

function wrapSdkNoteTag(sdk: SdkNoteTag): NoteTag {
	return {
		...sdk,
		undecryptable: sdk.name === undefined
	}
}

class Notes {
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

		if (!content) {
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

				if (!content) {
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

	public async addTag({ note, tag, signal }: { note: Note; tag: NoteTag; signal?: AbortSignal }) {
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

	public async removeTag({ note, tag, signal }: { note: Note; tag: NoteTag; signal?: AbortSignal }) {
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

	public async createTag({ name, signal }: { name: string; signal?: AbortSignal }) {
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

	public async renameTag({ tag, newName, signal }: { tag: NoteTag; newName: string; signal?: AbortSignal }) {
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

	public async deleteTag({ tag, signal }: { tag: NoteTag; signal?: AbortSignal }) {
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

	public async favoriteTag({ tag, signal, favorite }: { tag: NoteTag; signal?: AbortSignal; favorite: boolean }) {
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

	public async leave({ note, signal }: { note: Note; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		note = wrapSdkNote(
			await authedSdkClient.removeNoteParticipant(
				note,
				(await authedSdkClient.toStringified()).userId,
				signal
					? {
							signal
						}
					: undefined
			)
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

		return note
	}

	public async removeParticipant({ note, signal, participantUserId }: { note: Note; signal?: AbortSignal; participantUserId: bigint }) {
		if (!note.participants.find(p => p.userId === participantUserId)) {
			return note
		}

		const { authedSdkClient } = await auth.getSdkClients()

		note = wrapSdkNote(
			await authedSdkClient.removeNoteParticipant(
				note,
				participantUserId,
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

	public async addParticipant({
		note,
		signal,
		permissionsWrite,
		contact
	}: {
		note: Note
		signal?: AbortSignal
		permissionsWrite: boolean
		contact: Contact
	}) {
		if (note.participants.find(p => p.userId === contact.userId)) {
			return note
		}

		const { authedSdkClient } = await auth.getSdkClients()

		note = wrapSdkNote(
			await authedSdkClient.addNoteParticipant(
				note,
				contact,
				permissionsWrite,
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

	public async setParticipantPermission({
		note,
		signal,
		participant,
		permissionsWrite
	}: {
		note: Note
		signal?: AbortSignal
		participant: NoteParticipant
		permissionsWrite: boolean
	}) {
		if (participant.permissionsWrite === permissionsWrite) {
			return note
		}

		const { authedSdkClient } = await auth.getSdkClients()

		participant = await authedSdkClient.setNoteParticipantPermission(
			note.uuid,
			participant,
			permissionsWrite,
			signal
				? {
						signal
					}
				: undefined
		)

		notesWithContentQueryUpdate({
			updater: prev =>
				prev.map(n =>
					n.uuid === note.uuid
						? {
								// Patch onto the LIVE cache entry `n`, not the closure-captured render-time
								// `note`: under bulk concurrency (Promise.all) every call would otherwise
								// rebuild participants from the same stale base array and the last write
								// would revert all the others until the next refetch.
								...n,
								participants: n.participants.map(p => (p.userId === participant.userId ? participant : p))
							}
						: n
				)
		})

		return note
	}
}

const notes = new Notes()

export default notes
