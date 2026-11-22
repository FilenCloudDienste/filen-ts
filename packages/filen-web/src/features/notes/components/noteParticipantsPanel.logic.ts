import type { Note, NoteParticipant } from "@filen/sdk-rs"
import { compareParticipantsByName, isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"

// Pure gating/derivation helpers for noteParticipantsPanel.tsx, kept out of the component so the owner-vs-participant
// view split stays testable without a DOM renderer.

export interface ParticipantRowModel {
	participant: NoteParticipant
	// The viewer's own row: labelled as theirs and never acted on here (leaving is the note menu's own Leave entry).
	isSelf: boolean
	// Owner-only management (permission select + remove) for THIS row: never on the owner's row (an owner can't demote
	// or remove themselves; that would be a transfer-ownership feature) nor on the viewer's own.
	canManage: boolean
	// Whether this row's identity is in the viewer's blocked set. NOT owner-gated (mobile parity: block/unblock is
	// offered regardless of ownership); never set on the viewer's own row.
	blocked: boolean
}

// The viewer's own row first, then the owner's, then everyone else by name (the chat info panel's order).
function rowRank(participant: NoteParticipant, currentUserId: bigint | undefined): number {
	if (participant.userId === currentUserId) {
		return 0
	}

	return participant.isOwner ? 1 : 2
}

// Every participant, the viewer included, ordered by rowRank and then by name and user id (compareParticipantsByName),
// never the server's order.
export function participantRows(
	note: Note,
	currentUserId: bigint | undefined,
	viewerIsOwner: boolean,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): ParticipantRowModel[] {
	const sorted = [...note.participants].sort(
		(a, b) => rowRank(a, currentUserId) - rowRank(b, currentUserId) || compareParticipantsByName(a, b)
	)

	return sorted.map(participant => {
		const isSelf = participant.userId === currentUserId

		return {
			participant,
			isSelf,
			canManage: viewerIsOwner && !participant.isOwner && !isSelf,
			blocked: !isSelf && isBlocked({ userId: participant.userId, email: participant.email }, blocked)
		}
	})
}

export type ParticipantPermission = "edit" | "view"

export function participantPermission(write: boolean): ParticipantPermission {
	return write ? "edit" : "view"
}
