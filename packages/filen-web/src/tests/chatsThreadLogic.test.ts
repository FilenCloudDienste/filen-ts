import { describe, expect, it } from "vitest"
import type { BlockedContact, ChatMessage } from "@filen/sdk-rs"
import {
	announcementSubject,
	buildThreadRows,
	countNewTailMessages,
	isScrollNearBottom,
	isScrollNearTop,
	scrollDistanceFromBottom,
	scrollDistanceFromTop,
	toBottomUpRows,
	estimateThreadRowSize,
	isGroupChat,
	TIME_ROW_ESTIMATE,
	UNREAD_ROW_ESTIMATE,
	RUN_START_ROW_ESTIMATE,
	RUN_CONTINUATION_ROW_ESTIMATE,
	RUN_START_NAMED_ROW_ESTIMATE,
	nextAnnouncement,
	nextScrollAffordanceState,
	INITIAL_SCROLL_AFFORDANCE,
	type ThreadRow,
	type ThreadMessageRow,
	type ScrollAffordanceState
} from "@/features/chats/components/thread/thread.logic"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { testUuid } from "@/tests/support/uuid"

// Local-calendar timestamp so the day-boundary tests are deterministic regardless of the runner's TZ
// (buildThreadRows uses local getFullYear/Month/Date, matching how the time-header label renders).
function ts(year: number, month: number, day: number, hour: number, minute: number): bigint {
	return BigInt(new Date(year, month - 1, day, hour, minute, 0, 0).getTime())
}

function mockBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: testUuid("blocked"),
		userId: 3n,
		email: "blocked@x.io",
		nickName: "",
		timestamp: 0n,
		...overrides
	}
}

let counter = 0

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	counter += 1

	return {
		uuid: testUuid(`msg${String(counter)}`),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		message: "hi",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: ts(2021, 1, 1, 12, 0),
		...overrides
	}
}

function runFlags(rows: ThreadRow[]): { key: string; runStart: boolean; runEnd: boolean }[] {
	return rows
		.filter((r): r is ThreadMessageRow => r.kind === "message")
		.map(r => ({ key: r.key, runStart: r.runStart, runEnd: r.runEnd }))
}

describe("buildThreadRows — bubble runs", () => {
	it("emits a leading time header and a lone message that both opens and closes its run", () => {
		const m = mockMessage()
		const rows = buildThreadRows([m])

		expect(rows[0]?.kind).toBe("time")
		expect(runFlags(rows)).toEqual([{ key: m.uuid, runStart: true, runEnd: true }])
	})

	it("runs consecutive same-sender messages within 2 minutes: the tail only on the newest", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 1) })
		const c = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 2) })
		const rows = buildThreadRows([a, b, c])

		expect(runFlags(rows)).toEqual([
			{ key: a.uuid, runStart: true, runEnd: false },
			{ key: b.uuid, runStart: false, runEnd: false },
			{ key: c.uuid, runStart: false, runEnd: true }
		])
	})

	it("starts a new run when the sender changes", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 1, 12, 1) })
		const rows = buildThreadRows([a, b])

		expect(runFlags(rows)).toEqual([
			{ key: a.uuid, runStart: true, runEnd: true },
			{ key: b.uuid, runStart: true, runEnd: true }
		])
	})

	it("starts a new run when the gap exceeds 2 minutes, without a time header under an hour", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 3) })
		const rows = buildThreadRows([a, b])

		expect(rows.map(r => r.kind)).toEqual(["time", "message", "message"])
		expect(runFlags(rows)).toEqual([
			{ key: a.uuid, runStart: true, runEnd: true },
			{ key: b.uuid, runStart: true, runEnd: true }
		])
	})

	it("emits a time header keyed on the message after a quiet hour on the same day", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 59) })
		const c = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 13, 59) })
		const rows = buildThreadRows([a, b, c])

		expect(rows.map(r => r.key)).toEqual([rows[0]?.key, a.uuid, b.uuid, `gap-${c.uuid}`, c.uuid])
		expect(rows[3]).toMatchObject({ kind: "time", timestamp: c.sentTimestamp })
	})

	it("emits a time header and starts a run at a calendar-day boundary", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 23, 59) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 2, 0, 0) })
		const rows = buildThreadRows([a, b])

		expect(rows.map(r => r.kind)).toEqual(["time", "message", "time", "message"])
		expect(runFlags(rows)).toEqual([
			{ key: a.uuid, runStart: true, runEnd: true },
			{ key: b.uuid, runStart: true, runEnd: true }
		])
	})

	// Loading an older page moves a day's first message; its header must keep its key so the virtualizer
	// and React reuse the row rather than remounting it.
	it("keys a day's header on the day, stable when older messages of that day prepend", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 10, 0) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })

		expect(buildThreadRows([b])[0]?.key).toBe(buildThreadRows([a, b])[0]?.key)
	})

	it("breaks a run at the unread divider", () => {
		const a = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 1, 12, 1) })
		const rows = buildThreadRows([a, b], { lastFocus: a.sentTimestamp, currentUserId: 1n })

		expect(rows.map(r => r.kind)).toEqual(["time", "message", "unread", "message"])
		expect(runFlags(rows)).toEqual([
			{ key: a.uuid, runStart: true, runEnd: true },
			{ key: b.uuid, runStart: true, runEnd: true }
		])
	})
})

