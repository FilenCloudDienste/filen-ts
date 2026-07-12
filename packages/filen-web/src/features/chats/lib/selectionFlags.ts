import type { Chat } from "@filen/sdk-rs"
import { isChatOwner } from "@/features/chats/lib/actions"
import { isChatUndecryptable } from "@/features/chats/lib/sort"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"

// Aggregated flags for a Chats-list multi-selection, computed in a single pass — the bulk-action bar's
// only source of gating truth. Mirrors features/notes/lib/selectionFlags.ts's own
// NoteSelectionFlags/aggregateNoteSelectionFlags shape, sized down to what a Chat (unlike a Note) needs:
// there is no archive/trash lifecycle, no per-participant write-permission concept, and ownership is a
// single `ownerId` field rather than a per-participant flag.
export interface ChatSelectionFlags {
	count: number
	// True iff ANY selected chat is currently muted — gates the bulk mute/unmute button's SET-semantics
	// label (mirrors notes' includesPinned/includesFavorited: the button drives the WHOLE selection to
	// the opposite of this, not each chat's own individual state).
	includesMuted: boolean
	// True iff any selected chat's group key never decrypted. Suppresses markRead/mute — both need
	// decrypted state a placeholder chat doesn't have (mirrors chatMenuActions' own undecryptable
	// branch, which drops everything except Delete/Leave for a single such chat).
	includesUndecryptable: boolean
	// True iff any selected chat has at least one unread message reachable from this account (same
	// predicate chatMenuActions' own per-row "Mark as read" entry uses). Gates the bulk markRead button.
	includesUnread: boolean
	// True iff the current user owns every selected chat. Gates bulk Delete.
	everyOwned: boolean
	// True iff the current user owns NONE of the selected chats. Gates bulk Leave — the complement of
	// everyOwned rather than its own participant lookup: every chat a user can see in their own list
	// already has them as a participant, so "not the owner" alone is the same gate chatMenuActions'
	// per-row branch uses (`owner ? DELETE_CHAT : LEAVE_CHAT`).
	noneOwned: boolean
}

const EMPTY_CHAT_SELECTION_FLAGS: ChatSelectionFlags = Object.freeze({
	count: 0,
	includesMuted: false,
	includesUndecryptable: false,
	includesUnread: false,
	everyOwned: false,
	noneOwned: false
})

export function aggregateChatSelectionFlags(
	chats: readonly Chat[],
	currentUserId: bigint | undefined,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
): ChatSelectionFlags {
	if (chats.length === 0 || currentUserId === undefined) {
		return EMPTY_CHAT_SELECTION_FLAGS
	}

	let includesMuted = false
	let includesUndecryptable = false
	let includesUnread = false
	let everyOwned = true
	let noneOwned = true

	for (const chat of chats) {
		if (chat.muted) {
			includesMuted = true
		}

		if (isChatUndecryptable(chat)) {
			includesUndecryptable = true
		}

		if (chatHasUnread(chat, currentUserId, blocked)) {
			includesUnread = true
		}

		const owner = isChatOwner(chat, currentUserId)

		if (!owner) {
			everyOwned = false
		}

		if (owner) {
			noneOwned = false
		}
	}

	return { count: chats.length, includesMuted, includesUndecryptable, includesUnread, everyOwned, noneOwned }
}

// The set a "select all" builds from — every currently-visible chat except the undecryptable ones (a
// ghost row that can never be acted on shouldn't inflate the selection count), mirroring notes'
// selectableNotesForSelectAll / drive's own select-all exclusion. Delete/Leave can still target an
// undecryptable chat through a manual Ctrl/Cmd-click; only the bulk "select everything visible"
// shortcut leaves it out.
export function selectableChatsForSelectAll(chats: readonly Chat[]): Chat[] {
	return chats.filter(chat => !isChatUndecryptable(chat))
}
