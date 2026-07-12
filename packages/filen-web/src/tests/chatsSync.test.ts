import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams (self-contained per the project's test convention). This file exercises the PUSH
// loop: sequential per-chat order, dequeue-on-commit + cache patch, the commit-boundary never-rethrow
// tail, the 3-strike failed transition + retry/remove, and the logout-abort flush suppression.
const { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } = vi.hoisted(() => ({
	sendChatMessage: vi.fn(),
	markChatRead: vi.fn(() => Promise.resolve()),
	updateLastChatFocusTimesNow: vi.fn((chats: Chat[]) => Promise.resolve(chats)),
	listChats: vi.fn(() => Promise.resolve([] as Chat[])),
	// The push loop resolves a LIVE chat per uuid (never the disk-restored snapshot). With an empty list
	// cache the loop falls back to getChat; the default returns a valid live chat so every send resolves.
	getChat: vi.fn((uuid: string) =>
		Promise.resolve({ uuid, ownerId: 7n, participants: [], muted: false, created: 0n, lastFocus: 0n } as Chat)
	)
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } }))

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
import { chatsQueryUpsert } from "@/features/chats/queries/chats"
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
	useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {}, sendingInflightIds: {} })
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

describe("replay-on-launch — the send resolves a LIVE chat, never the disk-restored snapshot", () => {
	it("sends the cache-resolved chat, not the stale stored (disk-revived) chat object", async () => {
		let sentChat: Chat | undefined
		sendChatMessage.mockImplementation((chat: Chat) => {
			sentChat = chat

			return Promise.resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid, "srv-1-1-1") })
		})

		// Simulate a disk-restored queue: the stored `chat` is a stale snapshot the wasm send must NOT use
		// (on the real surface it wedges the loop). It carries a sentinel name so the assertion can prove
		// the send did not touch it.
		const stale: Chat = { ...makeChat("chat-a-a-a"), name: "STALE_DISK_SNAPSHOT" }

		useChatsInflightStore.setState({
			inflightMessages: { "chat-a-a-a": { chat: stale, messages: [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")] } },
			inflightErrors: {}
		})

		// A LIVE chat is warm in the list cache (restore's cache-warm / the sidebar).
		chatsQueryUpsert({ ...makeChat("chat-a-a-a"), name: "LIVE" })

		sync.syncNow()
		await tick()
		await tick()

		expect(sentChat?.name).toBe("LIVE")
		expect(getChat).not.toHaveBeenCalled()
		expect(queue()["chat-a-a-a"]).toBeUndefined()
	})

	it("falls back to getChat when the list cache misses (a fresh-boot /drive shell, list not mounted)", async () => {
		seed("chat-c-c-c", [opt("chat-c-c-c", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()
		await tick()

		expect(getChat).toHaveBeenCalledWith("chat-c-c-c")
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(queue()["chat-c-c-c"]).toBeUndefined()
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

describe("unrecallable in-flight marker — sendingInflightIds spans the outstanding sendChatMessage call", () => {
	it("marks the inflightId sending only while the network call is outstanding, clearing on commit", async () => {
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

		expect(useChatsInflightStore.getState().sendingInflightIds["inf-1-1-1"]).toBe(true)

		releaseSend?.()
		await tick()
		await tick()

		expect(useChatsInflightStore.getState().sendingInflightIds["inf-1-1-1"]).toBeUndefined()
		expect(queue()["chat-a-a-a"]).toBeUndefined()
	})

	it("stays marked sending across an AUTOMATIC retry pass, even though a stale error record from an earlier transient rejection is still present — the exact race that let Remove/Retry target an unrecallable send", async () => {
		// First pass: a network-class rejection keeps the message queued WITH an error record (the "failed"
		// bubble a user could otherwise act on).
		sendChatMessage.mockRejectedValueOnce(sdkError("Reqwest"))
		seed("chat-a-a-a", [opt("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()
		await tick()

		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeDefined()
		expect(queue()["chat-a-a-a"]?.messages).toHaveLength(1)

		// Second pass — an automatic trigger (reconnect/interval), NOT a user Retry click — resends the same
		// still-queued message. sendingInflightIds must be true for its whole outstanding window despite the
		// stale error record above.
		let releaseSend: (() => void) | undefined
		sendChatMessage.mockImplementation(
			(chat: Chat) =>
				new Promise(resolve => {
					releaseSend = () => {
						resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid, "srv-1-1-1") })
					}
				})
		)

		sync.syncNow()
		await tick()

		expect(useChatsInflightStore.getState().sendingInflightIds["inf-1-1-1"]).toBe(true)
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeDefined()

		releaseSend?.()
		await tick()
		await tick()

		expect(useChatsInflightStore.getState().sendingInflightIds["inf-1-1-1"]).toBeUndefined()
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