describe("estimateThreadRowSize", () => {
	const own = mockMessage({ senderId: 1 })
	const other = mockMessage({ senderId: 2 })

	function messageRow(message: ChatMessage, runStart: boolean): ThreadRow {
		return { kind: "message", key: message.uuid, message, runStart, runEnd: true }
	}

	it("sizes headers, the divider and bubbles by kind", () => {
		expect(estimateThreadRowSize({ kind: "time", key: "t", timestamp: 0n }, 1n, false, EMPTY_BLOCKED_USERS)).toBe(TIME_ROW_ESTIMATE)
		expect(estimateThreadRowSize({ kind: "unread", key: "unread-divider" }, 1n, false, EMPTY_BLOCKED_USERS)).toBe(UNREAD_ROW_ESTIMATE)
		expect(estimateThreadRowSize(messageRow(other, true), 1n, false, EMPTY_BLOCKED_USERS)).toBe(RUN_START_ROW_ESTIMATE)
		expect(estimateThreadRowSize(messageRow(other, false), 1n, false, EMPTY_BLOCKED_USERS)).toBe(RUN_CONTINUATION_ROW_ESTIMATE)
	})

	it("adds the sender name only to the first bubble of someone else's run in a group", () => {
		expect(estimateThreadRowSize(messageRow(other, true), 1n, true, EMPTY_BLOCKED_USERS)).toBe(RUN_START_NAMED_ROW_ESTIMATE)
		expect(estimateThreadRowSize(messageRow(own, true), 1n, true, EMPTY_BLOCKED_USERS)).toBe(RUN_START_ROW_ESTIMATE)
		expect(estimateThreadRowSize(messageRow(other, false), 1n, true, EMPTY_BLOCKED_USERS)).toBe(RUN_CONTINUATION_ROW_ESTIMATE)
	})

	it("sizes a blocked sender's run start as its unnamed tombstone", () => {
		const blocked = deriveBlockedUsers([mockBlockedContact({ userId: 2n, email: "a@example.com" })])

		expect(estimateThreadRowSize(messageRow(other, true), 1n, true, blocked)).toBe(RUN_START_ROW_ESTIMATE)
	})

	it("treats more than two participants as a group", () => {
		expect(isGroupChat(2)).toBe(false)
		expect(isGroupChat(3)).toBe(true)
	})
})

