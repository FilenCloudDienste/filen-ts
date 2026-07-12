import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { CornerUpLeftIcon, CopyIcon, PencilIcon, Trash2Icon, UserXIcon } from "lucide-react"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"
import { deriveBlockedUsers } from "@/features/contacts/lib/blocking"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest. messageMenuActions itself needs neither mock (pure logic, no sdk/
// queryClient import) — only deleteMessage/editMessage (lib/messageActions.ts) do.
const { deleteMessageOp, editMessageOp, disableMessageEmbedOp } = vi.hoisted(() => ({
	deleteMessageOp: vi.fn(),
	editMessageOp: vi.fn(),
	disableMessageEmbedOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { deleteMessage: deleteMessageOp, editMessage: editMessageOp, disableMessageEmbed: disableMessageEmbedOp }
}))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { CHATS_QUERY_KEY, chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey, chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { deleteMessage, editMessage, disableMessageEmbed } from "@/features/chats/lib/messageActions"
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
	it("reply + copy + block, for a confirmed decryptable message from someone else", () => {
		const message = mockMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["reply", "copy", "block"])
	})

	it("reply + copy + edit + delete, for a confirmed decryptable own message (sender-only edit/delete)", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["reply", "copy", "edit", "delete"])
	})

	it("adds disableEmbed between edit and delete when the caller reports the message has an active embed", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n, "confirmed", true).map(d => d.id)).toEqual([
			"reply",
			"copy",
			"edit",
			"disableEmbed",
			"delete"
		])
	})

	it("omits disableEmbed for someone else's message even when hasEmbeds is true (sender-only), still offers block", () => {
		const message = mockMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n, "confirmed", true).map(d => d.id)).toEqual(["reply", "copy", "block"])
	})

	it("omits disableEmbed by default (hasEmbeds defaults to false)", () => {
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n, "confirmed").map(d => d.id)).toEqual(["reply", "copy", "edit", "delete"])
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

	it("a SENDING message offers copy only — retry/remove stay hidden even for an id that also carries a stale error record", () => {
		// "sending" (the push loop's send call is actually outstanding, unrecallable) must gate identically
		// to "pending", never falling into the "failed" branch that offers retry/remove.
		const message = mockMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n, "sending").map(d => d.id)).toEqual(["copy"])
	})

	it("an undecryptable own message offers delete only (no reply/copy/edit — no text)", () => {
		const message = mockUndecryptableMessage({ senderId: 1 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["delete"])
	})

	it("an undecryptable message from someone else offers only block (you block a person, not content)", () => {
		const message = mockUndecryptableMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n).map(d => d.id)).toEqual(["block"])
	})

	it("with an unresolved currentUserId a confirmed decryptable message offers reply + copy but NEVER block (can't tell whose message it is)", () => {
		const decryptable = mockMessage({ senderId: 1 })
		const undecryptable = mockUndecryptableMessage({ senderId: 1 })

		expect(messageMenuActions(decryptable, undefined).map(d => d.id)).toEqual(["reply", "copy"])
		expect(messageMenuActions(undecryptable, undefined)).toEqual([])
	})

	it("never offers block on your own message", () => {
		const own = mockMessage({ senderId: 1 })

		expect(messageMenuActions(own, 1n).map(d => d.id)).not.toContain("block")
	})

	it("omits block when the sender is already blocked (cross-referenced against the blocked set)", () => {
		const message = mockMessage({ senderId: 5, senderEmail: "peer@x.io" })
		const blocked = deriveBlockedUsers([{ uuid: testUuid("b"), userId: 5n, email: "peer@x.io", nickName: "Peer", timestamp: 0n }])

		expect(messageMenuActions(message, 1n, "confirmed", false, blocked).map(d => d.id)).toEqual(["reply", "copy"])
	})

	it("block matches a blocked sender by EMAIL even when the userId differs (email fallback)", () => {
		const message = mockMessage({ senderId: 5, senderEmail: "peer@x.io" })
		const blocked = deriveBlockedUsers([{ uuid: testUuid("b"), userId: 999n, email: "peer@x.io", nickName: "Peer", timestamp: 0n }])

		expect(messageMenuActions(message, 1n, "confirmed", false, blocked).map(d => d.id)).not.toContain("block")
	})

	it("omits block for a pending/failed send (sendState-gated to confirmed)", () => {
		const message = mockMessage({ senderId: 5 })

		expect(messageMenuActions(message, 1n, "pending").map(d => d.id)).not.toContain("block")
		expect(messageMenuActions(message, 1n, "failed").map(d => d.id)).not.toContain("block")
	})

	it("block descriptor carries its expected label and icon (destructive, direct)", () => {
		const message = mockMessage({ senderId: 5 })
		const block = messageMenuActions(message, 1n).find(d => d.id === "block")

		expect(block).toEqual({ id: "block", labelKey: "chatMessageActionBlock", icon: UserXIcon, run: "direct", destructive: true })
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

describe("disableMessageEmbed", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		testQueryClient.clear()
	})

	it("takes only the message (no chat arg — the wasm op needs none) and patches by message.chat", async () => {
		const chat = mockChat()
		const message = mockMessage({ chat: chat.uuid, embedDisabled: false })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [message])
		const disabled = { ...message, embedDisabled: true }
		disableMessageEmbedOp.mockResolvedValueOnce(disabled)

		const outcome = await disableMessageEmbed(message)

		expect(disableMessageEmbedOp).toHaveBeenCalledExactlyOnceWith(message)
		expect(outcome).toEqual({ status: "success" })
		expect(chatMessagesQueryGet(chat.uuid)).toEqual([disabled])
	})

	it("returns an error outcome on rejection, leaving the cache untouched", async () => {
		const chat = mockChat()
		const message = mockMessage({ chat: chat.uuid, embedDisabled: false })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [message])
		disableMessageEmbedOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await disableMessageEmbed(message)

		expect(outcome.status).toBe("error")
		expect(chatMessagesQueryGet(chat.uuid)).toEqual([message])
	})
})
