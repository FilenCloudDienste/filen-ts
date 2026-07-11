import type { Chat } from "@filen/sdk-rs"
import { sortChats, chatDisplayName, isChatUndecryptable } from "@/features/chats/lib/sort"

// Conversation-list view model — PURE, unit-tested. Client-side search filter over the sorted list.
//
// A search term matches a conversation when it is a case-insensitive substring of the conversation's
// display name OR of any participant's nickname/email — so a group chat is findable by any member, and a
// 1:1 by the other person's address even when unnamed. Mirrors contacts' own name+email substring filter
// (contactsList.logic.ts). An undecryptable conversation (group key didn't decrypt) has no readable name
// or reliable participant fields, so it only survives an EMPTY search (never matches a term) rather than
// leaking its raw uuid into name matching.
export function filterChats(chats: readonly Chat[], search: string, currentUserId: bigint | undefined): Chat[] {
	const sorted = sortChats(chats)
	const term = search.trim().toLowerCase()

	if (term.length === 0) {
		return sorted
	}

	return sorted.filter(chat => {
		if (isChatUndecryptable(chat)) {
			return false
		}

		if (currentUserId !== undefined && chatDisplayName(chat, currentUserId).toLowerCase().includes(term)) {
			return true
		}

		return chat.participants.some(p => {
			if (p.email.toLowerCase().includes(term)) {
				return true
			}

			return p.nickName?.toLowerCase().includes(term) ?? false
		})
	})
}
