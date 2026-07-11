import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams (self-contained per the project's test convention). This file exercises the PUSH
// loop: sequential per-chat order, dequeue-on-commit + cache patch, the commit-boundary never-rethrow
// tail, the 3-strike failed transition + retry/remove, and the logout-abort flush suppression.
const { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats } = vi.hoisted(() => ({
	sendChatMessage: vi.fn(),
	markChatRead: vi.fn(() => Promise.resolve()),
	updateLastChatFocusTimesNow: vi.fn((chats: Chat[]) => Promise.resolve(chats)),
	listChats: vi.fn(() => Promise.resolve([] as Chat[]))
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats } }))

const { kvStore, kvGetJson, kvSetJson, kvDelete } = vi.hoisted(() => {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvGetJson: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		}),
		kvDelete: vi.fn((key: string) => {
			store.delete(key)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson, kvDelete }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { sync, enqueueChatMessage } from "@/features/chats/lib/sync"
import { retryInflightMessage, removeInflightMessage } from "@/features/chats/lib/inflight"
import { buildOptimisticMessage, type OptimisticSender } from "@/features/chats/lib/sync.logic"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import useChatsInflightStore, { type ChatMessageWithInflightId, type InflightChatMessages } from "@/features/chats/store/useChatsInflight"

const SENDER: OptimisticSender = { id: 7n, email: "me@filen.io", avatarUrl: undefined, nickName: "Me" }

function makeChat(uuid: string): Chat {
	return {
		uuid: uuid as Chat["uuid"],
		ownerId: 7n,
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n
	}
}

function makeConfirmed(chatUuid: string, uuid: string) {
	return {
		uuid: uuid as ChatMessageWithInflightId["uuid"],
		chat: chatUuid as ChatMessageWithInflightId["chat"],
		senderId: 7,
		senderEmail: "me@filen.io",
		senderNickName: "Me",
		message: "hi",
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1n
	}
}

function opt(chatUuid: string, inflightId: string, sentTimestamp: bigint, content: string): ChatMessageWithInflightId {
	return buildOptimisticMessage({
		chatUuid: chatUuid as ChatMessageWithInflightId["chat"],
		inflightId: inflightId as ChatMessageWithInflightId["uuid"],
		content,
		replyTo: undefined,
		sentTimestamp,
		sender: SENDER
	})
}

function seed(chatUuid: string, messages: ChatMessageWithInflightId[]): void {
	useChatsInflightStore.setState(prev => ({
		inflightMessages: { ...prev.inflightMessages, [chatUuid]: { chat: makeChat(chatUuid), messages } },
		inflightErrors: prev.inflightErrors
	}))
}

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

function sdkError(kind: string): { species: "sdk"; kind: string; label: string; message: string } {
	return { species: "sdk", kind, label: kind, message: kind }
}

function queue(): InflightChatMessages {
	return useChatsInflightStore.getState().inflightMessages
}

beforeEach(async () => {
	kvStore.clear()
	testQueryClient.clear()
	vi.clearAllMocks()
	onlineManager.setOnline(true)
	useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {} })
	sendChatMessage.mockImplementation((chat: Chat) => Promise.resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid, "srv-1-1-1") }))
	sync.start()
	await tick()
})

afterEach(() => {
	onlineManager.setOnline(true)
})

describe("push loop — sequential per-chat send in queue order (oldest-first)", () => {
	it("sends a chat's queued messages in ascending sentTimestamp order", async () => {
		const sentContents: string[] = []
		sendChatMessage.mockImplementation((chat: Chat, message: string) => {
			sentContents.push(message)

			return Promise.resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid, `srv-${message}`) })
		})

		seed("chat-a-a-a", [
			opt("chat-a-a-a", "inf-3-3-3", 300n, "m3"),
			opt("chat-a-a-a", "inf-1-1-1", 100n, "m1"),
			opt("chat-a-a-a", "inf-2-2-2", 200n, "m2")
		])

		sync.syncNow()
		await tick()
		await tick()

		expect(sentContents).toEqual(["m1", "m2", "m3"])
		expect(queue()["chat-a-a-a"]).toBeUndefined()
	})
})

