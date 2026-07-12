import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams (same shape as chatsMultiTabOutbox.test): the sdk client, the kv adapter and the
// persisted query client are mocked so the outbox runs under node vitest. This file pins the multi-tab
// LEADER LIFECYCLE hardening: the role state machine (unresolved no-ops leader ingestion; a terminal cancel
// flips to shutdown and gates ingest + flush + closes the channel), the committed-id ledger (a late re-forward
// of an already-committed send is dropped, never re-sent), and closeOutbox itself.
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
import { buildOptimisticMessage, CommittedIdLedger, type OptimisticSender, type RemoteChatEnqueue } from "@/features/chats/lib/sync.logic"
import useChatsInflightStore, { type ChatMessageWithInflightId, type InflightChatMessages } from "@/features/chats/store/useChatsInflight"
import { closeOutbox } from "@/lib/storage/outboxChannel"

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

function mockTransport() {
	return {
		sendEnqueue: vi.fn<(msg: RemoteChatEnqueue) => void>(),
		sendExecuteNow: vi.fn<() => void>(),
		requestState: vi.fn<() => void>(),
		broadcastState: vi.fn<(state: InflightChatMessages) => void>(),
		broadcastLeaderHello: vi.fn<() => void>(),
		close: vi.fn<() => void>()
	}
}

function getStore(): InflightChatMessages {
	return useChatsInflightStore.getState().inflightMessages
}

function inflightIds(chatUuid: string): string[] {
	return (getStore()[chatUuid]?.messages ?? []).map(m => m.inflightId)
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

// ── Role state machine ──────────────────────────────────────────────────────

describe("outbox role state machine — unresolved / leader / follower / shutdown", () => {
	it("starts unresolved and NO-OPS leader-branch ingestion until the role resolves (no phantom paint)", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		// Deliberately no start()/startAsFollower(): leadership is not yet decided.
		expect(s.outboxRole).toBe("unresolved")

		s.ingestRemoteEnqueue({ chat: makeChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await tick()

		// A forward arriving before the role resolves paints nothing, sends nothing, persists nothing.
		expect(getStore()["chat-a-a-a"]).toBeUndefined()
		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("terminal cancel() flips to shutdown, closes the channel, and no longer ingests forwards", async () => {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.start()
		await tick()
		vi.clearAllMocks()

		s.cancel()

		expect(s.outboxRole).toBe("shutdown")
		expect(transport.close).toHaveBeenCalledTimes(1)

		// A forward landing after the terminal shutdown is ignored — no re-queue, no send.
		s.ingestRemoteEnqueue({ chat: makeChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await tick()

		expect(getStore()["chat-a-a-a"]).toBeUndefined()
		expect(sendChatMessage).not.toHaveBeenCalled()
	})

	it("flushToDisk refuses to persist after a terminal cancel() (the wipe is never resurrected)", async () => {
		const s = new Sync()

		s.start()
		await tick()
		s.cancel()
		kvSetJson.mockClear()

		const persisted = await s.flushToDisk(group("chat-a-a-a", optimistic("chat-a-a-a", "inf-1-1-1", 500n)))

		expect(persisted).toBe(false)
		expect(kvSetJson).not.toHaveBeenCalled()
	})
})

// ── Committed-id ledger — cross-tab double-send guard ───────────────────────

describe("committed-id ledger — a late re-forward of a committed send is dropped", () => {
	async function startedLeader(): Promise<{ s: Sync; transport: ReturnType<typeof mockTransport> }> {
		const s = new Sync()
		const transport = mockTransport()

		s.attachTransport(transport)
		s.start()
		await tick()

		return { s, transport }
	}

	it("drops a re-forward whose inflightId was already committed + dequeued (no second send)", async () => {
		const { s } = await startedLeader()
		const message = optimistic("chat-a-a-a", "inf-dup-1-1", 500n)

		s.ingestRemoteEnqueue({ chat: makeChat("chat-a-a-a"), message })
		await tick()

		// First forward: committed once, then dequeued.
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(inflightIds("chat-a-a-a")).toEqual([])

		sendChatMessage.mockClear()

		// A surviving follower re-forwards the SAME id on a takeover — it was already committed, so drop it.
		s.ingestRemoteEnqueue({ chat: makeChat("chat-a-a-a"), message })
		await tick()

		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(inflightIds("chat-a-a-a")).toEqual([])
	})

	it("still ingests a genuinely-new id after a committed one", async () => {
		const { s } = await startedLeader()

		s.ingestRemoteEnqueue({ chat: makeChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await tick()
		sendChatMessage.mockClear()

		s.ingestRemoteEnqueue({ chat: makeChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-2-2-2", 600n) })
		await tick()

		expect(sendChatMessage).toHaveBeenCalledTimes(1)
	})
})

// ── CommittedIdLedger (pure, bounded) ───────────────────────────────────────

describe("CommittedIdLedger — bounded, insertion-ordered", () => {
	it("evicts the oldest id (FIFO) once capacity is exceeded", () => {
		const ledger = new CommittedIdLedger(3)

		ledger.record("a")
		ledger.record("b")
		ledger.record("c")
		ledger.record("d")

		expect(ledger.size).toBe(3)
		expect(ledger.has("a")).toBe(false)
		expect(ledger.has("b")).toBe(true)
		expect(ledger.has("c")).toBe(true)
		expect(ledger.has("d")).toBe(true)
	})

	it("re-recording an id refreshes its recency so it is not evicted early", () => {
		const ledger = new CommittedIdLedger(3)

		ledger.record("a")
		ledger.record("b")
		ledger.record("c")
		ledger.record("a") // a is now the most-recent
		ledger.record("d") // evicts b (the oldest), not a

		expect(ledger.has("a")).toBe(true)
		expect(ledger.has("b")).toBe(false)
		expect(ledger.has("c")).toBe(true)
		expect(ledger.has("d")).toBe(true)
	})

	it("never exceeds capacity across many records", () => {
		const ledger = new CommittedIdLedger(2)

		for (let i = 0; i < 100; i++) {
			ledger.record(`id-${String(i)}`)
		}

		expect(ledger.size).toBe(2)
		expect(ledger.has("id-99")).toBe(true)
		expect(ledger.has("id-98")).toBe(true)
		expect(ledger.has("id-97")).toBe(false)
	})
})

// ── closeOutbox ─────────────────────────────────────────────────────────────

describe("closeOutbox — detaches the handler and closes the channel", () => {
	it("nulls onmessage and rejects any further postMessage", () => {
		const channel = new BroadcastChannel("filen-web-test-outbox-lifecycle")

		channel.onmessage = () => undefined

		closeOutbox(channel)

		expect(channel.onmessage).toBeNull()
		expect(() => {
			channel.postMessage("x")
		}).toThrow()
	})
})
