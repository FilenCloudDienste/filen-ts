import type { ChatMessage } from "@filen/sdk-rs"
import { isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"
import { messageSenderName } from "@/features/chats/lib/sort"

// Thread row model + scroll math — PURE, no React, unit-tested.
//
// DENSE GROUPED FLAT ROWS. Messages ascend (oldest first, newest last — the query
// cache's own order). Consecutive messages from the SAME sender within a 2-minute window collapse into one
// visual burst: the first row carries the avatar + name + timestamp header, subsequent rows in the burst
// render indented with no repeated header. A day boundary or a sender change always starts a new burst
// (and the day boundary also emits a separator row). Mirrors old-web's `isTimestampSameMinute` (a 2-minute
// window, not a literal same-minute) + `isTimestampSameDay` grouping.

// Old-web's window: two timestamps group if within 2 minutes of each other.
const BURST_WINDOW_MS = 120_000

// A stable key for the (at most one) unread-divider row a chat can render.
const UNREAD_DIVIDER_KEY = "unread-divider"

export type ThreadRow =
	| { kind: "day"; key: string; timestamp: bigint }
	| { kind: "unread"; key: typeof UNREAD_DIVIDER_KEY }
	| { kind: "message"; key: string; message: ChatMessage; showHeader: boolean }

// The "New" divider's placement: old-web's NewDivider guard (first message where `sentTimestamp >
// lastFocus && senderId !== self`, never re-inserted for a later qualifying message). senderId is
// `number` on the wasm surface — coerced with BigInt before comparing, same rule as unread.logic.ts.
// A blocked sender's message never qualifies: a red "New" marker for content the reader chose not to see
// would be its own leak. Not isMessageUnread — there is no Chat in hand here, and the divider deliberately
// ignores chat.muted (a muted conversation still shows where you left off).
function isFirstUnread(message: ChatMessage, lastFocus: bigint, currentUserId: bigint, blocked: BlockedUsers): boolean {
	if (message.sentTimestamp <= lastFocus || BigInt(message.senderId) === currentUserId) {
		return false
	}

	return !isBlocked({ userId: BigInt(message.senderId), email: message.senderEmail }, blocked)
}

function toDayNumber(timestamp: bigint): number {
	const date = new Date(Number(timestamp))

	// Local-calendar day index (not UTC) so separators land on the viewer's own midnight, matching how the
	// day label renders. Encodes Y/M/D into one comparable number.
	return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate()
}

// True when `current` continues `previous`'s burst: same sender AND within the 2-minute window AND the
// same calendar day. senderId is `number` on the wasm surface (not bigint) — compared directly here since
// both sides are the same field; self-detection elsewhere coerces to BigInt, this does not need to.
function continuesBurst(previous: ChatMessage, current: ChatMessage): boolean {
	if (previous.senderId !== current.senderId) {
		return false
	}

	if (toDayNumber(previous.sentTimestamp) !== toDayNumber(current.sentTimestamp)) {
		return false
	}

	const deltaMs = Number(current.sentTimestamp) - Number(previous.sentTimestamp)

	return deltaMs >= 0 && deltaMs <= BURST_WINDOW_MS
}

// Builds the interleaved day-separator + message row list from an ascending message array. A message row
// gets `showHeader: true` when it opens a burst (first overall, first after a day change, first after a
// sender change, or first after a >2min gap). Message rows key on the server uuid; day rows key on the day
// number so React reconciles stably across prepends (loading older pages).
//
// `unread`, when given, inserts a single `{kind:"unread"}` divider row immediately before the first
// message that qualifies (old-web's NewDivider placement/guard). Omitted entirely
// once `currentUserId` is unresolved (nothing to compare senderId against) or once the chat has no
// qualifying message at all — never renders past the first insertion.
//
// Deliberate divergence from mobile: mobile suppresses the divider for the whole session once the first
// qualifying message is from a blocked sender; the `unreadInserted` flag model here instead moves it
// forward onto the first non-blocked qualifying message. Intentional — do not "correct" it back.
export function buildThreadRows(
	messages: readonly ChatMessage[],
	unread?: { lastFocus: bigint; currentUserId: bigint; blocked?: BlockedUsers }
): ThreadRow[] {
	const rows: ThreadRow[] = []
	let previous: ChatMessage | undefined
	let previousDay: number | undefined
	let unreadInserted = false

	for (const message of messages) {
		const day = toDayNumber(message.sentTimestamp)

		if (day !== previousDay) {
			rows.push({ kind: "day", key: `day-${String(day)}`, timestamp: message.sentTimestamp })
			previousDay = day
		}

		if (
			!unreadInserted &&
			unread !== undefined &&
			isFirstUnread(message, unread.lastFocus, unread.currentUserId, unread.blocked ?? EMPTY_BLOCKED_USERS)
		) {
			rows.push({ kind: "unread", key: UNREAD_DIVIDER_KEY })
			unreadInserted = true
		}

		const showHeader = previous === undefined || !continuesBurst(previous, message)

		rows.push({ kind: "message", key: message.uuid, message, showHeader })
		previous = message
	}

	return rows
}

// Scroll-position preservation when older messages are PREPENDED. After a prepend the content above the
// viewport grows by (nextScrollHeight - prevScrollHeight); to keep the same messages under the user's eye
// the scrollTop must grow by that same delta. Returns the scrollTop to apply after the DOM has the taller
// content. Extracted pure so the (easy-to-get-wrong) arithmetic is unit-tested without a DOM.
export function computeScrollAfterPrepend(prevScrollHeight: number, prevScrollTop: number, nextScrollHeight: number): number {
	return prevScrollTop + (nextScrollHeight - prevScrollHeight)
}

// True once the scroll container's bottom edge is within `threshold` px of the content's true bottom —
// the "at bottom" test the scroll-to-bottom affordance and the jump-on-own-send behavior both key off.
export function isScrollNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold: number): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold
}

