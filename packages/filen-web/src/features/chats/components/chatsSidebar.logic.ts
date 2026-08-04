import type { Chat } from "@filen/sdk-rs"
import { sortChats, chatDisplayName, chatMessagePreview, isChatUndecryptable, isLastMessageFromBlocked } from "@/features/chats/lib/sort"
import { isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"

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
//
// `blocked` skips ONLY the last-message text branch when that message came from a blocked sender: a group
// chat (never hidden wholesale — only 1:1s are) would otherwise stay findable by typing the exact text the
// row substitutes with "Message hidden". Name and participant matching are unaffected.
export function filterChats(
	chats: readonly Chat[],
	search: string,
	currentUserId: bigint | undefined,
	soloFallback: string,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): Chat[] {
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

		if (!isLastMessageFromBlocked(chat, blocked) && chatMessagePreview(chat)?.toLowerCase().includes(term) === true) {
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

// A 1:1 conversation whose sole other participant is blocked — port of mobile's isOneOnOneWithBlocked
// (chatSelectors.ts). A group chat (2+ others) is never hidden wholesale; its blocked members are
// tombstoned per message instead. Uses the shared isBlocked helper so the userId-first / trimmed-email
// fallback rule stays in one place.
export function isOneOnOneWithBlocked(chat: Chat, currentUserId: bigint | undefined, blocked: BlockedUsers): boolean {
	const others = chat.participants.filter(p => currentUserId === undefined || p.userId !== currentUserId)
	const other = others[0]

	if (others.length !== 1 || other === undefined) {
		return false
	}

	return isBlocked({ userId: other.userId, email: other.email }, blocked)
}

// List-membership policy filter, applied BEFORE search and kept as its own pass (mobile does the same):
// the sidebar reuses this post-block list for its stale-selection purge, and folding the rule into
// filterChats would apply the search filter to that purge too.
export function chatsWithoutBlockedOneOnOne(
	chats: readonly Chat[],
	currentUserId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): Chat[] {
	return chats.filter(chat => !isOneOnOneWithBlocked(chat, currentUserId, blocked))
}

// Uuids of currently-selected chats no longer present in a live chat set — chatsSidebar.tsx's own
// stale-selection purge uses this to drop a selection ghost the instant a conversationDeleted/
// conversationParticipantLeft socket event (or another tab's delete/leave) removes a chat out from
// under an active multi-selection. Takes the live set as UUIDS, not chats, so the caller's effect can
// read them straight back out of the uuid signature it is keyed on (drive's hiddenSelectionUuids
// does the same).
export function staleChatSelectionUuids(selectedChats: readonly Chat[], liveUuids: readonly string[]): string[] {
	const live = new Set(liveUuids)

	return selectedChats.filter(chat => !live.has(chat.uuid)).map(chat => chat.uuid)
}
