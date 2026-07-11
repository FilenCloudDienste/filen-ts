import type { Contact, Note, NoteParticipant } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { notesQueryUpsert, notesQueryUpdate, notesQueryGet } from "@/features/notes/queries/notes"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome }

// Note-participant actions — the participants-dialog counterpart to lib/tags.ts, same confirm-then-
// patch shape. Mirrors filen-mobile's notesParticipants.ts semantics exactly (this file's own doc
// comments name the mobile call each function ports).

// Idempotent, sequential add (mobile's addParticipants): every already-present contact is skipped
// up front; the remaining adds thread the PREVIOUS call's result note into the next, so the one cache
// write at the end keeps every new participant. A parallel Promise.all would each compute "base note +
// their own contact" off the same stale note and the last write would clobber the rest.
export async function addNoteParticipants(note: Note, contacts: readonly Contact[], write: boolean): Promise<ActionOutcome<Note>> {
	const toAdd = contacts.filter(contact => !note.participants.some(p => p.userId === contact.userId))

	if (toAdd.length === 0) {
		return { status: "success", item: note }
	}

	let updated = note

	try {
		for (const contact of toAdd) {
			updated = await runOp(sdkApi.addNoteParticipant(updated, contact, write))
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

// Mobile's removeParticipant (owner removing someone else — self-removal stays the separate leaveNote
// flow in lib/actions.ts, never routed through here).
export async function removeNoteParticipant(note: Note, participant: NoteParticipant): Promise<ActionOutcome<Note>> {
	if (!note.participants.some(p => p.userId === participant.userId)) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.removeNoteParticipant(note, participant.userId))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

// Mobile's setParticipantPermission. The SDK returns only the updated NoteParticipant (not the whole
// Note, unlike every other note-participant op) — patched onto the LIVE cache row's own participants
// array, never the closure-captured `note` argument (mobile's own comment on this exact call: rebuilding
// from a stale snapshot under concurrent toggles would have the last write revert every other
// in-flight change until the next full refetch).
export async function setNoteParticipantPermission(note: Note, participant: NoteParticipant, write: boolean): Promise<ActionOutcome<Note>> {
	if (participant.permissionsWrite === write) {
		return { status: "success", item: note }
	}

	let updatedParticipant: NoteParticipant

	try {
		updatedParticipant = await runOp(sdkApi.setNoteParticipantPermission(note.uuid, participant, write))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpdate(prev =>
		prev.map(n =>
			n.uuid === note.uuid
				? { ...n, participants: n.participants.map(p => (p.userId === updatedParticipant.userId ? updatedParticipant : p)) }
				: n
		)
	)

	const patched = notesQueryGet()?.find(n => n.uuid === note.uuid)

	return {
		status: "success",
		item: patched ?? {
			...note,
			participants: note.participants.map(p => (p.userId === updatedParticipant.userId ? updatedParticipant : p))
		}
	}
}