// Counts messages newly appended at the TAIL between two ascending snapshots of the same chat. Raw
// length growth can't distinguish a real arrival (appends past the last message) from an older-history
// prepend (loadOlderChatMessages grows the HEAD, leaving the tail untouched) — both grow `.length`.
// Walking backward from `next`'s end to find `previous`'s last message pinpoints exactly how many rows
// landed after it; a pure prepend finds it still last (0), a real arrival finds it short of the end (>0).
// Returns 0 (never guesses) when there's no prior snapshot or the prior last message is gone from `next`
// (e.g. a delete) — those aren't "new arrivals" this affordance should badge.
export function countNewTailMessages(previous: readonly ChatMessage[], next: readonly ChatMessage[]): number {
	const previousLast = previous[previous.length - 1]

	if (previousLast === undefined || next.length === 0) {
		return 0
	}

	for (let i = next.length - 1; i >= 0; i--) {
		if (next[i]?.uuid === previousLast.uuid) {
			return next.length - 1 - i
		}
	}

	return 0
}

// Scroll-to-bottom affordance state (the floating pill that appears once the user has scrolled up AND a
// new message has landed below the viewport — mobile's FAB re-imagined with old-web's "new since" count,
// in-app-only). PURE reducer over two event kinds so the count-while-scrolled-up / clear-on-bottom
// rules are unit-testable without a DOM: a `scroll` event resolves the current bottom-proximity (clearing
// the count the instant the user reaches bottom, whether by the pill or by their own scrolling); a
// `messagesArrived` event only grows the count while NOT at bottom — while at bottom the thread is already
// visibly showing new messages, so there is nothing to badge.
export interface ScrollAffordanceState {
	atBottom: boolean
	unseenCount: number
}

export const INITIAL_SCROLL_AFFORDANCE: ScrollAffordanceState = { atBottom: true, unseenCount: 0 }

export type ScrollAffordanceEvent = { kind: "scroll"; atBottom: boolean } | { kind: "messagesArrived"; count: number }

export function nextScrollAffordanceState(prev: ScrollAffordanceState, event: ScrollAffordanceEvent): ScrollAffordanceState {
	if (event.kind === "scroll") {
		if (event.atBottom) {
			return INITIAL_SCROLL_AFFORDANCE
		}

		// Same reference for a value-identical state, so React's setState bailout can absorb it: this runs
		// from a raw onScroll handler, i.e. on every native scroll event while the user is scrolled up.
		return prev.atBottom ? { atBottom: false, unseenCount: prev.unseenCount } : prev
	}

	if (prev.atBottom || event.count <= 0) {
		return prev
	}

	return { atBottom: false, unseenCount: prev.unseenCount + event.count }
}

// The thread's screen-reader arrival announcement. `seq` is the entire re-announcement mechanism: it keys
// the live region's inner span, so a repeat arrival from the same sender remounts that child and AT speaks
// it again — an identical text node left in place would simply be skipped. `name` is null when the batch
// mixes senders: the count is announced alone rather than credited to one of them.
export interface ThreadAnnouncement {
	seq: number
	count: number
	name: string | null
}

export function nextAnnouncement(prev: ThreadAnnouncement | null, count: number, name: string | null): ThreadAnnouncement {
	return { seq: (prev?.seq ?? 0) + 1, count, name }
}

// What an arrival announces, derived from the whole tail slice that just landed rather than from its last
// message: a window-focus/reconnect refetch commits several messages in ONE cache write, and those can come
// from different senders — pairing the batch count with the last sender's name misattributes the rest.
// Self and blocked senders drop out of both the count and the name, so a batch whose last message is
// blocked still announces the others; the announcement channel is held to the same blocked policy as the
// visual surfaces, and it is the one channel with no visual equivalent to check against.
// null = nothing to announce. `currentUserId` unresolved makes self-detection impossible, so nothing is
// announced until it lands (own sends from another tab arrive as ordinary tail growth).
export function announcementSubject(
	messages: readonly ChatMessage[],
	newTailCount: number,
	currentUserId: bigint | undefined,
	blocked: BlockedUsers
): { count: number; name: string | null } | null {
	if (currentUserId === undefined || newTailCount <= 0) {
		return null
	}

	let count = 0
	let senderId: number | undefined
	let name: string | null = null

	for (const message of messages.slice(Math.max(0, messages.length - newTailCount))) {
		const messageSenderId = BigInt(message.senderId)

		if (messageSenderId === currentUserId || isBlocked({ userId: messageSenderId, email: message.senderEmail }, blocked)) {
			continue
		}

		count += 1

		if (count === 1) {
			senderId = message.senderId
			name = messageSenderName(message)
		} else if (message.senderId !== senderId) {
			name = null
		}
	}

	return count === 0 ? null : { count, name }
}
