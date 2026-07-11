import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { CopyIcon, Trash2Icon } from "lucide-react"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest. messageMenuActions itself needs neither mock (pure logic, no sdk/
// queryClient import) — only deleteMessage (lib/messageActions.ts) does.
const { deleteMessageOp } = vi.hoisted(() => ({ deleteMessageOp: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { deleteMessage: deleteMessageOp } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { CHATS_QUERY_KEY, chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey, chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { deleteMessage } from "@/features/chats/lib/messageActions"
import { messageMenuActions } from "@/features/chats/components/thread/messageMenu.logic"

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		message: "hello",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		...overrides
	}
}

// exactOptionalPropertyTypes distinguishes "key absent" (valid for an optional field) from "key
// present with value undefined" (rejected) — an undecryptable message genuinely never has the `message`
// key, mirrors chatsSort.test.ts's own mockUndecryptableChat.
function mockUndecryptableMessage(overrides: Omit<Partial<ChatMessage>, "message"> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		...overrides
	}
}

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

describe("messageMenuActions", () => {
	it("copy only, for a decryptable message from someone else", () => {
		const message = mockMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["copy"])
	})

	it("copy + delete, for a decryptable message from the current user (sender-only delete)", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["copy", "delete"])
	})

	it("coerces senderId (number) to BigInt before comparing to the bigint userId — not a raw ===", () => {
		const message = mockMessage({ senderId: 42 })

		expect(messageMenuActions(message, 42n).map(d => d.id)).toContain("delete")
	})

	it("omits copy for an undecryptable message (message === undefined)", () => {
		const message = mockUndecryptableMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["delete"])
	})

	it("an undecryptable message from someone else offers nothing", () => {
		const message = mockUndecryptableMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n)).toEqual([])
	})

	it("no entries when currentUserId is unresolved (undefined) — only copy survives if decryptable", () => {
		const decryptable = mockMessage({ senderId: 1 })
		const undecryptable = mockUndecryptableMessage({ senderId: 1 })

		expect(messageMenuActions(decryptable, undefined).map(d => d.id)).toEqual(["copy"])
		expect(messageMenuActions(undecryptable, undefined)).toEqual([])
	})

	it("descriptor facts: copy/delete carry their expected label and icon", () => {
		const message = mockMessage({ senderId: 1 })
		const descriptors = messageMenuActions(message, 1n)

		expect(descriptors).toEqual([
			{ id: "copy", labelKey: "chatMessageActionCopy", icon: CopyIcon, run: "direct" },
			{ id: "delete", labelKey: "chatMessageActionDelete", icon: Trash2Icon, run: "dialog", destructive: true }
		])
	})
})

describe("deleteMessage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		testQueryClient.clear()
	})

	it("removes the message from the per-chat cache and upserts the returned chat", async () => {
		const chat = mockChat()
		const message = mockMessage()
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [message])
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		const updatedChat = { ...chat, lastMessage: undefined }
		deleteMessageOp.mockResolvedValueOnce(updatedChat)

		const outcome = await deleteMessage(chat, message)

		expect(deleteMessageOp).toHaveBeenCalledExactlyOnceWith(chat, message)
		expect(outcome).toEqual({ status: "success" })
		expect(chatMessagesQueryGet(chat.uuid)).toEqual([])
		expect(chatsQueryGet()).toEqual([updatedChat])
	})

	it("returns an error outcome on rejection, without touching either cache", async () => {
		const chat = mockChat()
		const message = mockMessage()
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [message])
		deleteMessageOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await deleteMessage(chat, message)

		expect(outcome.status).toBe("error")
		expect(chatMessagesQueryGet(chat.uuid)).toEqual([message])
	})
})
