import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"
import { isChatOwner } from "@/features/chats/lib/sort"
import { applyOfflineGate, chatMenuActions, type ChatActionDescriptor } from "@/features/chats/components/chatMenu.logic"

// Pure gating/derivation helpers for chatInfoPanel.tsx, kept out of the component so the owner-vs-participant split
// stays testable without a DOM renderer.

export interface ChatInfoParticipantRow {
	participant: ChatParticipant
	// The viewer's own row: shown as "You" and never acted on here; leaving is the panel's own Leave/Delete.
	isSelf: boolean
	// Chat.ownerId is a single bigint on the chat itself, not a per-participant flag.
	isOwner: boolean
	// Owner-only, and never on the owner's own row (mobile parity: remove-only management, no self-removal).
	canRemove: boolean
	// Live block state, for any viewer (mobile parity: block/unblock is never owner-gated); never set on the viewer's own row.
	blocked: boolean
}

export type ParticipantRowActionId = "remove" | "block" | "unblock"

// The viewer's own row first, then the owner's, then everyone else in the chat's own order.
function rowRank(participant: ChatParticipant, chat: Chat, currentUserId: bigint | undefined): number {
	if (participant.userId === currentUserId) {
		return 0
	}

	return participant.userId === chat.ownerId ? 1 : 2
}

export function chatInfoParticipantRows(
	chat: Chat,
	currentUserId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): ChatInfoParticipantRow[] {
	const viewerIsOwner = isChatOwner(chat, currentUserId)
	const sorted = [...chat.participants].sort((a, b) => rowRank(a, chat, currentUserId) - rowRank(b, chat, currentUserId))

	return sorted.map(participant => {
		const isSelf = participant.userId === currentUserId
		const isOwner = participant.userId === chat.ownerId

		return {
			participant,
			isSelf,
			isOwner,
			canRemove: viewerIsOwner && !isOwner && !isSelf,
			blocked: !isSelf && isBlocked({ userId: participant.userId, email: participant.email }, blocked)
		}
	})
}

// A row's ⋯ entries, in menu order; none for the viewer's own row, which then shows no menu at all.
export function participantRowActions(row: ChatInfoParticipantRow): ParticipantRowActionId[] {
	if (row.isSelf) {
		return []
	}

	const actions: ParticipantRowActionId[] = []

	if (row.canRemove) {
		actions.push("remove")
	}

	actions.push(row.blocked ? "unblock" : "block")

	return actions
}

export interface ChatInfoChatActions {
	rename: ChatActionDescriptor | undefined
	mute: ChatActionDescriptor | undefined
	// Delete for the owner, Leave for everyone else.
	end: ChatActionDescriptor | undefined
}

// The conversation-level controls come from the chat menu's own builder and offline gate, so the panel never offers
// what the menu would refuse (rename owner-only, every write offline-disabled).
export function chatInfoChatActions(chat: Chat, currentUserId: bigint | undefined, isOnline: boolean): ChatInfoChatActions {
	const descriptors = applyOfflineGate(chatMenuActions(chat, currentUserId, false), isOnline)

	return {
		rename: descriptors.find(descriptor => descriptor.id === "rename"),
		mute: descriptors.find(descriptor => descriptor.id === "mute"),
		end: descriptors.find(descriptor => descriptor.id === "delete" || descriptor.id === "leave")
	}
}
