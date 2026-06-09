import { NoteEvent_Tags, MaybeEncryptedUniffi_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import {
	notesWithContentQueryUpdate,
	fetchData as notesWithContentQueryFetch,
	notesWithContentQueryGet
} from "@/features/notes/queries/useNotesWithContent.query"
import events from "@/lib/events"
import useNotesStore from "@/features/notes/store/useNotes.store"

export type NoteSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Note }>

export async function handleNoteEvent({ event }: { event: NoteSocketEvent }): Promise<void> {
	const [eventInner] = event.inner

	switch (eventInner.inner.tag) {
		case NoteEvent_Tags.Archived: {
			const [inner] = eventInner.inner.inner

			notesWithContentQueryUpdate({
				updater: prev =>
					prev.map(n =>
						n.uuid === inner.note
							? {
									...n,
									archive: true
								}
							: n
					)
			})

			break
		}

		case NoteEvent_Tags.Deleted: {
			const [inner] = eventInner.inner.inner

			notesWithContentQueryUpdate({
				updater: prev => prev.filter(n => n.uuid !== inner.note)
			})

			// Purge the deleted note from selectedNotes so a ghost can't inflate the
			// selection count, break the select-all toggle, or cause bulk ops to call
			// the SDK with a non-existent UUID (#42).
			useNotesStore.getState().setSelectedNotes(prev => prev.filter(n => n.uuid !== inner.note))

			break
		}

		case NoteEvent_Tags.Restored: {
			const [inner] = eventInner.inner.inner

			notesWithContentQueryUpdate({
				updater: prev =>
					prev.map(n =>
						n.uuid === inner.note
							? {
									...n,
									archive: false,
									trash: false
								}
							: n
					)
			})

			break
		}

		case NoteEvent_Tags.TitleEdited: {
			const [inner] = eventInner.inner.inner

			switch (inner.newTitle.tag) {
				case MaybeEncryptedUniffi_Tags.Decrypted: {
					const [newTitle] = inner.newTitle.inner

					notesWithContentQueryUpdate({
						updater: prev =>
							prev.map(n =>
								n.uuid === inner.note
									? {
											...n,
											title: newTitle
										}
									: n
							)
					})

					break
				}

				default: {
					console.warn("TitleEdited: received encrypted title, skipping cache update", inner)

					break
				}
			}

			break
		}

		case NoteEvent_Tags.ParticipantNew: {
			const [inner] = eventInner.inner.inner

			notesWithContentQueryUpdate({
				updater: prev =>
					prev.map(n =>
						n.uuid === inner.note
							? {
									...n,
									participants: [...n.participants.filter(p => p.userId !== inner.participant.userId), inner.participant]
								}
							: n
					)
			})

			break
		}

		case NoteEvent_Tags.ParticipantRemoved: {
			const [inner] = eventInner.inner.inner

			notesWithContentQueryUpdate({
				updater: prev =>
					prev.map(n =>
						n.uuid === inner.note
							? {
									...n,
									participants: n.participants.filter(p => p.userId !== inner.userId)
								}
							: n
					)
			})

			break
		}

		case NoteEvent_Tags.ParticipantPermissions: {
			const [inner] = eventInner.inner.inner

			notesWithContentQueryUpdate({
				updater: prev =>
					prev.map(n =>
						n.uuid === inner.note
							? {
									...n,
									participants: n.participants.map(p =>
										p.userId === inner.userId
											? {
													...p,
													permissionsWrite: inner.permissionsWrite
												}
											: p
									)
								}
							: n
					)
			})

			break
		}

		case NoteEvent_Tags.New: {
			// TODO: Don't refetch the query, build from socket event once added
			const notesWithContent = await notesWithContentQueryFetch()

			notesWithContentQueryUpdate({
				updater: () => notesWithContent
			})

			break
		}

		case NoteEvent_Tags.ContentEdited: {
			const [inner] = eventInner.inner.inner

			const notes = notesWithContentQueryGet()
			const note = notes?.find(n => n.uuid === inner.note)

			if (!note) {
				break
			}

			events.emit("noteContentEdited", {
				noteUuid: inner.note,
				contentEdited: inner
			})

			break
		}

		default: {
			console.error(eventInner)

			throw new Error("Unhandled note event")
		}
	}
}
