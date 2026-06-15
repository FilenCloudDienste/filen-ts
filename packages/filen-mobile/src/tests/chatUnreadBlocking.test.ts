import { describe, it, expect } from "vitest"
import { isMessageUnread, chatHasUnread } from "@/features/chats/chatSelectors"
import { deriveBlockedUsers } from "@/features/contacts/blockedSelectors"
import { type Chat, type ChatMessage } from "@/types"

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
})

describe("chatHasUnread scan-back", () => {
	const self = 1n
	const getMessagesEmpty = () => undefined

	it("blocked spoke last, no older real unread → not unread", () => {
		const c = chat(50n, msg(99n, 200n))
		const getMessages = () => [msg(99n, 200n)]

		expect(chatHasUnread(c, self, blocked, getMessages)).toBe(false)
	})

	it("blocked spoke last, older real unread exists → unread", () => {
		const c = chat(50n, msg(99n, 200n))
		const getMessages = () => [msg(7n, 120n), msg(99n, 200n)]

		expect(chatHasUnread(c, self, blocked, getMessages)).toBe(true)
	})

	it("non-blocked spoke last → unread without scanning", () => {
		const c = chat(50n, msg(7n, 200n))

		expect(chatHasUnread(c, self, blocked, getMessagesEmpty)).toBe(true)
	})
})
