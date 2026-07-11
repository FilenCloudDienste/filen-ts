import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams (same as chatsOutbox.test): the sdk client, the kv adapter and the persisted query client
// are mocked so the outbox runs under node vitest. This file exercises the leader-owned MULTI-TAB layer:
// follower routing, leader ingest, reconcile-on-broadcast, and the leadership-change replay. The cross-tab
// CHANNEL + db-lock signal are mocked at the transport seam (sync.attachTransport) and by driving role methods
// directly — no real BroadcastChannel/Web Locks.
const { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } = vi.hoisted(() => ({
	sendChatMessage: vi.fn<(chat: Chat, message: string, replyTo?: unknown) => Promise<Chat>>(),
	markChatRead: vi.fn(() => Promise.resolve()),
	updateLastChatFocusTimesNow: vi.fn((chats: Chat[]) => Promise.resolve(chats)),
	listChats: vi.fn(() => Promise.resolve([] as Chat[])),
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

import { Sync } from "@/features/chats/lib/sync"
import {
	buildOptimisticMessage,
	reconcileChatFollower,
	type OptimisticSender,
	type RemoteChatEnqueue
} from "@/features/chats/lib/sync.logic"
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

function group(chatUuid: string, ...messages: ChatMessageWithInflightId[]): InflightChatMessages {
	return { [chatUuid]: { chat: makeChat(chatUuid), messages } }
}

// Inferred return type keeps each field a precisely-typed Mock<Sig> — assignable to ChatOutboxTransport AND
// carrying .mock/.mockClear. An explicit mapped-type annotation collapses them to a bare Mock, no longer
// assignable to the method signatures, so it is deliberately left to inference.
function mockTransport() {
	return {
		sendEnqueue: vi.fn<(msg: RemoteChatEnqueue) => void>(),
		sendExecuteNow: vi.fn<() => void>(),
		requestState: vi.fn<() => void>(),
		broadcastState: vi.fn<(state: InflightChatMessages) => void>(),
		broadcastLeaderHello: vi.fn<() => void>()
	}
}

// Throw-helper (project lint forbids both bare null-strip `as` and `!`): narrow the first forwarded send
// without an assertion.
function firstEnqueue(transport: ReturnType<typeof mockTransport>): RemoteChatEnqueue {
	const msg = transport.sendEnqueue.mock.calls[0]?.[0]

	if (msg === undefined) {
		throw new Error("expected a forwarded send")
	}

	return msg
}

function getStore(): InflightChatMessages {
	return useChatsInflightStore.getState().inflightMessages
}

function inflightIds(chatUuid: string): string[] {
	return (getStore()[chatUuid]?.messages ?? []).map(m => m.inflightId)
}

function pushedChatUuids(): string[] {
	return sendChatMessage.mock.calls.map(call => call[0].uuid).sort()
}

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 15))
}

beforeEach(() => {
	kvStore.clear()
	vi.clearAllMocks()
	onlineManager.setOnline(true)
	useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {} })
	sendChatMessage.mockImplementation((chat: Chat) =>
		Promise.resolve({
			...chat,
			lastMessage: {
				uuid: `srv-${chat.uuid}` as ChatMessageWithInflightId["uuid"],
				chat: chat.uuid,
				senderId: 7,
				senderEmail: "me@filen.io",
				senderNickName: "Me",
				message: "hi",
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 1n
			}
		})
	)
})

afterEach(() => {
	onlineManager.setOnline(true)
})

// ── reconcileChatFollower (pure) ────────────────────────────────────────────