describe("toBottomUpRows", () => {
	it("puts the newest message at index 0 and each header right after the message it heads", () => {
		const lastFocus = ts(2021, 1, 2, 8, 0)
		const a = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 2, 12, 0) })
		const c = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 2, 12, 1) })

		const rows = toBottomUpRows(buildThreadRows([a, b, c], { lastFocus, currentUserId: 1n }))

		expect(rows.map(row => row.kind)).toEqual(["message", "message", "unread", "time", "message", "time"])
		expect(runFlags(rows).map(row => row.key)).toEqual([c.uuid, b.uuid, a.uuid])
	})

	it("leaves the ascending input untouched", () => {
		const rows = buildThreadRows([mockMessage(), mockMessage()])
		const keys = rows.map(row => row.key)

		toBottomUpRows(rows)

		expect(rows.map(row => row.key)).toEqual(keys)
	})
})

describe("buildThreadRows — unread divider (old-web NewDivider placement/guard)", () => {
	const SELF = 1
	const OTHER = 2

	it("inserts no divider when everything is our own message", () => {
		const a = mockMessage({ senderId: SELF, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const rows = buildThreadRows([a], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF) })

		expect(rows.some(r => r.kind === "unread")).toBe(false)
	})

	it("inserts no divider when every foreign message is already at/before lastFocus", () => {
		const a = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const rows = buildThreadRows([a], { lastFocus: ts(2021, 1, 1, 12, 0), currentUserId: BigInt(SELF) })

		expect(rows.some(r => r.kind === "unread")).toBe(false)
	})

	it("places the divider immediately before the FIRST foreign message newer than lastFocus", () => {
		const a = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 0) }) // read
		const b = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 5) }) // unread — first
		const c = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 6) }) // unread — later
		const rows = buildThreadRows([a, b, c], { lastFocus: ts(2021, 1, 1, 12, 1), currentUserId: BigInt(SELF) })

		const kinds = rows.map(r => (r.kind === "message" ? r.key : r.kind))
		expect(kinds).toEqual(["time", a.uuid, "unread", b.uuid, c.uuid])
	})

	it("never inserts a second divider even with multiple qualifying messages", () => {
		const a = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 1) })
		const rows = buildThreadRows([a, b], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF) })

		expect(rows.filter(r => r.kind === "unread")).toHaveLength(1)
	})

	it("omits the divider entirely when `unread` is not provided (currentUserId unresolved)", () => {
		const a = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const rows = buildThreadRows([a])

		expect(rows.some(r => r.kind === "unread")).toBe(false)
	})

	// The "mark-read trigger matrix" (spec item 1): the divider's own click handler is a two-line
	// delegation to lib/actions.ts's markChatRead (covered end-to-end in chatsActions.test.ts — fires
	// markChatRead + updateLastChatFocusTimesNow together, then upserts the refreshed chat into the
	// chats-list cache). This proves the OTHER half of that wiring: once the cache's chat.lastFocus
	// reflects the post-mark-read value, buildThreadRows — reading that same lastFocus on the next
	// render — stops qualifying the message, so the divider disappears without any local dismiss state.
	// Send-triggered mark-read (sync.ts's post-commit Promise.allSettled) is covered in
	// chatsSync.test.ts; menu-triggered mark-read in chatMenu.test.ts. Divider-triggered mark-read is
	// this test, completing the matrix.
	it("mark-read trigger matrix: the divider clears once lastFocus advances past the message it marked", () => {
		const a = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const beforeMarkRead = buildThreadRows([a], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF) })
		expect(beforeMarkRead.some(r => r.kind === "unread")).toBe(true)

		// markChatRead's cache patch (chatsQueryUpsert) advances chat.lastFocus to >= the message's own
		// timestamp — simulated here directly on the same messages array.
		const afterMarkRead = buildThreadRows([a], { lastFocus: a.sentTimestamp, currentUserId: BigInt(SELF) })
		expect(afterMarkRead.some(r => r.kind === "unread")).toBe(false)
	})

	const BLOCKED = 3
	const blockedUsers = deriveBlockedUsers([mockBlockedContact({ userId: BigInt(BLOCKED), email: "blocked@x.io" })])

	it("still inserts the divider before a qualifying message from a non-blocked sender", () => {
		const a = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const rows = buildThreadRows([a], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF), blocked: blockedUsers })

		expect(rows.some(r => r.kind === "unread")).toBe(true)
	})

	it("inserts no divider when the only qualifying message is from a blocked sender", () => {
		const a = mockMessage({ senderId: BLOCKED, senderEmail: "blocked@x.io", sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const rows = buildThreadRows([a], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF), blocked: blockedUsers })

		expect(rows.some(r => r.kind === "unread")).toBe(false)
	})

	// Deliberate divergence from mobile (which suppresses the divider for the whole session instead).
	it("moves the divider forward onto the first NON-blocked qualifying message", () => {
		const a = mockMessage({ senderId: BLOCKED, senderEmail: "blocked@x.io", sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: OTHER, sentTimestamp: ts(2021, 1, 1, 12, 5) })
		const rows = buildThreadRows([a, b], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF), blocked: blockedUsers })

		const kinds = rows.map(r => (r.kind === "message" ? r.key : r.kind))
		expect(kinds).toEqual(["time", a.uuid, "unread", b.uuid])
	})

	it("behaves exactly as before when `blocked` is omitted (fail-open)", () => {
		const a = mockMessage({ senderId: BLOCKED, senderEmail: "blocked@x.io", sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const rows = buildThreadRows([a], { lastFocus: ts(2021, 1, 1, 11, 0), currentUserId: BigInt(SELF) })

		expect(rows.some(r => r.kind === "unread")).toBe(true)
	})
})