describe("commit — dequeue + reconcile the message cache off the returned chat", () => {
	it("replaces the optimistic copy (uuid === inflightId) with the confirmed server message and drains the queue", async () => {
		await enqueueChatMessage({ chat: makeChat("chat-a-a-a"), content: "hi", sender: SENDER })
		await tick()
		await tick()

		// After commit the optimistic copy is replaced by the single confirmed server message.
		const cached = chatMessagesQueryGet("chat-a-a-a") ?? []
		expect(cached).toHaveLength(1)
		expect(cached[0]?.uuid).toBe("srv-1-1-1")
		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors).toEqual({})
	})
})

describe("commit boundary — the post-commit tail never re-throws (no duplicate on a housekeeping failure)", () => {
	it("keeps the message committed + dequeued even when markChatRead rejects after the send resolved", async () => {
		markChatRead.mockRejectedValue(new Error("read failed"))
		updateLastChatFocusTimesNow.mockRejectedValue(new Error("focus failed"))

		seed("chat-a-a-a", [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()
		await tick()

		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors).toEqual({})
	})
})

describe("failed transition — 3 strikes drops from the queue but KEEPS the error record", () => {
	it("increments permanentRejections per pass and drops the message on the third", async () => {
		sendChatMessage.mockRejectedValue(sdkError("Server"))
		seed("chat-a-a-a", [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		for (let pass = 0; pass < 3; pass += 1) {
			sync.syncNow()
			await tick()
			await tick()
		}

		expect(queue()["chat-a-a-a"]).toBeUndefined()
		const error = useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]
		expect(error?.permanentRejections).toBe(3)
		expect(error?.message.inflightId).toBe("inf-1-1-1")
	})

	it("keeps a network-class failure queued forever without ever counting toward the drop", async () => {
		sendChatMessage.mockRejectedValue(sdkError("Reqwest"))
		seed("chat-a-a-a", [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		for (let pass = 0; pass < 5; pass += 1) {
			sync.syncNow()
			await tick()
			await tick()
		}

		expect(queue()["chat-a-a-a"]?.messages).toHaveLength(1)
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]?.permanentRejections).toBe(0)
	})
})

describe("retry / remove of a failed send", () => {
	it("retry re-queues the message with a cleared error record and resends it", async () => {
		// Drive it to failed first.
		sendChatMessage.mockRejectedValue(sdkError("Server"))
		seed("chat-a-a-a", [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		for (let pass = 0; pass < 3; pass += 1) {
			sync.syncNow()
			await tick()
			await tick()
		}

		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeDefined()

		// Now succeed on retry.
		sendChatMessage.mockImplementation((chat: Chat) => Promise.resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid, "srv-1-1-1") }))

		await retryInflightMessage({ chat: makeChat("chat-a-a-a"), message: opt("chat-a-a-a", "inf-1-1-1", 1n, "hi") })
		await tick()
		await tick()

		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeUndefined()
	})

	it("remove drops the queued entry, its error record and the optimistic cache copy", async () => {
		await enqueueChatMessage({ chat: makeChat("chat-b-b-b"), content: "hi", sender: SENDER })
		// Grab the minted inflightId from the queue.
		const message = queue()["chat-b-b-b"]?.messages[0]
		expect(message).toBeDefined()

		useChatsInflightStore.setState(prev => ({
			inflightMessages: prev.inflightMessages,
			inflightErrors: message
				? { [message.inflightId]: { error: sdkError("Server"), permanentRejections: 3, message } }
				: prev.inflightErrors
		}))

		if (message) {
			await removeInflightMessage({ chat: makeChat("chat-b-b-b"), message })
		}

		expect(queue()["chat-b-b-b"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors).toEqual({})
		const cached = chatMessagesQueryGet("chat-b-b-b") ?? []
		expect(message ? cached.some(m => m.uuid === message.uuid) : false).toBe(false)
	})
})

describe("logout — an aborted pass never flushes (the wipe is not resurrected)", () => {
	it("suppresses the post-pass disk flush when cancel() aborts the in-flight pass", async () => {
		let releaseSend: (() => void) | undefined
		sendChatMessage.mockImplementation(
			(chat: Chat) =>
				new Promise(resolve => {
					releaseSend = () => {
						resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid, "srv-1-1-1") })
					}
				})
		)

		seed("chat-a-a-a", [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()

		// Abort the captured signal mid-flight, then let the send resolve.
		kvSetJson.mockClear()
		sync.cancel()
		releaseSend?.()
		await tick()
		await tick()

		// The final flush is skipped for the aborted pass — no queue write landed after cancel.
		expect(kvSetJson).not.toHaveBeenCalled()
	})
})