describe("reconcileChatFollower — leader-authoritative + optimistic overlay", () => {
	it("keeps an unacked send the leader has NOT caught up to (it wins the union)", () => {
		const unacked = group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n))
		const leaderState: InflightChatMessages = {}

		const { store, unacked: remaining } = reconcileChatFollower(leaderState, unacked)

		expect(inflightIdsOf(store, "chat-a-a-a")).toEqual(["inf-1-1-1"])
		expect(remaining["chat-a-a-a"]).toBeDefined()
	})

	it("confirms (drops from unacked) once the leader's state carries our inflightId, mirroring the leader", () => {
		const unacked = group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n))
		const leaderState = group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n))

		const { store, unacked: remaining } = reconcileChatFollower(leaderState, unacked)

		expect(remaining["chat-a-a-a"]).toBeUndefined()
		expect(inflightIdsOf(store, "chat-a-a-a")).toEqual(["inf-1-1-1"])
	})

	it("drains: a confirmed send absent from a later leader state disappears from the follower", () => {
		const first = reconcileChatFollower(
			group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n)),
			group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n))
		)

		expect(first.unacked["chat-a-a-a"]).toBeUndefined()

		// Leader pushed + drained → its state omits the chat → follower store clears it.
		const second = reconcileChatFollower({}, first.unacked)

		expect(second.store["chat-a-a-a"]).toBeUndefined()
	})

	it("keeps ONLY the still-unacked send when the leader confirmed a sibling in the same chat", () => {
		const unacked = group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n), optimistic("chat-a-a-a", "inf-2-2-2", 200n))
		// Leader has the first send but not the second (in flight).
		const leaderState = group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 100n))

		const { store, unacked: remaining } = reconcileChatFollower(leaderState, unacked)

		expect(inflightIdsOf(remaining, "chat-a-a-a")).toEqual(["inf-2-2-2"])
		// The union keeps BOTH visible (leader's confirmed one + the still-pending optimistic one).
		expect(new Set(inflightIdsOf(store, "chat-a-a-a"))).toEqual(new Set(["inf-1-1-1", "inf-2-2-2"]))
	})
})

function inflightIdsOf(state: InflightChatMessages, chatUuid: string): string[] {
	return (state[chatUuid]?.messages ?? []).map(m => m.inflightId)
}

// ── Follower routing ────────────────────────────────────────────────────────

describe("follower send — optimistic local apply + forward, no disk", () => {
	it("applies to the local store AND forwards the send; never persists, never paints its own query cache", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const chat = makeChat("chat-a-a-a")
		const flushed = await s.enqueue({ chat, content: "hi", sender: SENDER })

		// Optimistic: the store shows it immediately (composeMessageList re-injects it as a pending bubble).
		expect(getStore()["chat-a-a-a"]?.messages).toHaveLength(1)
		// Follower reports success without a disk write (the leader owns durability).
		expect(flushed).toBe(true)
		expect(kvSetJson).not.toHaveBeenCalled()

		// Forwarded to the leader, carrying the chat + the fully-built optimistic message.
		expect(transport.sendEnqueue).toHaveBeenCalledTimes(1)
		const forwarded = firstEnqueue(transport)

		expect(forwarded.chat.uuid).toBe("chat-a-a-a")
		expect(forwarded.message.message).toBe("hi")
		// A follower never runs the loop.
		expect(sendChatMessage).not.toHaveBeenCalled()
	})

	it("forwards a flush request on executeNow instead of running a pass", () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()
		s.executeNow()

		expect(transport.sendExecuteNow).toHaveBeenCalledTimes(1)
		expect(sendChatMessage).not.toHaveBeenCalled()
	})

	it("requests the leader's current state on start (catch up to another tab's pending send)", () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		expect(transport.requestState).toHaveBeenCalledTimes(1)
	})
})

describe("follower reconcile-on-broadcast — pending bubble clears when the leader drains", () => {
	it("drops the send from the store once the leader confirms then drains it", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		const chat = makeChat("chat-a-a-a")

		await s.enqueue({ chat, content: "hi", sender: SENDER })
		const forwarded = firstEnqueue(transport)

		// Leader confirms receipt (its state carries our inflightId).
		s.applyLeaderState(group("chat-a-a-a", forwarded.message))
		expect(getStore()["chat-a-a-a"]?.messages).toHaveLength(1)

		// Leader committed + drained → empty state → the follower's pending bubble clears.
		s.applyLeaderState({})
		expect(getStore()["chat-a-a-a"]).toBeUndefined()
	})
})

