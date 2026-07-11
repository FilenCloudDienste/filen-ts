import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { CornerUpLeftIcon, CopyIcon, PencilIcon, Trash2Icon } from "lucide-react"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest. messageMenuActions itself needs neither mock (pure logic, no sdk/
// queryClient import) — only deleteMessage/editMessage (lib/messageActions.ts) do.
const { deleteMessageOp, editMessageOp } = vi.hoisted(() => ({ deleteMessageOp: vi.fn(), editMessageOp: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { deleteMessage: deleteMessageOp, editMessage: editMessageOp } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { CHATS_QUERY_KEY, chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey, chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { deleteMessage, editMessage } from "@/features/chats/lib/messageActions"
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
	it("reply + copy, for a confirmed decryptable message from someone else", () => {
		const message = mockMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["reply", "copy"])
	})

	it("reply + copy + edit + delete, for a confirmed decryptable own message (sender-only edit/delete)", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["reply", "copy", "edit", "delete"])
	})

	it("coerces senderId (number) to BigInt before comparing to the bigint userId — not a raw ===", () => {
		const message = mockMessage({ senderId: 42 })

		expect(messageMenuActions(message, 42n).map(d => d.id)).toEqual(["reply", "copy", "edit", "delete"])
	})

	it("a pending send offers copy only (no reply/edit — its uuid is not a server uuid yet)", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n, "pending").map(d => d.id)).toEqual(["copy"])
	})

	it("a failed send offers copy + retry + remove (never reply/edit/delete)", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n, "failed").map(d => d.id)).toEqual(["copy", "retry", "remove"])
	})

	it("an undecryptable own message offers delete only (no reply/copy/edit — no text)", () => {
		const message = mockUndecryptableMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["delete"])
	})

	it("an undecryptable message from someone else offers nothing", () => {
		const message = mockUndecryptableMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n)).toEqual([])
	})

	it("with an unresolved currentUserId a confirmed decryptable message still offers reply + copy", () => {
		const decryptable = mockMessage({ senderId: 1 })
		const undecryptable = mockUndecryptableMessage({ senderId: 1 })

		expect(messageMenuActions(decryptable, undefined).map(d => d.id)).toEqual(["reply", "copy"])
		expect(messageMenuActions(undecryptable, undefined)).toEqual([])
	})

	it("descriptor facts: reply/copy/edit/delete carry their expected label and icon", () => {
		const message = mockMessage({ senderId: 1 })
		const descriptors = messageMenuActions(message, 1n)

		expect(descriptors).toEqual([
			{ id: "reply", labelKey: "chatMessageActionReply", icon: CornerUpLeftIcon, run: "direct" },
			{ id: "copy", labelKey: "chatMessageActionCopy", icon: CopyIcon, run: "direct" },
			{ id: "edit", labelKey: "chatMessageActionEdit", icon: PencilIcon, run: "direct" },
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

describe("editMessage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		testQueryClient.clear()
	})

	it("patches the thread cache with the returned edited message (same uuid, edited=true)", async () => {
		const chat = mockChat()
		const message = mockMessage({ message: "before" })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [message])
		const edited = { ...message, message: "after", edited: true }
		editMessageOp.mockResolvedValueOnce(edited)

		const outcome = await editMessage(chat, message, "after")

		expect(editMessageOp).toHaveBeenCalledExactlyOnceWith(chat, message, "after")
		expect(outcome).toEqual({ status: "success" })
		expect(chatMessagesQueryGet(chat.uuid)).toEqual([edited])
	})

	it("returns an error outcome on rejection, leaving the cache untouched (input restored by the caller)", async () => {
		const chat = mockChat()
		const message = mockMessage({ message: "before" })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [message])
		editMessageOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await editMessage(chat, message, "after")

		expect(outcome.status).toBe("error")
		expect(chatMessagesQueryGet(chat.uuid)).toEqual([message])
	})
})
