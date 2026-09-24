// Unread derivation core — the two-tier rule behind every chat unread badge: unmuted, newer than
// lastFocus, not sent by self, not from a blocked sender. Runs over pre-normalized primitives only;
// mobile's uniffi Chat/ChatMessage (nested `.inner.senderId: bigint`, optional `lastFocus`) and web's
// wasm Chat/ChatMessage (flat `senderId: number`, `lastFocus` typed non-optional yet undefined for a chat
// never focused, which web passes in as the epoch) are shaped too differently to share a function that
// takes them directly, so each app adapts its own shape into these types before calling in. Blocking is
// injected (`isSenderBlocked`) rather than imported, keeping this module independent of which
// blocked-user set an app is using.

export type UnreadMessage = {
	sentTimestamp: bigint
	senderId: bigint
	senderEmail: string
}

export type UnreadChat = {
	muted: boolean
	lastFocus: bigint | undefined
	// Whether the CHAT (not the message under test) has a lastMessage at all. Mobile gates on this;
	// web has no equivalent and always passes true — see isMessageUnreadCore.
	hasLastMessage: boolean
}

export type IsSenderBlocked = (sender: { userId: bigint; email: string }) => boolean

// Atomic per-message predicate — the one the numeric unread count sums over. `hasLastMessage` is
// deliberately a chat-level gate, not derived from `message`: a chat whose own lastMessage is absent
// never counts any message as unread, even one passed in directly.
export function isMessageUnreadCore(
	message: UnreadMessage,
	chat: UnreadChat,
	userId: bigint | undefined,
	isSenderBlocked: IsSenderBlocked
): boolean {
	if (userId === undefined || chat.muted || chat.lastFocus === undefined || !chat.hasLastMessage) {
		return false
	}

	if (message.sentTimestamp <= chat.lastFocus || message.senderId === userId) {
		return false
	}

	return !isSenderBlocked({ userId: message.senderId, email: message.senderEmail })
}

// Cheaper boolean tier, derived from the chat's own lastMessage instead of a per-chat message list.
// When that last message is from a blocked sender, falls back to scanning `getMessages()` (already
// normalized) for an older unread from someone else, so a blocked member posting into a group never
// masks a real unread behind it. Without a reader — or when it has nothing cached — this answers
// false rather than guessing.
export function chatHasUnreadCore(
	chat: { muted: boolean; lastFocus: bigint | undefined },
	lastMessage: UnreadMessage | undefined,
	userId: bigint | undefined,
	isSenderBlocked: IsSenderBlocked,
	getMessages?: () => readonly UnreadMessage[] | undefined
): boolean {
	if (userId === undefined || chat.muted || !lastMessage || chat.lastFocus === undefined) {
		return false
	}

	if (lastMessage.senderId === userId) {
		return false
	}

	if (isSenderBlocked({ userId: lastMessage.senderId, email: lastMessage.senderEmail })) {
		const messages = getMessages?.()

		if (!messages) {
			return false
		}

		return messages.some(message =>
			isMessageUnreadCore(message, { muted: chat.muted, lastFocus: chat.lastFocus, hasLastMessage: true }, userId, isSenderBlocked)
		)
	}

	return lastMessage.sentTimestamp > chat.lastFocus
}
