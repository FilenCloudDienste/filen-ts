import type { Chat } from "@filen/sdk-rs"

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
}

export const EMPTY_CHAT_FLAGS: ChatSelectionFlags = Object.freeze({
	count: 0,
	includesMuted: false,
	everyOwnedBySelf: false,
	selfIsParticipantNotOwnerOfEvery: false
}) as ChatSelectionFlags

export function aggregateChatSelectionFlags(chats: readonly Chat[], userId: bigint | undefined): ChatSelectionFlags {
	if (chats.length === 0 || userId === undefined) {
		return EMPTY_CHAT_FLAGS
	}

	let includesMuted = false
	let everyOwnedBySelf = true
	let selfIsParticipantNotOwnerOfEvery = true

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
	}

	return {
		count: chats.length,
		includesMuted,
		everyOwnedBySelf,
		selfIsParticipantNotOwnerOfEvery
	}
}
