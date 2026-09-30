import { describe, expect, it } from "vitest"
import {
	compareChats,
	deriveBlockedUsers,
	EMPTY_BLOCKED_USERS,
	isListedChat,
	isOneOnOneWithBlocked,
	newestMessage,
	type ListChat
} from "@filen/shared"

const SELF = 1n

function chat(uuid: string, overrides: Partial<ListChat> = {}): ListChat {
	return { uuid, ownerId: SELF, participants: [{ userId: SELF, email: "self@example.com" }], ...overrides }
}

function sent(sentTimestamp: bigint): { sentTimestamp: bigint } {
	return { sentTimestamp }
}

function sorted(chats: ListChat[]): string[] {
	return [...chats].sort(compareChats).map(c => c.uuid)
}

describe("compareChats", () => {
	it("orders by lastMessage.sentTimestamp descending", () => {
		expect(sorted([chat("older", { lastMessage: sent(100n) }), chat("newer", { lastMessage: sent(200n) })])).toEqual(["newer", "older"])
	})

	it("sorts a chat with no lastMessage last", () => {
		expect(sorted([chat("without"), chat("with", { lastMessage: sent(1n) })])).toEqual(["with", "without"])
	})

	// Number() collapses ADJACENT bigints past MAX_SAFE_INTEGER (accepted: ms timestamps sit nowhere near);
	// a gap that survives the conversion keeps its order.
	it("orders large bigint timestamps that survive the Number() conversion", () => {
		const huge = chat("huge", { lastMessage: sent(9_007_199_254_740_992n) })
		const hugePlusTwo = chat("hugePlusTwo", { lastMessage: sent(9_007_199_254_740_994n) })

		expect(sorted([huge, hugePlusTwo])).toEqual(["hugePlusTwo", "huge"])
	})

	it("breaks timestamp ties on the uuid's digits, descending, independent of input order", () => {
		const a = chat("aaa-111")
		const b = chat("bbb-222")

		expect(sorted([a, b])).toEqual(["bbb-222", "aaa-111"])
		expect(sorted([b, a])).toEqual(["bbb-222", "aaa-111"])
	})
})

describe("isListedChat", () => {
	it("lists an owned chat without messages", () => {
		expect(isListedChat(chat("a", { ownerId: SELF }), SELF)).toBe(true)
	})

	it("lists a foreign chat once it holds a message", () => {
		expect(isListedChat(chat("a", { ownerId: 7n, lastMessage: sent(1n) }), SELF)).toBe(true)
	})

	it("hides a foreign chat nobody has posted in", () => {
		expect(isListedChat(chat("a", { ownerId: 7n }), SELF)).toBe(false)
	})

	it("treats an unresolved viewer as owning nothing", () => {
		expect(isListedChat(chat("a", { ownerId: SELF }), undefined)).toBe(false)
	})
})

describe("isOneOnOneWithBlocked", () => {
	function oneOnOne(other: { userId: bigint; email: string }): ListChat {
		return chat("a", { participants: [{ userId: SELF, email: "self@example.com" }, other] })
	}

	it("is true when the sole other participant is blocked by userId", () => {
		const blocked = deriveBlockedUsers([{ userId: 9n, email: "nomatch@example.com" }])

		expect(isOneOnOneWithBlocked(oneOnOne({ userId: 9n, email: "other@example.com" }), SELF, blocked)).toBe(true)
	})

	it("is true when the sole other participant matches only by email, case- and whitespace-insensitively", () => {
		const blocked = deriveBlockedUsers([{ userId: 42n, email: "Zoe@Example.com" }])

		expect(isOneOnOneWithBlocked(oneOnOne({ userId: 9n, email: "  ZOE@example.COM  " }), SELF, blocked)).toBe(true)
	})

	it("is false when the sole other participant is not blocked", () => {
		const blocked = deriveBlockedUsers([{ userId: 9n, email: "b@example.com" }])

		expect(isOneOnOneWithBlocked(oneOnOne({ userId: 3n, email: "c@example.com" }), SELF, blocked)).toBe(false)
	})

	it("is false for a group chat even when one member is blocked", () => {
		const blocked = deriveBlockedUsers([{ userId: 9n, email: "b@example.com" }])
		const group = chat("a", {
			participants: [
				{ userId: SELF, email: "self@example.com" },
				{ userId: 9n, email: "b@example.com" },
				{ userId: 3n, email: "c@example.com" }
			]
		})

		expect(isOneOnOneWithBlocked(group, SELF, blocked)).toBe(false)
	})

	it("is false for a solo chat", () => {
		const blocked = deriveBlockedUsers([{ userId: 9n, email: "b@example.com" }])

		expect(isOneOnOneWithBlocked(chat("a"), SELF, blocked)).toBe(false)
	})

	// Nobody counts as self while the viewer is unresolved, so a 1:1 reads as two others
	it("is false when the viewer is unresolved", () => {
		const blocked = deriveBlockedUsers([{ userId: 9n, email: "b@example.com" }])

		expect(isOneOnOneWithBlocked(oneOnOne({ userId: 9n, email: "b@example.com" }), undefined, blocked)).toBe(false)
	})

	it("is false against an empty blocked set", () => {
		expect(isOneOnOneWithBlocked(oneOnOne({ userId: 9n, email: "b@example.com" }), SELF, EMPTY_BLOCKED_USERS)).toBe(false)
	})
})

describe("newestMessage", () => {
	const older = sent(100n)
	const newer = sent(200n)

	it("keeps the held message over an older one", () => {
		expect(newestMessage(newer, older)).toBe(newer)
	})

	it("takes a newer message, and a chat's first", () => {
		expect(newestMessage(older, newer)).toBe(newer)
		expect(newestMessage(undefined, older)).toBe(older)
	})

	// The same message delivered again, as a committed send's own echo is
	it("takes a message sent at the same moment", () => {
		const again = { ...newer }

		expect(newestMessage(newer, again)).toBe(again)
	})
})
