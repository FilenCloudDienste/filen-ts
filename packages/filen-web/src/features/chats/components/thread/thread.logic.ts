import type { ChatMessage } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"
import { messageSenderName } from "@/features/chats/lib/sort"
import { dayNumber } from "@/features/chats/lib/time"
import { isOwnMessage, isSenderBlocked } from "@/features/chats/lib/sender"

// Thread row model + scroll math — PURE, no React, unit-tested.
//
// BUBBLE RUNS. Messages ascend (oldest first, newest last — the query cache's own order). Consecutive
// messages from the SAME sender, on the same day and within a 2-minute window of each other form one run:
// bubbles inside a run sit close together, only the run's newest bubble carries the tail (and, in a group
// chat, the sender's avatar), and only its oldest carries the sender's name. Mirrors old-web's
// `isTimestampSameMinute` (a 2-minute window, not a literal same-minute) + same-day grouping (`dayNumber`,
// shared with the time-header label). A time header row opens every day and every stretch after a quiet
// hour; both always break the run.

// Old-web's window: two timestamps group if within 2 minutes of each other.
const BURST_WINDOW_MS = 120_000

// A gap this long between two messages on the same day earns its own time header.
const TIME_HEADER_GAP_MS = 60 * 60_000

// A stable key for the (at most one) unread-divider row a chat can render.
const UNREAD_DIVIDER_KEY = "unread-divider"

// A message row's place in its run: `runStart` = oldest bubble (carries the group-chat name), `runEnd` =
// newest bubble (carries the tail and the group-chat avatar). A lone message is both.
export interface ThreadMessageRow {
	kind: "message"
	key: string
	message: ChatMessage
	runStart: boolean
	runEnd: boolean
}

export type ThreadRow =
	{ kind: "time"; key: string; timestamp: bigint } | { kind: "unread"; key: typeof UNREAD_DIVIDER_KEY } | ThreadMessageRow

// Virtualizer estimates: each kind's real one-line height, so most rows measure in without changing the
// total size (a size change mid-scroll cancels Chromium's animated keyboard scroll). Measured on the row
// wrappers, identical in Chromium, Firefox and WebKit: time header 32, unread divider 36, run start 42 (a
// blocked sender's tombstone too), run continuation 34, named group run start 60.
export const TIME_ROW_ESTIMATE = 32
export const UNREAD_ROW_ESTIMATE = 36
// A run's first bubble: the 10px run gap + a 32px one-line bubble.
export const RUN_START_ROW_ESTIMATE = 42
// A bubble continuing a run: the 2px in-run gap + the bubble.
export const RUN_CONTINUATION_ROW_ESTIMATE = 34
// A group chat's run from someone else opens with the sender's name above its first bubble.
export const RUN_START_NAMED_ROW_ESTIMATE = 60

// A group chat (more than two participants) names and pictures the senders of other people's runs; a 1:1
// needs neither.
export function isGroupChat(participantCount: number): boolean {
	return participantCount > 2
}

// Whether a message row shows its sender's name above the bubble: the oldest bubble of someone else's run
// in a group chat.
export function showsSenderName(runStart: boolean, own: boolean, group: boolean): boolean {
	return group && !own && runStart
}

// A blocked sender's row estimates as its tombstone, which carries no name: hidden is how it first renders.
export function estimateThreadRowSize(
	row: ThreadRow | undefined,
	currentUserId: bigint | undefined,
	group: boolean,
	blocked: BlockedUsers
): number {
	if (row === undefined || row.kind === "time") {
		return TIME_ROW_ESTIMATE
	}

	if (row.kind === "unread") {
		return UNREAD_ROW_ESTIMATE
	}

	if (!row.runStart) {
		return RUN_CONTINUATION_ROW_ESTIMATE
	}

	return showsSenderName(true, isOwnMessage(row.message, currentUserId), group) && !isSenderBlocked(row.message, blocked)
		? RUN_START_NAMED_ROW_ESTIMATE
		: RUN_START_ROW_ESTIMATE
}

// The "New" divider's placement: old-web's NewDivider guard (first message where `sentTimestamp >
// lastFocus && senderId !== self`, never re-inserted for a later qualifying message).
// A blocked sender's message never qualifies: a red "New" marker for content the reader chose not to see
// would be its own leak. Not isMessageUnread — there is no Chat in hand here, and the divider deliberately
// ignores chat.muted (a muted conversation still shows where you left off).
function isFirstUnread(message: ChatMessage, lastFocus: bigint, currentUserId: bigint, blocked: BlockedUsers): boolean {
	if (message.sentTimestamp <= lastFocus || isOwnMessage(message, currentUserId)) {
		return false
	}

	return !isSenderBlocked(message, blocked)
}

