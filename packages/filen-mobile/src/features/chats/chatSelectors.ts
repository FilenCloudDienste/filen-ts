import { type Chat, type ChatMessage } from "@/types"
import { type BlockedUsers, EMPTY_BLOCKED_USERS } from "@/features/contacts/blockedSelectors"

/**
 * Aggregated flags for a Chats selection, computed in a single pass.
 *
 * Used by the Chats list header to enable/disable / relabel bulk-action
 * menu entries. Replaces the prior pattern of 3+ independent
 * `useShallow(state => state.selectedChats.some(...))` subscriptions.
 */
export type ChatSelectionFlags = {
	count: number
	includesMuted: boolean
	everyOwnedBySelf: boolean
	/**
	 * True iff every selected chat has the current user as a participant AND
	 * the current user is NOT the owner of any. Gates "Leave" (participants
	 * leave; owners delete).
	 */
	selfIsParticipantNotOwnerOfEvery: boolean
	/**
	 * True iff any selected chat has at least one unread message from someone
	 * other than the current user and isn't muted. Computed from `lastFocus`
	 * vs. `lastMessage.sentTimestamp` — the same predicate
	 * `useChatUnreadCount` uses, but at the Chat level (no per-chat message
	 * query needed). Gates the bulk Mark-as-read action.
	 */
	includesUnread: boolean
	/**
	 * True iff any selected chat is undecryptable (e.g. encryption key didn't
	 * decrypt). Gates non-Delete/Leave bulk actions away to avoid issuing SDK
	 * calls that would no-op or fail on placeholder data.
	 */
	includesUndecryptable: boolean
}

export const EMPTY_CHAT_FLAGS: ChatSelectionFlags = Object.freeze({
	count: 0,
	includesMuted: false,
	everyOwnedBySelf: false,
	selfIsParticipantNotOwnerOfEvery: false,
	includesUnread: false,
	includesUndecryptable: false
}) as ChatSelectionFlags

export function isMessageUnread(message: ChatMessage, chat: Chat, userId: bigint | undefined, blocked: BlockedUsers = EMPTY_BLOCKED_USERS): boolean {
	return (
		chat.lastFocus !== undefined &&
		chat.lastFocus !== null &&
		!!chat.lastMessage &&
		!chat.muted &&
		message.sentTimestamp > chat.lastFocus &&
		message.inner.senderId !== userId &&
		!blocked.userIds.has(message.inner.senderId)
	)
}

export function chatHasUnread(
	c: Chat,
	userId: bigint,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS,
	getMessages?: (uuid: string) => readonly ChatMessage[] | undefined
): boolean {
	if (c.muted) {
		return false
	}

	if (!c.lastMessage || c.lastFocus === undefined || c.lastFocus === null) {
		return false
	}

	const lastSenderId = c.lastMessage.inner.senderId

	// Last message is our own → not unread.
	if (lastSenderId === userId) {
		return false
	}

	// Last message is from a blocked sender — the cheap last-message check would false-positive.
	// Scan the cached message list for any unread message from a non-blocked, non-self sender
	// (false unless we can see the messages).
	if (blocked.userIds.has(lastSenderId)) {
		const messages = getMessages?.(c.uuid)

		if (!messages) {
			return false
		}

		return messages.some(m => isMessageUnread(m, c, userId, blocked))
	}

	return c.lastMessage.sentTimestamp > c.lastFocus
}

/**
 * Returns true iff every chat in `visibleChats` is present in `selectedChats`
 * (matched by uuid), AND `visibleChats` is non-empty.
 *
 * Deliberately UUID-based rather than count-based so that a new chat arriving
 * while selection mode is active (causing `visibleChats.length` to diverge from
 * `selectedChats.length`) does not incorrectly flip the toggle label.
 */
export function allVisibleChatsSelected(visibleChats: readonly Chat[], selectedChats: readonly Chat[]): boolean {
	if (visibleChats.length === 0) {
		return false
	}

	const selectedUuids = new Set(selectedChats.map(c => c.uuid))

	return visibleChats.every(c => selectedUuids.has(c.uuid))
}

export function aggregateChatSelectionFlags(
	chats: readonly Chat[],
	userId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS,
	getMessages?: (uuid: string) => readonly ChatMessage[] | undefined
): ChatSelectionFlags {
	if (chats.length === 0 || userId === undefined) {
		return EMPTY_CHAT_FLAGS
	}

	let includesMuted = false
	let everyOwnedBySelf = true
	let selfIsParticipantNotOwnerOfEvery = true
	let includesUnread = false
	let includesUndecryptable = false

	for (const c of chats) {
		if (c.muted) {
			includesMuted = true
		}

		const isOwner = c.ownerId === userId
		const isParticipant = c.participants.some(p => p.userId === userId)

		if (!isOwner) {
			everyOwnedBySelf = false
		}

		if (isOwner || !isParticipant) {
			selfIsParticipantNotOwnerOfEvery = false
		}

		if (chatHasUnread(c, userId, blocked, getMessages)) {
			includesUnread = true
		}

		if (c.undecryptable) {
			includesUndecryptable = true
		}
	}

	return {
		count: chats.length,
		includesMuted,
		everyOwnedBySelf,
		selfIsParticipantNotOwnerOfEvery,
		includesUnread,
		includesUndecryptable
	}
}
