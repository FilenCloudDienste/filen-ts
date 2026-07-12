import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"

// Per-conversation unread derivation — PURE. In-app unread signals are DERIVED client-side (mobile's
// chatSelectors), never a per-chat SDK round trip (getAllChatsUnreadCount stays unwired). Two tiers, kept
// separate on purpose (same split mobile draws):
//   - isMessageUnread — the atomic message-level predicate the numeric count sums over (one hit per
//     genuinely-unread message).
//   - chatHasUnread — a cheaper boolean off the chat's own lastMessage, for callers that only need
//     "is there anything unread" without a per-chat message list (the menu's "Mark as read" gate).
//
// senderId is `number` on the wasm surface (a codegen quirk — every other user id is bigint), so it MUST
// be coerced with BigInt before comparing to the bigint userId. A message from a blocked sender never
// counts as unread — the same contacts blocking cross-reference the sharedIn drive filter uses
// (features/contacts/lib/blocking.ts); an empty/cold blocked set fails open (nobody treated as blocked),
// matching mobile's own behavior until the contacts list is warm.

export function isMessageUnread(
	message: ChatMessage,
	chat: Chat,
	userId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): boolean {
	if (userId === undefined || chat.muted) {
		return false
	}

	// Cheapest field comparisons first, blocked-set lookup last.
	if (message.sentTimestamp <= chat.lastFocus) {
		return false
	}

	const senderId = BigInt(message.senderId)

	// Our own messages are never unread.
	if (senderId === userId) {
		return false
	}

	return !isBlocked({ userId: senderId, email: message.senderEmail }, blocked)
}

// Boolean tier — derived purely from the chat's own lastMessage vs. lastFocus, never a per-chat message
// list. A blocked last-message sender reads as "not unread" here (this cheap gate does not scan older
// messages behind it — the numeric count hook, which does hold the message list, is the authoritative
// per-chat number).
export function chatHasUnread(chat: Chat, userId: bigint | undefined, blocked: BlockedUsers = EMPTY_BLOCKED_USERS): boolean {
	if (userId === undefined || chat.muted) {
		return false
	}

	const lastMessage = chat.lastMessage

	if (!lastMessage) {
		return false
	}

	const senderId = BigInt(lastMessage.senderId)

	// Our own last message is never unread.
	if (senderId === userId) {
		return false
	}

	if (lastMessage.sentTimestamp <= chat.lastFocus) {
		return false
	}

	return !isBlocked({ userId: senderId, email: lastMessage.senderEmail }, blocked)
}
