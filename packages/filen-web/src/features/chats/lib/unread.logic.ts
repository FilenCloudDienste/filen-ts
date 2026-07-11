import type { Chat } from "@filen/sdk-rs"

// Per-conversation unread derivation — PURE. In-app unread signals are DERIVED client-side (mobile's
// chatSelectors.chatHasUnread), never a per-chat SDK round trip (getChatUnreadCount stays unwired).
//
// A conversation is unread when it is not muted, has a decryptable last message that is NOT our own, and
// that message is newer than our per-chat `lastFocus` read cursor. senderId is `number` on the wasm
// surface (a codegen quirk — every other user id is bigint), so it MUST be coerced with BigInt before
// comparing to the bigint userId, never `===` raw. The blocked-sender refinement mobile
// adds needs the contacts blocking model cross-referenced — not yet implemented here, same as the sidebar
// preview line's blocked tier.
export function chatHasUnread(chat: Chat, userId: bigint | undefined): boolean {
	if (userId === undefined || chat.muted) {
		return false
	}

	const lastMessage = chat.lastMessage

	if (!lastMessage) {
		return false
	}

	// Our own last message is never unread.
	if (BigInt(lastMessage.senderId) === userId) {
		return false
	}

	return lastMessage.sentTimestamp > chat.lastFocus
}
