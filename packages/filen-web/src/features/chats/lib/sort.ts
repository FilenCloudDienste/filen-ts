import { fastLocaleCompare, parseNumbersFromString } from "@filen/utils"
import type { Chat } from "@filen/sdk-rs"

// Conversation-list ordering — ported from
// `filen-mobile/src/features/chats/components/list/index.tsx:36-45`, not a guess. There is no
// server-side re-sort and no separate "sort" SDK op — `listChats()`
// returns chats in whatever order the API gives them, and mobile re-sorts client-side, every
// render, by:
//   1. the chat's lastMessage.sentTimestamp descending (chats with no lastMessage sort as 0 — to
//      the bottom, alongside any other chat that has genuinely never had a message);
//   2. a tiebreak on `parseNumbersFromString(uuid)` descending when the timestamps are equal
//      (covers the common case of two chats that have never had a message, where the timestamp
//      tier alone would otherwise leave input order to decide, which is not stable across
//      refetches).
// Bigint-safe: sentTimestamp only ever gets Number()-converted for the comparator's arithmetic,
// exactly as mobile does (`Number(a.lastMessage.sentTimestamp)`) — timestamps sit nowhere near
// Number.MAX_SAFE_INTEGER, so no precision loss.
function chatSortTimestamp(chat: Chat): number {
	return chat.lastMessage ? Number(chat.lastMessage.sentTimestamp) : 0
}

function compareChats(a: Chat, b: Chat): number {
	const diff = chatSortTimestamp(b) - chatSortTimestamp(a)

	if (diff !== 0) {
		return diff
	}

	return parseNumbersFromString(b.uuid) - parseNumbersFromString(a.uuid)
}

// Returns a NEW array, never mutates the input.
export function sortChats(chats: readonly Chat[]): Chat[] {
	return [...chats].sort(compareChats)
}

// A chat's group key failing to decrypt (`Chat.key === undefined`) is this surface's
// undecryptable signal; there is no `.undecryptable`
// field on the wasm Chat the way mobile's own wrapper type adds one.
export function isChatUndecryptable(chat: Chat): boolean {
	return chat.key === undefined
}

// Display-name derivation for unnamed chats — ported from mobile's `chatDisplayName`
// (`lib/decryption.ts:44-69`): an explicit chat.name wins; a 1:1 (exactly one other participant)
// falls back to that participant's nickName-or-email; a group with no name joins every other
// participant's nickName-or-email, locale-sorted for a stable, readable order.
//
// Undecryptable-placeholder COPY (mobile's i18n `cannot_decrypt_${uuid}` string) lives in the
// component that renders chat rows (chatRow.tsx's `t("chatUndecryptable")`) — same posture
// notes/lib/sort.ts takes for noteDisplayTitle (falls back to the raw uuid, not a placeholder
// string, at this foundation layer).
export function chatDisplayName(chat: Chat, currentUserId: bigint, soloFallback: string): string {
	if (isChatUndecryptable(chat)) {
		return chat.uuid
	}

	if (chat.name && chat.name.length > 0) {
		return chat.name
	}

	const others = chat.participants.filter(p => p.userId !== currentUserId)

	// Every other participant left (the backend keeps a chat alive with only yourself in it) —
	// joining an empty list would render an empty title everywhere.
	if (others.length === 0) {
		return soloFallback
	}

	if (others.length === 1) {
		const other = others[0]

		if (other) {
			return other.nickName && other.nickName.length > 0 ? other.nickName : other.email
		}
	}

	const displayNames = others.map(p => (p.nickName && p.nickName.length > 0 ? p.nickName : p.email))

	return [...displayNames].sort(fastLocaleCompare).join(", ")
}

// Participant-derived avatar image (mobile's own rule, list/chat/index.tsx): the other participants sans
// self, keeping only a real http avatar URL. A 1:1 uses the other person's image; anything else has no
// single representative image and falls back to undefined (the caller renders the display-name initial).
// Shared by the sidebar row (chatRow.tsx) and the thread header (messageThread.tsx).
export function chatAvatarUrl(chat: Chat, currentUserId: bigint | undefined): string | undefined {
	const others = chat.participants.filter(p => p.userId !== currentUserId)

	if (others.length !== 1) {
		return undefined
	}

	const avatar = others[0]?.avatar

	return avatar?.startsWith("http") === true ? avatar : undefined
}

// lastMessage preview-line derivation — the "last-message" tier ONLY of mobile's full precedence
// (`typing > blocked > last-message > "no messages yet"`, list/chat/index.tsx). The typing tier is
// layered on top by the caller (chatRow.tsx's useChatTypingLabel, fed by the socket-driven typing
// store); "message from a blocked sender" needs the contacts blocking model cross-referenced —
// not yet implemented here. Returns null when there is no previewable text — the caller renders "no messages yet" for both
// "no lastMessage at all" and "lastMessage exists but is undecryptable" (mobile's own fallthrough:
// an undecryptable message has `message === undefined`, which this treats identically to absent).
export function chatMessagePreview(chat: Chat): string | null {
	if (!chat.lastMessage?.message) {
		return null
	}

	return chat.lastMessage.message
}
