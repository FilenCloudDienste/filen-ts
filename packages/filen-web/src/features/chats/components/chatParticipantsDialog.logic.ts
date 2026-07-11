import type { Chat, ChatParticipant, Contact } from "@filen/sdk-rs"

// Pure gating/derivation helpers for chatParticipantsDialog.tsx, kept out of the component so the
// owner-vs-participant view split and the add-picker's exclusion filter stay testable without a DOM
// renderer (mirrors notes' participantsDialog.logic.ts).

export interface ChatParticipantRowModel {
	participant: ChatParticipant
	// Chats have no per-participant permission concept (unlike NoteParticipant.permissionsWrite) —
	// canManage here gates ONLY the remove button.
	canManage: boolean
	// Chat.ownerId is a single bigint field on the chat itself, not a per-participant flag (unlike
	// NoteParticipant.isOwner) — derived here once per row so the component never re-derives it.
	isOwner: boolean
}

// The viewer's OWN row is excluded entirely, not merely un-manageable — mirrors mobile's
// chatParticipants.tsx (`chat.participants.filter(p => p.userId !== stringifiedClient?.userId)`):
// self-management stays the chat menu's own "Leave" dialog, never a row here. The owner's row sorts
// first among what remains (a chat has exactly one owner, so no secondary sort key is needed).
export function chatParticipantRows(chat: Chat, currentUserId: bigint | undefined, viewerIsOwner: boolean): ChatParticipantRowModel[] {
	const others = chat.participants.filter(p => currentUserId === undefined || p.userId !== currentUserId)
	const sorted = [...others].sort((a, b) => Number(b.userId === chat.ownerId) - Number(a.userId === chat.ownerId))

	return sorted.map(participant => ({
		participant,
		// The owner's own row is never manageable even by themselves viewing it (mirrors notes: no
		// demote/remove-self surface here — that's the menu's own Leave/Delete dialogs).
		canManage: viewerIsOwner && participant.userId !== chat.ownerId,
		isOwner: participant.userId === chat.ownerId
	}))
}

// The add-picker's own contact list, filtered down to contacts not already a participant — mirrors
// mobile's selectContacts userIdsToExclude / notes' contactsAvailableToAdd. Order is preserved from
// the source contacts query.
export function contactsAvailableToAddToChat(contacts: readonly Contact[], chat: Chat): Contact[] {
	const existingUserIds = new Set(chat.participants.map(p => p.userId))

	return contacts.filter(contact => !existingUserIds.has(contact.userId))
}
