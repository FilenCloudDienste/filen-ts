import auth from "@/lib/auth"
import { type Contact } from "@filen/sdk-rs"
import { type Note, type NoteParticipant } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { notesWithContentQueryUpdate } from "@/features/notes/queries/useNotesWithContent.query"
import useNotesStore from "@/features/notes/store/useNotes.store"

export async function leave({ note, signal }: { note: Note; signal?: AbortSignal }) {
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

	// Drop the note from the selection immediately so the list header's
	// selectedNotes.length count stays correct and bulk ops can't target a note
	// that no longer exists. The query cache update below runs inside a 3s
	// timeout, so we must NOT wait for it to clear the selection.
	useNotesStore.getState().setSelectedNotes(prev => prev.filter(n => n.uuid !== note.uuid))

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

export async function removeParticipant({
	note,
	signal,
	participantUserId
}: {
	note: Note
	signal?: AbortSignal
	participantUserId: bigint
}) {
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

export async function addParticipants({
	note,
	signal,
	permissionsWrite,
	contacts
}: {
	note: Note
	signal?: AbortSignal
	permissionsWrite: boolean
	contacts: Contact[]
}) {
	// Skip contacts already in the note; if none remain, touch neither the SDK nor the cache.
	const toAdd = contacts.filter(contact => !note.participants.find(p => p.userId === contact.userId))

	if (toAdd.length === 0) {
		return note
	}

	const { authedSdkClient } = await auth.getSdkClients()

	// Sequential by design (mirrors chats.addParticipants): each add threads the previous result so
	// the single cache write below keeps EVERY new participant. Parallel adds each computed
	// "base note + their own contact" from the same stale note, so the last write clobbered the rest.
	let updated = note

	for (const contact of toAdd) {
		updated = wrapSdkNote(
			await authedSdkClient.addNoteParticipant(
				updated,
				contact,
				permissionsWrite,
				signal
					? {
							signal
						}
					: undefined
			)
		)
	}

	notesWithContentQueryUpdate({
		updater: prev =>
			prev.map(n =>
				n.uuid === note.uuid
					? {
							...updated,
							content: n.content
						}
					: n
			)
	})

	return updated
}

export async function addParticipant({
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
	return await addParticipants({
		note,
		contacts: [contact],
		permissionsWrite,
		signal
	})
}

export async function setParticipantPermission({
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

	const updatedNote: Note = {
		...note,
		participants: note.participants.map(p => (p.userId === participant.userId ? participant : p))
	}

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

	return updatedNote
}
