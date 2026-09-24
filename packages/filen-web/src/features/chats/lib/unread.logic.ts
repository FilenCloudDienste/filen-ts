import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { isBlocked, EMPTY_BLOCKED_USERS, isMessageUnreadCore, chatHasUnreadCore, type BlockedUsers } from "@filen/shared"

// Per-conversation unread derivation — thin adapters over @filen/shared's chatUnread core. In-app unread
// signals are DERIVED client-side (mobile's chatSelectors), never a per-chat SDK round trip
// (getAllChatsUnreadCount stays unwired). Two tiers, kept separate on purpose (same split mobile draws):
//   - isMessageUnread — the atomic message-level predicate the numeric count sums over (one hit per
//     genuinely-unread message).
//   - chatHasUnread — a cheaper boolean off the chat's own lastMessage, for callers that only need
//     "is there anything unread" without a per-chat message list (the menu's "Mark as read" gate).
//
// senderId is `number` on the wasm surface (a codegen quirk — every other user id is bigint), so it MUST
// be coerced with BigInt before comparing to the bigint userId. `lastFocus` is read through chatLastFocus,
// and there is no per-chat `lastMessage` presence gate to carry (`hasLastMessage: true` always).

// sdk-rs.d.ts types `lastFocus` as bigint, but the SDK hands over undefined for a chat this account never
// focused. Read that as the epoch, as the server's own unread count does, so every message from someone
// else counts; passed through as undefined, the shared core would count none of them.
export function chatLastFocus(chat: { lastFocus?: bigint | undefined }): bigint {
	return chat.lastFocus ?? 0n
}

export function isMessageUnread(
	message: ChatMessage,
	chat: Chat,
	userId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): boolean {
	return isMessageUnreadCore(
		{ sentTimestamp: message.sentTimestamp, senderId: BigInt(message.senderId), senderEmail: message.senderEmail },
		{ muted: chat.muted, lastFocus: chatLastFocus(chat), hasLastMessage: true },
		userId,
		sender => isBlocked(sender, blocked)
	)
}

// Boolean tier — derived from the chat's own lastMessage vs. lastFocus. When that last message is from a
// blocked sender it falls back to scanning the chat's cached message list for an older unread from someone
// else (mobile's chatSelectors pattern), so a blocked member posting into a group never masks a real
// unread behind it. The reader is INJECTED (never imported here) to keep this module pure and
// query-free; without one, a blocked last sender answers `false` rather than guessing.
export function chatHasUnread(
	chat: Chat,
	userId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS,
	getMessages?: (uuid: string) => readonly ChatMessage[] | undefined
): boolean {
	const lastMessage = chat.lastMessage

	return chatHasUnreadCore(
		{ muted: chat.muted, lastFocus: chatLastFocus(chat) },
		lastMessage
			? { sentTimestamp: lastMessage.sentTimestamp, senderId: BigInt(lastMessage.senderId), senderEmail: lastMessage.senderEmail }
			: undefined,
		userId,
		sender => isBlocked(sender, blocked),
		() =>
			getMessages?.(chat.uuid)?.map(m => ({
				sentTimestamp: m.sentTimestamp,
				senderId: BigInt(m.senderId),
				senderEmail: m.senderEmail
			}))
	)
}
