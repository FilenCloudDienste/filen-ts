import auth from "@/lib/auth"
import { type Contact } from "@filen/sdk-rs"
import { type Note, type NoteParticipant } from "@/types"
import { wrapSdkNote } from "@/features/notes/utils"
import { notesQueryReplace, notesQueryPatch } from "@/features/notes/queries/useNotesQuery"
import { dropNoteLocally } from "@/features/notes/notesRemoval"
import { toSignalOpts } from "@/lib/signals"

export async function leave({ note, signal }: { note: Note; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	note = wrapSdkNote(
		await authedSdkClient.removeNoteParticipant(
			note,
			(await authedSdkClient.toStringified()).userId,
			toSignalOpts(signal)
		)
	)

	dropNoteLocally(note.uuid, { deferListRemoval: true })

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
			toSignalOpts(signal)
		)
	)

	// Patched, not replaced with the SDK-returned note: under bulk concurrency each returned note is
	// "base minus its own participant", so a whole-note replace would revert the other removals.
	notesQueryPatch(note.uuid, live => ({
		participants: live.participants.filter(p => p.userId !== participantUserId)
	}))

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
				toSignalOpts(signal)
			)
		)
	}

	notesQueryReplace(updated)

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
		toSignalOpts(signal)
	)

	const updatedNote: Note = {
		...note,
		participants: note.participants.map(p => (p.userId === participant.userId ? participant : p))
	}

	notesQueryPatch(note.uuid, live => ({
		participants: live.participants.map(p => (p.userId === participant.userId ? participant : p))
	}))

	return updatedNote
}
