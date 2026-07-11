import { describe, expect, it } from "vitest"
import type { ChatMessage, UuidStr } from "@filen/sdk-rs"
import {
	buildThreadRows,
	computeScrollAfterPrepend,
	isScrollNearBottom,
	nextScrollAffordanceState,
	INITIAL_SCROLL_AFFORDANCE,
	type ThreadRow,
	type ScrollAffordanceState
} from "@/features/chats/components/thread/thread.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Local-calendar timestamp so the day-boundary tests are deterministic regardless of the runner's TZ
// (buildThreadRows uses local getFullYear/Month/Date, matching how the day label renders).
function ts(year: number, month: number, day: number, hour: number, minute: number): bigint {
	return BigInt(new Date(year, month - 1, day, hour, minute, 0, 0).getTime())
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

function messageHeaderFlags(rows: ThreadRow[]): { key: string; showHeader: boolean }[] {
	return rows
		.filter((r): r is Extract<ThreadRow, { kind: "message" }> => r.kind === "message")
		.map(r => ({ key: r.key, showHeader: r.showHeader }))
}

describe("buildThreadRows — burst grouping (D3 dense grouped flat rows)", () => {
	it("emits a leading day separator + a header row for a single message", () => {
		const m = mockMessage()
		const rows = buildThreadRows([m])

		expect(rows[0]?.kind).toBe("day")
		expect(messageHeaderFlags(rows)).toEqual([{ key: m.uuid, showHeader: true }])
	})

	it("collapses consecutive same-sender messages within 2 minutes (subsequent rows hide the header)", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 1) })
		const rows = buildThreadRows([a, b])

		expect(messageHeaderFlags(rows)).toEqual([
			{ key: a.uuid, showHeader: true },
			{ key: b.uuid, showHeader: false }
		])
	})

	it("starts a new burst when the sender changes", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 2, sentTimestamp: ts(2021, 1, 1, 12, 1) })
		const rows = buildThreadRows([a, b])

		expect(messageHeaderFlags(rows)).toEqual([
			{ key: a.uuid, showHeader: true },
			{ key: b.uuid, showHeader: true }
		])
	})

	it("starts a new burst when the gap exceeds 2 minutes even for the same sender", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 0) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 12, 3) })
		const rows = buildThreadRows([a, b])

		expect(messageHeaderFlags(rows)).toEqual([
			{ key: a.uuid, showHeader: true },
			{ key: b.uuid, showHeader: true }
		])
	})

	it("inserts a day separator and forces a header at a calendar-day boundary", () => {
		const a = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 1, 23, 59) })
		const b = mockMessage({ senderId: 1, sentTimestamp: ts(2021, 1, 2, 0, 0) })
		const rows = buildThreadRows([a, b])

		expect(rows.map(r => r.kind)).toEqual(["day", "message", "day", "message"])
		expect(messageHeaderFlags(rows)).toEqual([
			{ key: a.uuid, showHeader: true },
			{ key: b.uuid, showHeader: true }
		])
	})
})

describe("computeScrollAfterPrepend", () => {
	it("grows scrollTop by exactly the height the prepended content added", () => {
		// content grew 400px (1000 → 1400); a viewport at scrollTop 0 must move to 400 to stay put.
		expect(computeScrollAfterPrepend(1000, 0, 1400)).toBe(400)
		// preserves an existing offset too.
		expect(computeScrollAfterPrepend(1000, 120, 1400)).toBe(520)
	})

	it("is a no-op when nothing was prepended", () => {
		expect(computeScrollAfterPrepend(1000, 250, 1000)).toBe(250)
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
		expect(kinds).toEqual(["day", a.uuid, "unread", b.uuid, c.uuid])
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
})

describe("isScrollNearBottom", () => {
	it("is true once the gap to the true bottom is within the threshold", () => {
		// scrollHeight 1000, clientHeight 400 → true bottom scrollTop is 600.
		expect(isScrollNearBottom(600, 1000, 400, 80)).toBe(true)
		expect(isScrollNearBottom(530, 1000, 400, 80)).toBe(true)
	})

	it("is false once scrolled further up than the threshold", () => {
		expect(isScrollNearBottom(400, 1000, 400, 80)).toBe(false)
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

	it("a non-positive arrival count is a no-op", () => {
		const scrolledUp: ScrollAffordanceState = { atBottom: false, unseenCount: 2 }
		const next = nextScrollAffordanceState(scrolledUp, { kind: "messagesArrived", count: 0 })

		expect(next).toBe(scrolledUp)
	})
})
