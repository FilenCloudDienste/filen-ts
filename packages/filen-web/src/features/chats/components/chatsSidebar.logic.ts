import type { Chat } from "@filen/sdk-rs"
import { chatDisplayName, chatMessagePreview, isChatUndecryptable, isLastMessageFromBlocked } from "@/features/chats/lib/sort"
import { compareChats, isListedChat, isOneOnOneWithBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"
import { matchesContactSearch } from "@/features/contacts/components/contactsList.logic"
import { isGroupChat } from "@/features/chats/components/thread/thread.logic"

// The URL owns the selected conversation: /chats/<uuid> is a selection key. The sidebar renders in the app
// shell (outside the chats route match), so it reads the raw pathname rather than route params. Empty at
// bare "/chats" (nothing selected).
export function selectedChatUuidFromPath(pathname: string): string {
	const match = /^\/chats\/([^/]+)/.exec(pathname)

	return match?.[1] ?? ""
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
	// filter() copies, so the sort never touches the caller's array
	const sorted = chats.filter(chat => isListedChat(chat, currentUserId)).sort(compareChats)
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

		return chat.participants.some(p => matchesContactSearch(p, term))
	})
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

// The list's sections, in order: one-to-one conversations (and a conversation with nobody else left), then
// group conversations.
export type ChatSection = "direct" | "groups"

export const CHAT_SECTIONS: readonly ChatSection[] = ["direct", "groups"]

export function chatSection(chat: Chat): ChatSection {
	return isGroupChat(chat.participants.length) ? "groups" : "direct"
}

// One virtualized list item: a section header, or a conversation with its position in its section's listbox
// and its `index` in `chats`, the order selection ranges and the next/previous keys walk.
export type ChatListItem =
	| { kind: "header"; key: string; section: ChatSection; expanded: boolean }
	| { kind: "chat"; key: string; section: ChatSection; chat: Chat; index: number; posInSet: number; setSize: number }

export interface ChatList {
	items: ChatListItem[]
	// The conversations on screen, in list order: every section's, less the collapsed ones'.
	chats: Chat[]
	// Where the headers sit in `items`, so the virtualizer can keep them mounted: a section's listbox is
	// labelled by its header.
	headerIndexes: number[]
}

// Splits the sorted, filtered rows into their sections, each keeping that order (most recent activity
// first), and drops a collapsed section's rows. An empty section gets no header. While searching every
// section shows expanded, so no match is hidden behind a collapsed header.
export function buildChatList(rows: readonly Chat[], collapsed: Readonly<Record<ChatSection, boolean>>, searching: boolean): ChatList {
	const bySection: Record<ChatSection, Chat[]> = { direct: [], groups: [] }

	for (const chat of rows) {
		bySection[chatSection(chat)].push(chat)
	}

	const items: ChatListItem[] = []
	const chats: Chat[] = []
	const headerIndexes: number[] = []

	for (const section of CHAT_SECTIONS) {
		const members = bySection[section]

		if (members.length === 0) {
			continue
		}

		const expanded = searching || !collapsed[section]

		headerIndexes.push(items.length)
		items.push({ kind: "header", key: `section-${section}`, section, expanded })

		if (!expanded) {
			continue
		}

		members.forEach((chat, position) => {
			items.push({
				kind: "chat",
				key: chat.uuid,
				section,
				chat,
				index: chats.length,
				posInSet: position + 1,
				setSize: members.length
			})
			chats.push(chat)
		})
	}

	return { items, chats, headerIndexes }
}

// Uuids of currently-selected chats no longer present in a live chat set — chatsSidebar.tsx's own
// stale-selection purge uses this to drop a selection ghost the instant a conversationDeleted/
// conversationParticipantLeft socket event (or another tab's delete/leave) removes a chat out from
// under an active multi-selection. Takes the live set as UUIDS, not chats, so the caller's effect can
// read them straight back out of the uuid signature it is keyed on.
export function staleChatSelectionUuids(selectedChats: readonly Chat[], liveUuids: readonly string[]): string[] {
	const live = new Set(liveUuids)

	return selectedChats.filter(chat => !live.has(chat.uuid)).map(chat => chat.uuid)
}
