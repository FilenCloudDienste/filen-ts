import type { Chat } from "@filen/sdk-rs"
import { sortChats, chatDisplayName, chatMessagePreview, isChatUndecryptable } from "@/features/chats/lib/sort"

// A chat is listed only when the viewer owns it OR it has at least one message — mirrors mobile's own
// list filter (components/list/index.tsx): an owned-but-empty chat the user just created still shows
// (it's theirs), but a chat the user was merely invited to and that nobody has posted in yet is hidden
// until the first message arrives. `currentUserId` unresolved (account query not yet warm) treats every
// chat as "not owned" — the safer default, same posture as isChatOwner elsewhere in this feature.
function isListedChat(chat: Chat, currentUserId: bigint | undefined): boolean {
	if (chat.lastMessage !== undefined) {
		return true
	}

	return currentUserId !== undefined && chat.ownerId === currentUserId
}

// Conversation-list view model — PURE, unit-tested. Client-side search filter over the sorted list.
//
// A search term matches a conversation when it is a case-insensitive substring of the conversation's
// display name, its last-message text, OR any participant's nickname/email — so a group chat is findable
// by any member or by what was last said in it, and a 1:1 by the other person's address even when
// unnamed. Mirrors contacts' own name+email substring filter (contactsList.logic.ts). An undecryptable
// conversation (group key didn't decrypt) has no readable name or reliable participant fields, so it only
// survives an EMPTY search (never matches a term) rather than leaking its raw uuid into name matching.
//
// The owned-or-has-a-message visibility filter (isListedChat) applies before both the empty-search and
// term-search branches — it's a list-membership rule, not a search refinement.
//
// `soloFallback` is the rendered title of a chat with no other participants (chatDisplayName's own
// fallback) — threaded through so searching matches exactly what the row displays.
export function filterChats(chats: readonly Chat[], search: string, currentUserId: bigint | undefined, soloFallback: string): Chat[] {
	const sorted = sortChats(chats).filter(chat => isListedChat(chat, currentUserId))
	const term = search.trim().toLowerCase()

	if (term.length === 0) {
		return sorted
	}

	return sorted.filter(chat => {
		if (isChatUndecryptable(chat)) {
			return false
		}

		if (currentUserId !== undefined && chatDisplayName(chat, currentUserId, soloFallback).toLowerCase().includes(term)) {
			return true
		}

		if (chatMessagePreview(chat)?.toLowerCase().includes(term) === true) {
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

// Uuids of currently-selected chats no longer present in a live chat set — chatsSidebar.tsx's own
// stale-selection purge uses this to drop a selection ghost the instant a conversationDeleted/
// conversationParticipantLeft socket event (or another tab's delete/leave) removes a chat out from
// under an active multi-selection. Mirrors drive's directoryListing.logic.ts staleSelectionUuids
// exactly, generalized the same way (generic over its second argument, keyed purely on uuid presence).
export function staleChatSelectionUuids(selectedChats: readonly Chat[], liveChats: readonly Chat[]): string[] {
	const liveUuids = new Set(liveChats.map(chat => chat.uuid))

	return selectedChats.filter(chat => !liveUuids.has(chat.uuid)).map(chat => chat.uuid)
}