describe("follower re-send on takeover announcement", () => {
	it("re-forwards every still-unacked send when a new leader says hello", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		await s.enqueue({ chat: makeChat("chat-a-a-a"), content: "one", sender: SENDER })
		await s.enqueue({ chat: makeChat("chat-b-b-b"), content: "two", sender: SENDER })
		transport.sendEnqueue.mockClear()

		// The old leader died before confirming; a new leader announces itself.
		s.resendUnacked()

		expect(transport.sendEnqueue).toHaveBeenCalledTimes(2)
		const chats = transport.sendEnqueue.mock.calls.map(c => c[0].chat.uuid).sort()

		expect(chats).toEqual(["chat-a-a-a", "chat-b-b-b"])
	})
})

// ── Leader ingest ───────────────────────────────────────────────────────────

describe("leader ingest — union a forwarded send, persist, broadcast, push", () => {
	async function startedLeader(): Promise<{ s: Sync; transport: ReturnType<typeof mockTransport> }> {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.start() // leader replay-on-launch (empty disk) resolves init
		await tick()
		transport.broadcastState.mockClear()

		return { s, transport }
	}

	it("ingests a forwarded send, persists it, then broadcasts the new queue", async () => {
		const { s, transport } = await startedLeader()
		const chat = makeChat("chat-a-a-a")

		s.ingestRemoteEnqueue({ chat, message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await tick()

		// The send was pushed to the server, persisted along the way, and the queue broadcast to followers.
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(kvSetJson).toHaveBeenCalledWith("inflightChatMessages", expect.any(Object))
		expect(transport.broadcastState).toHaveBeenCalled()
	})

	it("is idempotent by inflightId — a re-forwarded send collapses to one queue entry", async () => {
		const { s } = await startedLeader()
		// Never resolve the send so the entry stays queued and the union is observable.
		sendChatMessage.mockImplementation(() => new Promise(() => undefined))

		const chat = makeChat("chat-a-a-a")
		const message = optimistic("chat-a-a-a", "inf-dup-1-1", 500n)

		s.ingestRemoteEnqueue({ chat, message })
		s.ingestRemoteEnqueue({ chat, message })
		await tick()

		expect(inflightIds("chat-a-a-a")).toEqual(["inf-dup-1-1"])
	})
})

// ── Leadership-change replay (failover) ─────────────────────────────────────

describe("promoteToLeader — a follower wins the lock and pushes carried-over work", () => {
	it("pushes an optimistic send the follower held locally even when disk was empty", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		// Follower sent a message; it lives in the store optimistically. The dead leader never persisted it.
		await s.enqueue({ chat: makeChat("chat-z-z-z"), content: "z", sender: SENDER })
		expect(kvStore.get("inflightChatMessages")).toBeUndefined()

		// The leader died → this follower is promoted.
		s.promoteToLeader()
		await tick()

		// The message reaches the server without any user action, and this tab announced its takeover.
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(pushedChatUuids()).toEqual(["chat-z-z-z"])
		expect(transport.broadcastLeaderHello).toHaveBeenCalledTimes(1)
	})

	it("merges disk state persisted by the dead leader with the follower's local store, then pushes both", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.startAsFollower()

		// The dead leader persisted D to disk; the follower still holds L optimistically.
		kvStore.set("inflightChatMessages", group("chat-d-d-d", optimistic("chat-d-d-d", "inf-d-1-1", 1n)))
		await s.enqueue({ chat: makeChat("chat-l-l-l"), content: "l", sender: SENDER })

		// Both chats must survive the restore prune.
		listChats.mockResolvedValue([makeChat("chat-d-d-d"), makeChat("chat-l-l-l")])

		s.promoteToLeader()
		await tick()

		expect(pushedChatUuids()).toEqual(["chat-d-d-d", "chat-l-l-l"])
	})
})