describe("nextAnnouncement", () => {
	it("starts at seq 1 and carries count/name through", () => {
		expect(nextAnnouncement(null, 2, "Zoe")).toEqual({ seq: 1, count: 2, name: "Zoe" })
	})

	// The monotonic seq is the whole re-announcement mechanism — it keys the live region's inner span, so
	// an identical repeat arrival still remounts that child.
	it("bumps seq on a second arrival from the same sender", () => {
		const first = nextAnnouncement(null, 1, "Zoe")

		expect(nextAnnouncement(first, 1, "Zoe").seq).toBe(2)
	})

	it("replaces count rather than accumulating it", () => {
		const first = nextAnnouncement(null, 3, "Zoe")

		expect(nextAnnouncement(first, 1, "Zoe").count).toBe(1)
	})
})

// A refetch commits a whole batch in one cache write, so the subject must come from the arrived SLICE —
// deriving it from the last message alone misattributes the rest and lets one blocked/self tail message
// silence everyone else in the batch.
describe("announcementSubject", () => {
	const SELF = 1
	const BLOCKED = 3
	const blockedUsers = deriveBlockedUsers([mockBlockedContact({ userId: BigInt(BLOCKED), email: "blocked@x.io" })])

	it("names the single sender of a uniform batch", () => {
		const older = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })
		const a = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })
		const b = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })

		expect(announcementSubject([older, a, b], 2, BigInt(SELF), blockedUsers)).toEqual({ count: 2, name: "alice@x.io" })
	})

	it("prefers the sender's nickname, like every other name surface", () => {
		const a = mockMessage({ senderId: 2, senderEmail: "alice@x.io", senderNickName: "Alice" })

		expect(announcementSubject([a], 1, BigInt(SELF), blockedUsers)?.name).toBe("Alice")
	})

	it("drops the name when the batch mixes senders instead of crediting the last one", () => {
		const a = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })
		const b = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })
		const c = mockMessage({ senderId: 4, senderEmail: "bob@x.io" })

		expect(announcementSubject([a, b, c], 3, BigInt(SELF), blockedUsers)).toEqual({ count: 3, name: null })
	})

	it("still announces the others when the batch's LAST message is from a blocked sender", () => {
		const a = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })
		const b = mockMessage({ senderId: BLOCKED, senderEmail: "blocked@x.io" })

		expect(announcementSubject([a, b], 2, BigInt(SELF), blockedUsers)).toEqual({ count: 1, name: "alice@x.io" })
	})

	it("counts neither blocked senders nor own messages", () => {
		const a = mockMessage({ senderId: BLOCKED, senderEmail: "blocked@x.io" })
		const b = mockMessage({ senderId: SELF, senderEmail: "me@x.io" })
		const c = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })

		expect(announcementSubject([a, b, c], 3, BigInt(SELF), blockedUsers)).toEqual({ count: 1, name: "alice@x.io" })
	})

	it("announces nothing when every arrived message is blocked or own", () => {
		const a = mockMessage({ senderId: BLOCKED, senderEmail: "blocked@x.io" })
		const b = mockMessage({ senderId: SELF, senderEmail: "me@x.io" })

		expect(announcementSubject([a, b], 2, BigInt(SELF), blockedUsers)).toBeNull()
	})

	it("announces nothing while the account is unresolved — own messages are indistinguishable then", () => {
		const a = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })

		expect(announcementSubject([a], 1, undefined, blockedUsers)).toBeNull()
	})

	it("announces nothing without tail growth", () => {
		const a = mockMessage({ senderId: 2, senderEmail: "alice@x.io" })

		expect(announcementSubject([a], 0, BigInt(SELF), blockedUsers)).toBeNull()
	})

	// The mixed key ships no plural forms — a mixed batch is two messages or more by construction. i18next
	// falls back to the bare key when a `_one`/`_other` variant is absent; this pins that it does.
	it("renders both announcement variants", () => {
		expect(i18n.t("chats:chatNewMessageAnnouncement", { count: 2, name: "Alice" })).toBe("2 new messages from Alice")
		expect(i18n.t("chats:chatNewMessagesMixedAnnouncement", { count: 3 })).toBe("3 new messages")
	})
})

