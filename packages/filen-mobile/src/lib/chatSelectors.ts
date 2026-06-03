import { type Chat } from "@/types"

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

export function chatHasUnread(c: Chat, userId: bigint): boolean {
	if (c.muted) {
		return false
	}

	if (!c.lastMessage || c.lastFocus === undefined || c.lastFocus === null) {
		return false
	}

	if (c.lastMessage.inner.senderId === userId) {
		return false
	}

	return c.lastMessage.sentTimestamp > c.lastFocus
}

export function aggregateChatSelectionFlags(chats: readonly Chat[], userId: bigint | undefined): ChatSelectionFlags {
	if (chats.length === 0 || userId === undefined) {
		return EMPTY_CHAT_FLAGS
	}

	let includesMuted = false
	let everyOwnedBySelf = true
	let selfIsParticipantNotOwnerOfEvery = true
	let includesUnread = false
	let includesUndecryptable = false

	for (let i = 0; i < chats.length; i++) {
		const c = chats[i]!

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

		if (chatHasUnread(c, userId)) {
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
