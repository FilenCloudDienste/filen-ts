import { NoteEvent_Tags, MaybeEncryptedUniffi_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import {
	notesQueryUpdate,
	notesQueryPatch,
	fetchData as notesQueryFetch,
	notesQueryGet,
	getNotesListGeneration
} from "@/features/notes/queries/useNotesQuery"
import events from "@/lib/events"
import { dropNoteLocally } from "@/features/notes/notesRemoval"
import notesOffline from "@/features/notes/notesOffline"
import { noteContentRemoteEditSeen } from "@/features/notes/queries/useNoteContent.query"
import logger from "@/lib/logger"
import auth from "@/lib/auth"
import { hashNoteContent } from "@filen/shared"
import { isOwnNotePush } from "@/features/notes/pushEchoes"

export type NoteSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Note }>

export async function handleNoteEvent({ event }: { event: NoteSocketEvent }): Promise<void> {
	const [eventInner] = event.inner

	switch (eventInner.inner.tag) {
		case NoteEvent_Tags.Archived: {
			const [inner] = eventInner.inner.inner

			notesQueryPatch(inner.note, () => ({
				archive: true
			}))

			break
		}

		case NoteEvent_Tags.Deleted: {
			const [inner] = eventInner.inner.inner

			// Same reclaim the local delete/leave paths do, but immediate: the account no longer has
			// this note, so holding its decrypted body in memory and in the persisted cache is retention
			// of data that is gone. Without this only MARKED notes converged (via the sync pass's prune).
			dropNoteLocally(inner.note, { deferListRemoval: false })

			// The ledger must let go too, or the note stays badged and the pass keeps trying to
			// refresh a note the account does not have.
			notesOffline.forget({ uuid: inner.note }).catch((e: unknown) => {
				logger.warn("notes", "could not drop the offline ledger row for a deleted note", { noteUuid: inner.note, error: e })
			})

			break
		}

		case NoteEvent_Tags.Restored: {
			const [inner] = eventInner.inner.inner

			notesQueryPatch(inner.note, () => ({
				archive: false,
				trash: false
			}))

			break
		}

		case NoteEvent_Tags.TitleEdited: {
			const [inner] = eventInner.inner.inner

			switch (inner.newTitle.tag) {
				case MaybeEncryptedUniffi_Tags.Decrypted: {
					const [newTitle] = inner.newTitle.inner

					notesQueryPatch(inner.note, () => ({
						title: newTitle
					}))

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

			notesQueryPatch(inner.note, live => ({
				participants: [...live.participants.filter(p => p.userId !== inner.participant.userId), inner.participant]
			}))

			break
		}

		case NoteEvent_Tags.ParticipantRemoved: {
			const [inner] = eventInner.inner.inner

			notesQueryPatch(inner.note, live => ({
				participants: live.participants.filter(p => p.userId !== inner.userId)
			}))

			break
		}

		case NoteEvent_Tags.ParticipantPermissions: {
			const [inner] = eventInner.inner.inner

			notesQueryPatch(inner.note, live => ({
				participants: live.participants.map(p =>
					p.userId === inner.userId
						? {
								...p,
								permissionsWrite: inner.permissionsWrite
							}
						: p
				)
			}))

			break
		}

		case NoteEvent_Tags.New: {
			const [inner] = eventInner.inner.inner

			// The event carries only the uuid. A note already listed was written by this device's own
			// create/import/duplicate before the echo arrived — nothing to learn from a full re-list.
			if (notesQueryGet()?.some(n => n.uuid === inner.note)) {
				break
			}

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

			noteContentRemoteEditSeen(inner.note)

			const notes = notesQueryGet()
			const note = notes?.find(n => n.uuid === inner.note)

			if (!note) {
				logger.warn("notes", "ContentEdited: note not found in cache", { noteUuid: inner.note })

				break
			}

			const content = inner.content.tag === MaybeEncryptedUniffi_Tags.Decrypted ? inner.content.inner[0] : undefined
			// Echo suppression for the open editor. The server sends an edit back to every session of its
			// author, this device's own pushes included. Another user's edit is never ours; one of this
			// account's is ours only when its content is something this device pushed (pushEchoes.ts): the
			// same account editing on another device is an edit like anyone else's. Content that can't be
			// decrypted can't be recognised, and is taken for ours.
			const ownEcho =
				inner.editorId === auth.currentUserId() && (content === undefined || isOwnNotePush(inner.note, hashNoteContent(content)))

			if (!ownEcho) {
				events.emit("noteContentEdited", {
					noteUuid: inner.note,
					contentEdited: inner,
					content
				})
			}

			// Refresh the body we hold for this note, so a copy we now KNOW to be wrong doesn't sit
			// on disk being served to the user the next time they are offline. Deliberately fire-and-
			// forget and never awaited — the socket dispatcher must not block on a fetch.
			//
			// The note the user is currently viewing is excluded inside refreshAfterRemoteEdit: its editor
			// answers the event above itself — reloading when nothing is being edited, asking otherwise —
			// so the user decides when their edits are replaced, not the network. The event's content is
			// already decrypted by the SDK with the same decrypt getNoteContent uses, so it is committed
			// as is; only an undecryptable or empty event, or one arriving while this device still awaits
			// the echo of its own push, re-fetches. Called after `ownEcho` above has consumed this
			// event's own echo, so the refresh sees only pushes still unheard.
			//
			// Deliberately NOT gated on `editorId !== auth.currentUserId()`. `editorId` is a USER id, not
			// a device id, so that test also suppresses an edit this account made on ANOTHER device —
			// which is the single most common way a marked note goes stale, and precisely what this
			// refresh exists to catch. The "we already wrote it during the push" rationale only holds
			// for the device that pushed; on every other device the cache was never written.
			//
			// The cost of not filtering is one redundant commit after the pushing device's own editing
			// session (while it is still typing the note is open, so nothing fires), and commitContent
			// no-ops an identical body — it even advances the ledger stamp early, saving a fetch on the
			// next pass. The event above keeps its own-echo filter: that one is about not interrupting
			// the person typing with their own push.
			notesOffline
				.refreshAfterRemoteEdit({
					// The event's OWN edit stamp, not the cached note's. The list entry still carries
					// the pre-edit value, and stamping the ledger with that would make every pass
					// consider the freshly-fetched body stale and re-fetch it — two full downloads
					// for every remote edit, forever.
					note: {
						...note,
						editedTimestamp: inner.editedTimestamp
					},
					content
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
