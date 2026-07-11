import { describe, expect, it } from "vitest"
import type { ChatMessage, UuidStr } from "@filen/sdk-rs"
import { buildThreadRows, computeScrollAfterPrepend, type ThreadRow } from "@/features/chats/components/thread/thread.logic"

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