// True when `current` continues `previous`'s run: same sender AND within the 2-minute window AND the same
// calendar day. senderId is `number` on the wasm surface (not bigint) — compared directly here since both
// sides are the same field; self-detection elsewhere coerces to BigInt, this does not need to.
function continuesBurst(previous: ChatMessage, previousDay: number, current: ChatMessage, day: number): boolean {
	if (previous.senderId !== current.senderId || previousDay !== day) {
		return false
	}

	const deltaMs = Number(current.sentTimestamp) - Number(previous.sentTimestamp)

	return deltaMs >= 0 && deltaMs <= BURST_WINDOW_MS
}

// Builds the interleaved time-header + unread-divider + message row list from an ascending message array.
// A time header precedes the first message of each calendar day (keyed on the day number, so React and the
// virtualizer keep it stable when older pages prepend and it moves up to a new first message) and any
// message sent an hour or more after the one before it (keyed on that message). Message rows key on the
// server uuid.
//
// `unread`, when given, inserts a single `{kind:"unread"}` divider row immediately before the first
// message that qualifies (old-web's NewDivider placement/guard), and that message opens a new run. Omitted
// entirely once `currentUserId` is unresolved (nothing to compare senderId against) or once the chat has no
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
	let previousRow: ThreadMessageRow | undefined
	let previousDay: number | undefined
	let unreadInserted = false

	for (const message of messages) {
		const day = dayNumber(new Date(Number(message.sentTimestamp)))
		const previous = previousRow?.message
		let runStart = previous === undefined || previousDay === undefined || !continuesBurst(previous, previousDay, message, day)

		if (day !== previousDay) {
			rows.push({ kind: "time", key: `day-${String(day)}`, timestamp: message.sentTimestamp })
		} else if (previous !== undefined && Number(message.sentTimestamp) - Number(previous.sentTimestamp) >= TIME_HEADER_GAP_MS) {
			rows.push({ kind: "time", key: `gap-${message.uuid}`, timestamp: message.sentTimestamp })
		}

		if (
			!unreadInserted &&
			unread !== undefined &&
			isFirstUnread(message, unread.lastFocus, unread.currentUserId, unread.blocked ?? EMPTY_BLOCKED_USERS)
		) {
			rows.push({ kind: "unread", key: UNREAD_DIVIDER_KEY })
			unreadInserted = true
			runStart = true
		}

		// A row's runEnd is settled by the next message: it stays true unless that one continues the run.
		if (!runStart && previousRow !== undefined) {
			previousRow.runEnd = false
		}

		const row: ThreadMessageRow = { kind: "message", key: message.uuid, message, runStart, runEnd: true }

		rows.push(row)
		previousRow = row
		previousDay = day
	}

	return rows
}

// The thread renders bottom-up: index 0 is the newest row, so a virtualizer laid out from the scroller's
// bottom edge keeps its offsets stable when older pages land at the other end. Time headers and the
// unread divider precede their message in `buildThreadRows`' ascending order, so here they follow it,
// which is still directly above it on screen.
export function toBottomUpRows(rows: readonly ThreadRow[]): ThreadRow[] {
	return rows.toReversed()
}

// Scroll geometry of a `flex-direction: column-reverse` scroller. Its scroll origin is the bottom edge:
// scrollTop is 0 there and negative going up, in Chromium, Firefox and WebKit alike. Clamped at 0 so
// WebKit's rubber-band overscroll past the bottom (a positive scrollTop) reads as the bottom itself.
export function scrollDistanceFromBottom(scrollTop: number): number {
	return Math.max(0, 0 - scrollTop)
}

export function scrollDistanceFromTop(scrollTop: number, scrollHeight: number, clientHeight: number): number {
	return scrollHeight - clientHeight - scrollDistanceFromBottom(scrollTop)
}

// The "at bottom" test the scroll-to-bottom affordance and tail-following both key off.
export function isScrollNearBottom(scrollTop: number, threshold: number): boolean {
	return scrollDistanceFromBottom(scrollTop) <= threshold
}

export function isScrollNearTop(scrollTop: number, scrollHeight: number, clientHeight: number, threshold: number): boolean {
	return scrollDistanceFromTop(scrollTop, scrollHeight, clientHeight) <= threshold
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
		if (isOwnMessage(message, currentUserId) || isSenderBlocked(message, blocked)) {
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
