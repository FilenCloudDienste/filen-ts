import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams: the sdk client, the kv adapter and the persisted query client are mocked so the
// outbox runs under node vitest. This file exercises DURABILITY: persist-before-send, replay-on-launch
// merge/prune, offline-keep, and the durable-schema drop. self-contained vi.mock per the project's
// test convention.
const { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } = vi.hoisted(() => ({
	sendChatMessage: vi.fn(),
	markChatRead: vi.fn(() => Promise.resolve()),
	updateLastChatFocusTimesNow: vi.fn((chats: Chat[]) => Promise.resolve(chats)),
	listChats: vi.fn(() => Promise.resolve([] as Chat[])),
	// The push loop resolves a LIVE chat per uuid; on a list-cache miss it falls back to getChat.
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

import { Sync, enqueueChatMessage, sync } from "@/features/chats/lib/sync"
import { inflightChatMessagesSchema, buildOptimisticMessage, type OptimisticSender } from "@/features/chats/lib/sync.logic"
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

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

function optimistic(chatUuid: string, inflightId: string, sentTimestamp: bigint): ChatMessageWithInflightId {
	return buildOptimisticMessage({
		chatUuid: chatUuid as ChatMessageWithInflightId["chat"],
		inflightId: inflightId as ChatMessageWithInflightId["uuid"],
		content: "hi",
		replyTo: undefined,
		sentTimestamp,
		sender: SENDER
	})
}

function persistedQueue(): InflightChatMessages | undefined {
	return kvStore.get("inflightChatMessages") as InflightChatMessages | undefined
}

beforeEach(async () => {
	kvStore.clear()
	vi.clearAllMocks()
	onlineManager.setOnline(true)
	useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {} })
	sendChatMessage.mockImplementation((chat: Chat) => Promise.resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid) }))
	// Resolve the singleton's initPromise against an empty kv so flushToDisk/sync don't hang.
	sync.start()
	await tick()
})

afterEach(() => {
	onlineManager.setOnline(true)
})

