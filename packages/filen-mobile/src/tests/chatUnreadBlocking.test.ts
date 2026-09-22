import { describe, it, expect } from "vitest"
import { isMessageUnread, chatHasUnread } from "@/features/chats/chatSelectors"
import { deriveBlockedUsers } from "@filen/shared"
import { type Chat, type ChatMessage } from "@/types"

// Blocked-scan predicate matrices moved to @filen/shared's src/tests/chatUnread.test.ts
// (chatHasUnreadCore) — these are thin adapter tests proving mobile's real isBlocked/deriveBlockedUsers
// wiring and its `getMessages(uuid)` reader closure map correctly into the shared core.

const blocked = deriveBlockedUsers([{ uuid: "x", userId: 99n, email: "spam@x.com", avatar: undefined, nickName: "S", timestamp: 0n }] as never)

function msg(senderId: bigint, sentTimestamp: bigint, uuid = "m"): ChatMessage {
	return { chat: "c", inner: { uuid, senderId, senderEmail: "", message: "hi" }, sentTimestamp, edited: false } as unknown as ChatMessage
}

function chat(lastFocus: bigint | undefined, lastMessage?: ChatMessage): Chat {
	return { uuid: "c", muted: false, lastFocus, lastMessage, participants: [] } as unknown as Chat
}

describe("isMessageUnread blocked-aware", () => {
	it("is unread for a non-blocked sender", () => {
		expect(isMessageUnread(msg(5n, 100n), chat(50n, msg(5n, 100n)), 1n, blocked)).toBe(true)
	})

	it("is NOT unread for a blocked sender", () => {
		expect(isMessageUnread(msg(99n, 100n), chat(50n, msg(99n, 100n)), 1n, blocked)).toBe(false)
	})

	it("is NOT unread for a sender matched by email only (userId differs)", () => {
		const m = {
			chat: "c",
			inner: { uuid: "m", senderId: 7n, senderEmail: "spam@x.com", message: "hi" },
			sentTimestamp: 100n,
			edited: false
		} as unknown as ChatMessage

		expect(isMessageUnread(m, chat(50n, m), 1n, blocked)).toBe(false)
	})
})

describe("chatHasUnread scan-back (getMessages(uuid) reader wiring)", () => {
	const self = 1n

	it("blocked spoke last, older real unread exists in getMessages(uuid) → unread", () => {
		const c = chat(50n, msg(99n, 200n))
		const getMessages = (uuid: string) => (uuid === c.uuid ? [msg(7n, 120n), msg(99n, 200n)] : undefined)

		expect(chatHasUnread(c, self, blocked, getMessages)).toBe(true)
	})

	it("non-blocked spoke last → unread without needing the reader", () => {
		const c = chat(50n, msg(7n, 200n))

		expect(chatHasUnread(c, self, blocked, () => undefined)).toBe(true)
	})
})