describe("countNewTailMessages — real arrival vs. older-history prepend (review fix: length alone can't tell)", () => {
	it("counts messages appended past the previous last message (a real tail arrival)", () => {
		const a = mockMessage()
		const b = mockMessage()
		const c = mockMessage()

		expect(countNewTailMessages([a], [a, b, c])).toBe(2)
	})

	it("is zero when older history is PREPENDED — the tail (last message) is unchanged", () => {
		const older1 = mockMessage()
		const older2 = mockMessage()
		const a = mockMessage()

		// loadOlderChatMessages prepends: [...olderPage, ...prev]. `a` stays last both times.
		expect(countNewTailMessages([a], [older1, older2, a])).toBe(0)
	})

	it("counts only the genuine tail growth when a prepend and an arrival land together", () => {
		const older = mockMessage()
		const a = mockMessage()
		const b = mockMessage()

		expect(countNewTailMessages([a], [older, a, b])).toBe(1)
	})

	it("is zero with no prior snapshot (initial load) — the atBottom guard handles this case anyway", () => {
		const a = mockMessage()

		expect(countNewTailMessages([], [a])).toBe(0)
	})

	it("is zero when the previous last message is no longer present (never guesses)", () => {
		const a = mockMessage()
		const b = mockMessage()

		expect(countNewTailMessages([a], [b])).toBe(0)
	})

	it("is zero when nothing changed", () => {
		const a = mockMessage()
		const b = mockMessage()

		expect(countNewTailMessages([a, b], [a, b])).toBe(0)
	})
})

// column-reverse geometry: scrollTop is 0 at the bottom and negative going up.
describe("column-reverse scroll geometry", () => {
	it("measures the distance from the bottom edge", () => {
		expect(scrollDistanceFromBottom(0)).toBe(0)
		expect(scrollDistanceFromBottom(-250)).toBe(250)
	})

	it("reads rubber-band overscroll past the bottom as the bottom", () => {
		expect(scrollDistanceFromBottom(12)).toBe(0)
	})

	it("measures the distance from the top edge", () => {
		// scrollHeight 1000, clientHeight 400 → the top sits at scrollTop -600.
		expect(scrollDistanceFromTop(0, 1000, 400)).toBe(600)
		expect(scrollDistanceFromTop(-600, 1000, 400)).toBe(0)
		expect(scrollDistanceFromTop(-500, 1000, 400)).toBe(100)
	})

	it("is near the bottom within the threshold", () => {
		expect(isScrollNearBottom(0, 80)).toBe(true)
		expect(isScrollNearBottom(-80, 80)).toBe(true)
		expect(isScrollNearBottom(-81, 80)).toBe(false)
	})

	it("is near the top within the threshold", () => {
		expect(isScrollNearTop(-480, 1000, 400, 120)).toBe(true)
		expect(isScrollNearTop(-479, 1000, 400, 120)).toBe(false)
		// Content shorter than the viewport is at both edges at once.
		expect(isScrollNearTop(0, 300, 400, 120)).toBe(true)
	})
})