function makeConfirmed(chatUuid: string) {
	return {
		uuid: "srv-1-1-1" as ChatMessageWithInflightId["uuid"],
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

describe("enqueue — persist BEFORE send (the survives-window-close guarantee)", () => {
	it("writes the whole outbox to disk before the send commits", async () => {
		// A send that never resolves: the durable write must already be on disk regardless.
		let releaseSend: (() => void) | undefined
		sendChatMessage.mockImplementation(
			(chat: Chat) =>
				new Promise(resolve => {
					releaseSend = () => {
						resolve({ ...chat, lastMessage: makeConfirmed(chat.uuid) })
					}
				})
		)

		const flushed = await enqueueChatMessage({ chat: makeChat("chat-a-a-a"), content: "hi", sender: SENDER })

		expect(flushed).toBe(true)
		// The message is durable even though the send is still pending (releaseSend not called).
		const queue = persistedQueue()
		expect(queue?.["chat-a-a-a"]?.messages).toHaveLength(1)
		expect(kvSetJson).toHaveBeenCalled()

		releaseSend?.()
	})

	it("surfaces a failed disk write as false without throwing", async () => {
		kvSetJson.mockRejectedValueOnce(new Error("disk full"))

		const flushed = await enqueueChatMessage({ chat: makeChat("chat-a-a-a"), content: "hi", sender: SENDER })

		expect(flushed).toBe(false)
	})
})

describe("replay-on-launch — restore merges disk with in-memory by inflightId union", () => {
	it("hydrates a persisted queue and re-sends it on start", async () => {
		kvStore.set("inflightChatMessages", {
			"chat-a-a-a": { chat: makeChat("chat-a-a-a"), messages: [optimistic("chat-a-a-a", "inf-1-1-1", 1n)] }
		})
		listChats.mockResolvedValueOnce([makeChat("chat-a-a-a")])

		const fresh = new Sync()
		fresh.start()
		await tick()
		await tick()

		expect(sendChatMessage).toHaveBeenCalledTimes(1)
	})

	it("unions a disk entry with a message enqueued during the restore window (live entry survives)", async () => {
		// Seed a live message BEFORE restore runs (simulates a send during the seconds-long restore).
		useChatsInflightStore.setState({
			inflightMessages: {
				"chat-a-a-a": { chat: makeChat("chat-a-a-a"), messages: [optimistic("chat-a-a-a", "inf-live-9-9", 900n)] }
			},
			inflightErrors: {}
		})
		kvStore.set("inflightChatMessages", {
			"chat-a-a-a": {
				chat: makeChat("chat-a-a-a"),
				messages: [optimistic("chat-a-a-a", "inf-live-9-9", 900n), optimistic("chat-a-a-a", "inf-disk-1-1", 100n)]
			}
		})
		listChats.mockResolvedValue([makeChat("chat-a-a-a")])
		// Keep the messages queued so the merge result is observable (send fails, keep-for-retry).
		sendChatMessage.mockRejectedValue({ species: "sdk", kind: "Reqwest", label: "net", message: "net" })

		const fresh = new Sync()
		fresh.start()
		await tick()
		await tick()

		const ids = useChatsInflightStore.getState().inflightMessages["chat-a-a-a"]?.messages.map(m => m.inflightId) ?? []
		expect(new Set(ids)).toEqual(new Set(["inf-live-9-9", "inf-disk-1-1"]))
	})
})

describe("restore reconcile — prune queued sends for chats that no longer exist", () => {
	it("drops a restored entry whose chat is absent from the fetched list, keeps one whose chat exists", async () => {
		kvStore.set("inflightChatMessages", {
			"chat-gone-x-x": { chat: makeChat("chat-gone-x-x"), messages: [optimistic("chat-gone-x-x", "inf-g-1-1", 1n)] },
			"chat-live-y-y": { chat: makeChat("chat-live-y-y"), messages: [optimistic("chat-live-y-y", "inf-l-1-1", 1n)] }
		})
		// Only the live chat comes back from the server; the gone chat is pruned.
		listChats.mockResolvedValue([makeChat("chat-live-y-y")])
		sendChatMessage.mockRejectedValue({ species: "sdk", kind: "Reqwest", label: "net", message: "net" })

		const fresh = new Sync()
		fresh.start()
		await tick()
		await tick()

		const queue = useChatsInflightStore.getState().inflightMessages
		expect(queue["chat-gone-x-x"]).toBeUndefined()
		expect(queue["chat-live-y-y"]?.messages).toHaveLength(1)
	})
})

describe("offline — a queued send is kept forever, never dropped, until reconnect", () => {
	it("does not send while offline and preserves the durable queue", async () => {
		onlineManager.setOnline(false)

		await enqueueChatMessage({ chat: makeChat("chat-a-a-a"), content: "hi", sender: SENDER })
		await tick()

		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(persistedQueue()?.["chat-a-a-a"]?.messages).toHaveLength(1)
	})
})

describe("durable schema — corrupt kv is rejected (dropped by the kv adapter on read)", () => {
	it("accepts a well-formed queue and rejects a malformed one", () => {
		const good = {
			"chat-a-a-a": { chat: { uuid: "chat-a-a-a" }, messages: [optimistic("chat-a-a-a", "inf-1-1-1", 1n)] }
		}
		expect(inflightChatMessagesSchema(good) instanceof type.errors).toBe(false)

		// messages missing entirely → invalid.
		expect(inflightChatMessagesSchema({ "chat-a-a-a": { chat: {} } }) instanceof type.errors).toBe(true)
		// a message entry missing its inflightId → invalid.
		expect(
			inflightChatMessagesSchema({ "chat-a-a-a": { chat: {}, messages: [{ uuid: "x", chat: "c", sentTimestamp: 1n }] } }) instanceof
				type.errors
		).toBe(true)
	})
})
