import {
	parseNumbersFromString,
	EMPTY_BLOCKED_USERS,
	resolveChatParticipantsDisplayName,
	contactDisplayName,
	type BlockedUsers
} from "@filen/shared"
import type { Chat, ChatMessage, ChatMessagePartial, ChatParticipant } from "@filen/sdk-rs"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import { isSenderBlocked } from "@/features/chats/lib/sender"

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

// Oldest-first message order: send order and thread order both rest on it. Bigint-safe three-way compare.
export function compareBySentTimestamp(a: { sentTimestamp: bigint }, b: { sentTimestamp: bigint }): number {
	return a.sentTimestamp === b.sentTimestamp ? 0 : a.sentTimestamp < b.sentTimestamp ? -1 : 1
}

// The lastMessage a chat's row takes from `incoming`: never an older one than it already shows. A parked
// own echo, or a send's commit, can land after a reply did.
export function newestMessage(current: ChatMessage | undefined, incoming: ChatMessage): ChatMessage {
	return current !== undefined && incoming.sentTimestamp < current.sentTimestamp ? current : incoming
}

// A chat's group key failing to decrypt (`Chat.key === undefined`) is this surface's
// undecryptable signal; there is no `.undecryptable`
// field on the wasm Chat the way mobile's own wrapper type adds one.
export function isChatUndecryptable(chat: Chat): boolean {
	return chat.key === undefined
}

// Chat.ownerId is a single bigint on the Chat itself (unlike NoteParticipant's per-row isOwner flag). An
// unresolved viewer (account query not yet warm) is never the owner: undefined never equals a bigint.
export function isChatOwner(chat: Chat, userId: bigint | undefined): boolean {
	return chat.ownerId === userId
}

// The participants other than the viewer. Returns a new array.
export function otherParticipants(chat: Chat, userId: bigint | undefined): ChatParticipant[] {
	return chat.participants.filter(p => p.userId !== userId)
}

// Display-name derivation for unnamed chats: an explicit chat.name wins, else the other
// participant(s)' nickName-or-email via @filen/shared's resolveChatParticipantsDisplayName
// (shared with mobile's chatDisplayName, lib/decryption.ts).
//
// Undecryptable-placeholder COPY (mobile's i18n `cannot_decrypt_${uuid}` string) is passed in by the
// rendering components through chatTitle — same posture notes/lib/sort.ts takes for noteDisplayTitle
// (falls back to the raw uuid, not a placeholder string, at this foundation layer).
export function chatDisplayName(chat: Chat, currentUserId: bigint, soloFallback: string): string {
	if (isChatUndecryptable(chat)) {
		return chat.uuid
	}

	if (chat.name && chat.name.length > 0) {
		return chat.name
	}

	const others = otherParticipants(chat, currentUserId)

	return resolveChatParticipantsDisplayName(others, soloFallback)
}

// The title a chat renders under: the undecryptable placeholder, else the display name, else the uuid
// while the viewer is unresolved. Shared by the sidebar row and the thread header.
export function chatTitle(chat: Chat, currentUserId: bigint | undefined, undecryptableLabel: string, soloFallback: string): string {
	if (isChatUndecryptable(chat)) {
		return undecryptableLabel
	}

	return currentUserId !== undefined ? chatDisplayName(chat, currentUserId, soloFallback) : chat.uuid
}

// Participant-derived avatar image: the other participants sans self, keeping only a real avatar URL. A
// 1:1 uses the other person's image; anything else has no single representative image and falls back to
// undefined (the caller renders the display-name initial).
// Shared by the sidebar row (chatRow.tsx) and the thread header (messageThread.tsx).
export function chatAvatarUrl(chat: Chat, currentUserId: bigint | undefined): string | undefined {
	const others = otherParticipants(chat, currentUserId)

	if (others.length !== 1) {
		return undefined
	}

	return safeAvatarUrl(others[0]?.avatar)
}

// lastMessage preview-line derivation — the "last-message" tier ONLY of the full precedence
// (`typing > blocked > last-message > "no messages yet"`). chatPreviewTier below decides which tier
// wins; chatRow.tsx renders the copy for it. Returns null when there is no previewable text — the caller
// renders "no messages yet" for both "no lastMessage at all" and "lastMessage exists but is
// undecryptable" (mobile's own fallthrough: an undecryptable message has `message === undefined`, which
// this treats identically to absent).
export function chatMessagePreview(chat: Chat): string | null {
	if (!chat.lastMessage?.message) {
		return null
	}

	return chat.lastMessage.message
}

// Sender display name for a message, from its denormalized sender fields. Messages carry those fields
// inline rather than a contact record (so a sender who has since left still renders correctly), hence the
// adapter — the nickname-wins-over-email RULE itself stays in contactDisplayName, its single home.
export function messageSenderName(message: ChatMessagePartial): string {
	return contactDisplayName({ email: message.senderEmail, nickName: message.senderNickName })
}

// Whether a chat's last message came from a blocked sender.
export function isLastMessageFromBlocked(chat: Chat, blocked: BlockedUsers): boolean {
	const lastMessage = chat.lastMessage

	if (!lastMessage) {
		return false
	}

	return isSenderBlocked(lastMessage, blocked)
}

// Which of the four mutually exclusive preview tiers a conversation row renders. Decided here rather than
// as a chain of expressions in the row so the precedence is unit-testable: `typingLabel` and
// chatMessagePreview are both `string | null`, and a comparison loosened against the wrong nullish value
// silently pins a tier off forever while the surface still looks plausible.
//
// Deliberate divergence from mobile: "blocked" outranks the message tier and ignores whether the last
// message decrypted, so an undecryptable message from a blocked sender still previews as hidden rather
// than falling through to "no messages yet" — the fallthrough would leak that decryption failed as a
// separate signal.
export type ChatPreviewTier = "typing" | "blocked" | "message" | "empty"

export function chatPreviewTier(chat: Chat, typingLabel: string | null, blocked: BlockedUsers = EMPTY_BLOCKED_USERS): ChatPreviewTier {
	if (typingLabel !== null) {
		return "typing"
	}

	if (isLastMessageFromBlocked(chat, blocked)) {
		return "blocked"
	}

	return chatMessagePreview(chat) !== null ? "message" : "empty"
}
