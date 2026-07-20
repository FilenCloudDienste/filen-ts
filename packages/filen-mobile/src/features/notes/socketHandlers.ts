import { NoteEvent_Tags, MaybeEncryptedUniffi_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import {
	notesQueryUpdate,
	fetchData as notesQueryFetch,
	notesQueryGet,
	getNotesListGeneration
} from "@/features/notes/queries/useNotesQuery"
import events from "@/lib/events"
import useNotesStore from "@/features/notes/store/useNotes.store"
import logger from "@/lib/logger"

export type NoteSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Note }>

export async function handleNoteEvent({ event }: { event: NoteSocketEvent }): Promise<void> {
	const [eventInner] = event.inner

	switch (eventInner.inner.tag) {
		case NoteEvent_Tags.Archived: {
			const [inner] = eventInner.inner.inner

			notesQueryUpdate({
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

			notesQueryUpdate({
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

			notesQueryUpdate({
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

					notesQueryUpdate({
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
					logger.warn("notes", "TitleEdited: received encrypted title, skipping cache update", { noteUuid: inner.note })

					break
				}
			}

			break
		}

		case NoteEvent_Tags.ParticipantNew: {
			const [inner] = eventInner.inner.inner

			notesQueryUpdate({
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

			notesQueryUpdate({
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

			notesQueryUpdate({
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
			//
			// Until then, guard the blind snapshot replace: an optimistic write (pin/favorite/
			// title/create) committing during the fetch's network latency would be reverted by
			// the pre-write snapshot. Retry once when a write landed mid-fetch; if the cache is
			// STILL being written to, skip — the next focus refetch reconciles.
			for (let attempt = 0; attempt < 2; attempt++) {
				const generationBefore = getNotesListGeneration()
				const notes = await notesQueryFetch()

				if (getNotesListGeneration() !== generationBefore) {
					continue
				}

				notesQueryUpdate({
					updater: () => notes
				})

				break
			}

			break
		}

		case NoteEvent_Tags.ContentEdited: {
			const [inner] = eventInner.inner.inner

			const notes = notesQueryGet()
			const note = notes?.find(n => n.uuid === inner.note)

			if (!note) {
				logger.warn("notes", "ContentEdited: note not found in cache", { noteUuid: inner.note })

				break
			}

			events.emit("noteContentEdited", {
				noteUuid: inner.note,
				contentEdited: inner
			})

			break
		}

		default: {
			logger.error("notes", "Unhandled note event", { tag: (eventInner.inner as { tag: string }).tag })

			throw new Error("Unhandled note event")
		}
	}
}
