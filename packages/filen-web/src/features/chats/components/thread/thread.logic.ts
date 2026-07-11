import type { ChatMessage } from "@filen/sdk-rs"

// Thread row model + scroll math — PURE, no React, unit-tested.
//
// D3 (founder decision): DENSE GROUPED FLAT ROWS. Messages ascend (oldest first, newest last — the query
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
function isFirstUnread(message: ChatMessage, lastFocus: bigint, currentUserId: bigint): boolean {
	return message.sentTimestamp > lastFocus && BigInt(message.senderId) !== currentUserId
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
// message that qualifies (old-web's NewDivider placement/guard — §00-SYNTHESIS.md 1b). Omitted entirely
// once `currentUserId` is unresolved (nothing to compare senderId against) or once the chat has no
// qualifying message at all — never renders past the first insertion.
export function buildThreadRows(messages: readonly ChatMessage[], unread?: { lastFocus: bigint; currentUserId: bigint }): ThreadRow[] {
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

		if (!unreadInserted && unread !== undefined && isFirstUnread(message, unread.lastFocus, unread.currentUserId)) {
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

// Scroll-to-bottom affordance state (the floating pill that appears once the user has scrolled up AND a
// new message has landed below the viewport — mobile's FAB re-imagined with old-web's "new since" count,
// D4 in-app-only). PURE reducer over two event kinds so the count-while-scrolled-up / clear-on-bottom
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
		return event.atBottom ? INITIAL_SCROLL_AFFORDANCE : { atBottom: false, unseenCount: prev.unseenCount }
	}

	if (prev.atBottom || event.count <= 0) {
		return prev
	}

	return { atBottom: false, unseenCount: prev.unseenCount + event.count }
}
