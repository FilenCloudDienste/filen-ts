import { NoteEvent_Tags, MaybeEncryptedUniffi_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import {
	notesQueryUpdate,
	fetchData as notesQueryFetch,
	notesQueryGet,
	getNotesListGeneration
} from "@/features/notes/queries/useNotesQuery"
import events from "@/lib/events"
import useNotesStore from "@/features/notes/store/useNotes.store"
import notesOffline from "@/features/notes/notesOffline"
import { noteContentQueryKey } from "@/features/notes/queries/useNoteContent.query"
import { removeQueryEverywhere } from "@/queries/client"
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

			// Same reclaim the local delete/leave paths do: the account no longer has this note, so
			// holding its decrypted body in memory and in the persisted cache is retention of data
			// that is gone. Without this only MARKED notes converged (via the sync pass's prune) —
			// a note merely opened once kept its plaintext body until logout or the cache TTL.
			removeQueryEverywhere(noteContentQueryKey({ uuid: inner.note }))

			// The ledger must let go too, or the note stays badged and the pass keeps trying to
			// refresh a note the account does not have.
			notesOffline.forget({ uuid: inner.note }).catch((e: unknown) => {
				logger.warn("notes", "could not drop the offline ledger row for a deleted note", { noteUuid: inner.note, error: e })
			})

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

			// Refresh the body we hold for this note, so a copy we now KNOW to be wrong doesn't sit
			// on disk being served to the user the next time they are offline. Deliberately fire-and-
			// forget and never awaited — the socket dispatcher must not block on a fetch.
			//
			// The note the user is currently viewing is excluded inside refreshAfterRemoteEdit: that
			// one keeps the reload prompt the event above raises, which is the whole point of the
			// prompt — the user decides when their editor is replaced, not the network. The event
			// carries the new content, but as MaybeEncryptedStatic, so the refresh re-fetches through
			// the SDK rather than opening a second decryption path here.
			//
			// Deliberately NOT gated on `editorId !== auth.currentUserId()`. `editorId` is a USER id, not
			// a device id, so that test also suppresses an edit this account made on ANOTHER device —
			// which is the single most common way a marked note goes stale, and precisely what this
			// refresh exists to catch. The "we already wrote it during the push" rationale only holds
			// for the device that pushed; on every other device the cache was never written.
			//
			// The cost of not filtering is one redundant fetch after the pushing device's own editing
			// session (while it is still typing the note is open, so nothing fires), and commitContent
			// no-ops an identical body — it even advances the ledger stamp early, saving a fetch on the
			// next pass. The reload PROMPT above keeps its own-user filter: that one is about not
			// interrupting the person typing.
			notesOffline
				.refreshAfterRemoteEdit({
					// The event's OWN edit stamp, not the cached note's. The list entry still carries
					// the pre-edit value, and stamping the ledger with that would make every pass
					// consider the freshly-fetched body stale and re-fetch it — two full downloads
					// for every remote edit, forever.
					note: {
						...note,
						editedTimestamp: inner.editedTimestamp
					}
				})
				.catch((e: unknown) => {
					logger.warn("notes", "refresh after remote content edit failed", { noteUuid: inner.note, error: e })
				})

			break
		}

		default: {
			logger.error("notes", "Unhandled note event", { tag: (eventInner.inner as { tag: string }).tag })

			throw new Error("Unhandled note event")
		}
	}
}