describe("nextScrollAffordanceState — scroll-to-bottom pill (count-while-scrolled-up, clear-on-bottom)", () => {
	it("starts at bottom with nothing unseen", () => {
		expect(INITIAL_SCROLL_AFFORDANCE).toEqual<ScrollAffordanceState>({ atBottom: true, unseenCount: 0 })
	})

	it("a scroll event away from bottom clears nothing but flips atBottom", () => {
		const next = nextScrollAffordanceState(INITIAL_SCROLL_AFFORDANCE, { kind: "scroll", atBottom: false })
		expect(next).toEqual<ScrollAffordanceState>({ atBottom: false, unseenCount: 0 })
	})

	it("messages arriving while at bottom never grow the count", () => {
		const next = nextScrollAffordanceState(INITIAL_SCROLL_AFFORDANCE, { kind: "messagesArrived", count: 3 })
		expect(next).toEqual<ScrollAffordanceState>({ atBottom: true, unseenCount: 0 })
	})

	it("messages arriving while scrolled up accumulate across multiple arrivals", () => {
		const scrolledUp: ScrollAffordanceState = { atBottom: false, unseenCount: 0 }
		const afterFirst = nextScrollAffordanceState(scrolledUp, { kind: "messagesArrived", count: 1 })
		const afterSecond = nextScrollAffordanceState(afterFirst, { kind: "messagesArrived", count: 2 })

		expect(afterSecond).toEqual<ScrollAffordanceState>({ atBottom: false, unseenCount: 3 })
	})

	it("reaching bottom clears the count regardless of how high it climbed", () => {
		const scrolledUpWithUnseen: ScrollAffordanceState = { atBottom: false, unseenCount: 7 }
		const next = nextScrollAffordanceState(scrolledUpWithUnseen, { kind: "scroll", atBottom: true })

		expect(next).toEqual<ScrollAffordanceState>({ atBottom: true, unseenCount: 0 })
	})

	it("a redundant still-scrolled-up scroll event preserves the accumulated count", () => {
		const scrolledUpWithUnseen: ScrollAffordanceState = { atBottom: false, unseenCount: 4 }
		const next = nextScrollAffordanceState(scrolledUpWithUnseen, { kind: "scroll", atBottom: false })

		expect(next).toEqual<ScrollAffordanceState>({ atBottom: false, unseenCount: 4 })
	})

	// Reference equality, not value equality: a fresh object for an unchanged state would defeat React's
	// setState bailout and re-render the whole thread on every native scroll event while scrolled up.
	it("a redundant still-scrolled-up scroll event returns the same state reference", () => {
		const scrolledUpWithUnseen: ScrollAffordanceState = { atBottom: false, unseenCount: 4 }

		expect(nextScrollAffordanceState(scrolledUpWithUnseen, { kind: "scroll", atBottom: false })).toBe(scrolledUpWithUnseen)
	})

	it("a redundant still-at-bottom scroll event returns the same state reference", () => {
		expect(nextScrollAffordanceState(INITIAL_SCROLL_AFFORDANCE, { kind: "scroll", atBottom: true })).toBe(INITIAL_SCROLL_AFFORDANCE)
	})

	it("a non-positive arrival count is a no-op", () => {
		const scrolledUp: ScrollAffordanceState = { atBottom: false, unseenCount: 2 }
		const next = nextScrollAffordanceState(scrolledUp, { kind: "messagesArrived", count: 0 })

		expect(next).toBe(scrolledUp)
	})
})
