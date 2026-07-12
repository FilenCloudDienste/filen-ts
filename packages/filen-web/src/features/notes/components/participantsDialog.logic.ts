import type { Contact, Note, NoteParticipant } from "@filen/sdk-rs"
import { isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"

// Pure gating/derivation helpers for participantsDialog.tsx, kept out of the component so the owner-
// vs-participant view split and the add-picker's exclusion filter stay testable without a DOM renderer
// (see vitest.config.ts).

export interface ParticipantRowModel {
	participant: NoteParticipant
	// Owner-only management surface (permission switch + remove button) for THIS row — false on the
	// owner's own row (an owner can't demote/remove themselves here; that's a transfer-ownership
	// feature this dialog doesn't have), even when the viewer IS the owner.
	canManage: boolean
	// Whether this row's identity is currently in the viewer's blocked set. NOT owner-gated (mobile
	// parity: the block toggle is "regardless of ownership") — every remaining row can carry it.
	blocked: boolean
}

// The viewer's OWN row is excluded entirely, not merely un-manageable — mirrors mobile's
// noteParticipants.tsx exactly (`note.participants.filter(p => p.userId !== stringifiedClient?.userId)`):
// self-management stays the note menu's own "Leave" dialog, never a row here. A note with no OTHER
// participants (the common single-owner case) therefore renders the dialog's own empty state, not a
// solo self-row. Owner's row first among what remains, then the rest in their existing (server) order —
// mirrors mobile's crown-first convention without needing a second sort key, since the SDK never
// returns more than one owner. `blocked` defaults to the empty set so every pre-existing call site
// (older owner-gating tests written before the block/unblock control existed) keeps working unchanged.
export function participantRows(
	note: Note,
	currentUserId: bigint | undefined,
	viewerIsOwner: boolean,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): ParticipantRowModel[] {
	const others = note.participants.filter(p => currentUserId === undefined || p.userId !== currentUserId)
	const sorted = others.sort((a, b) => Number(b.isOwner) - Number(a.isOwner))

	return sorted.map(participant => ({
		participant,
		canManage: viewerIsOwner && !participant.isOwner,
		blocked: isBlocked({ userId: participant.userId, email: participant.email }, blocked)
	}))
}

// The add-picker's own contact list, filtered down to contacts not already a participant — mirrors
// mobile's selectContacts userIdsToExclude. Order is preserved from the source contacts query.
export function contactsAvailableToAdd(contacts: readonly Contact[], note: Note): Contact[] {
	const existingUserIds = new Set(note.participants.map(p => p.userId))

	return contacts.filter(contact => !existingUserIds.has(contact.userId))
}
