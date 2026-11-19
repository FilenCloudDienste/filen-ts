import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams (same shape as chatsMultiTabOutbox.test): the sdk client, the kv adapter and the
// persisted query client are mocked so the outbox runs under node vitest. This file pins the multi-tab
// LEADER LIFECYCLE hardening: the role state machine (unresolved no-ops leader ingestion; a terminal cancel
// flips to shutdown and gates ingest + flush + closes the channel), the committed-id ledger (a late re-forward
// of an already-committed send is dropped, never re-sent), and closeOutbox itself.
const { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } = await vi.hoisted(async () =>
	(await import("@/tests/support/chatsOutbox")).chatsSdkMocks()
)

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } }))

const { kvStore, kvGetJson, kvSetJson, kvDelete } = await vi.hoisted(async () =>
	(await import("@/tests/support/chatsOutbox")).chatsKvMocks()
)

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson, kvDelete }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { Sync } from "@/features/chats/lib/sync"
import { CommittedIdLedger, type RemoteChatEnqueue } from "@/features/chats/lib/sync.logic"
import { useChatsInflightStore, type InflightChatMessages } from "@/features/chats/store/useChatsInflight"
import { confirmedMessage, getStore, group, inflightIds, mockTransport, optimistic, outboxChat, settle } from "@/tests/support/chatsOutbox"
import {
	closeOutbox,
	decodeOutboxPayload,
	makeOutboxChannelTransport,
	routeOutboxMessage,
	type OutboxChannelMsg,
	type OutboxRole,
	type OutboxRoute
} from "@/lib/storage/outboxChannel"
import { inflightChatMessagesSchema, remoteChatEnqueueSchema } from "@/features/chats/lib/sync.logic"

beforeEach(() => {
	kvStore.clear()
	vi.clearAllMocks()
	onlineManager.setOnline(true)
	useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {} })
	sendChatMessage.mockImplementation((chat: Chat) =>
		Promise.resolve({
			...chat,
			lastMessage: confirmedMessage(chat.uuid, `srv-${chat.uuid}`)
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

		s.ingestRemoteEnqueue({ chat: outboxChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await settle()

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
		await settle()
		vi.clearAllMocks()

		s.cancel()

		expect(s.outboxRole).toBe("shutdown")
		expect(transport.close).toHaveBeenCalledTimes(1)

		// A forward landing after the terminal shutdown is ignored — no re-queue, no send.
		s.ingestRemoteEnqueue({ chat: outboxChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await settle()

		expect(getStore()["chat-a-a-a"]).toBeUndefined()
		expect(sendChatMessage).not.toHaveBeenCalled()
	})

	it("flushToDisk refuses to persist after a terminal cancel() (the wipe is never resurrected)", async () => {
		const s = new Sync()

		s.start()
		await settle()
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
		await settle()

		return { s, transport }
	}

	it("drops a re-forward whose inflightId was already committed + dequeued (no second send)", async () => {
		const { s } = await startedLeader()
		const message = optimistic("chat-a-a-a", "inf-dup-1-1", 500n)

		s.ingestRemoteEnqueue({ chat: outboxChat("chat-a-a-a"), message })
		await settle()

		// First forward: committed once, then dequeued.
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(inflightIds("chat-a-a-a")).toEqual([])

		sendChatMessage.mockClear()

		// A surviving follower re-forwards the SAME id on a takeover — it was already committed, so drop it.
		s.ingestRemoteEnqueue({ chat: outboxChat("chat-a-a-a"), message })
		await settle()

		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(inflightIds("chat-a-a-a")).toEqual([])
	})

	it("still ingests a genuinely-new id after a committed one", async () => {
		const { s } = await startedLeader()

		s.ingestRemoteEnqueue({ chat: outboxChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 500n) })
		await settle()
		sendChatMessage.mockClear()

		s.ingestRemoteEnqueue({ chat: outboxChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-2-2-2", 600n) })
		await settle()

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

// ── transport payloads ──────────────────────────────────────────────────────

describe("outbox transport — payloads cross as structured clones", () => {
	it("a forwarded send arrives with its bigints intact and validates", async () => {
		const sender = new BroadcastChannel("filen-web-test-outbox-payload")
		const receiver = new BroadcastChannel("filen-web-test-outbox-payload")
		const received = new Promise<OutboxChannelMsg>(resolve => {
			receiver.onmessage = (ev: MessageEvent<OutboxChannelMsg>) => {
				resolve(ev.data)
			}
		})
		const forward: RemoteChatEnqueue = { chat: outboxChat("c1"), message: optimistic("c1", "i1", 5n) }

		makeOutboxChannelTransport<RemoteChatEnqueue, InflightChatMessages>(sender).sendEnqueue(forward)

		const msg = await received

		closeOutbox(sender)
		closeOutbox(receiver)

		expect(msg.kind).toBe("enqueue")

		const decoded = msg.kind === "enqueue" ? decodeOutboxPayload(msg.payload, remoteChatEnqueueSchema, "forwarded send") : null

		expect(decoded?.message.sentTimestamp).toBe(5n)
		expect(decoded?.chat.ownerId).toBe(7n)
	})

	it("skips the full-state broadcast until a peer is heard on the channel, and gates nothing else", async () => {
		const leader = new BroadcastChannel("filen-web-test-outbox-peer")
		const peer = new BroadcastChannel("filen-web-test-outbox-peer")
		const post = vi.spyOn(leader, "postMessage")
		const transport = makeOutboxChannelTransport<RemoteChatEnqueue, InflightChatMessages>(leader)
		const heard = new Promise<void>(resolve => {
			leader.onmessage = () => {
				resolve()
			}
		})

		transport.broadcastState({})
		transport.broadcastLeaderHello()

		expect(post.mock.calls).toEqual([[{ kind: "leaderHello" }]])

		peer.postMessage({ kind: "stateRequest" } satisfies OutboxChannelMsg)
		await heard
		transport.broadcastState({})

		closeOutbox(leader)
		closeOutbox(peer)

		expect(post.mock.calls).toEqual([[{ kind: "leaderHello" }], [{ kind: "state", payload: {} }]])
	})

	it("an invalid payload is dropped, never thrown", () => {
		expect(decodeOutboxPayload({ chat: "nope" }, remoteChatEnqueueSchema, "forwarded send")).toBeNull()
		expect(decodeOutboxPayload("a string", remoteChatEnqueueSchema, "forwarded send")).toBeNull()
	})
})

// ── routeOutboxMessage ──────────────────────────────────────────────────────

describe("routeOutboxMessage — role-routed dispatch of the shared kinds", () => {
	const route: OutboxRoute<RemoteChatEnqueue, InflightChatMessages> = {
		enqueueSchema: remoteChatEnqueueSchema,
		stateSchema: inflightChatMessagesSchema,
		enqueueLabel: "forwarded send",
		stateLabel: "leader state"
	}

	function target(outboxRole: OutboxRole) {
		return {
			outboxRole,
			ingestRemoteEnqueue: vi.fn(),
			executeNow: vi.fn(),
			broadcastState: vi.fn(),
			applyLeaderState: vi.fn(),
			resendUnacked: vi.fn(),
			applyLeaderFailed: vi.fn()
		}
	}

	const forward: RemoteChatEnqueue = { chat: outboxChat("c1"), message: optimistic("c1", "i1", 5n) }
	const all: OutboxChannelMsg[] = [
		{ kind: "enqueue", payload: forward },
		{ kind: "executeNow" },
		{ kind: "stateRequest" },
		{ kind: "state", payload: {} },
		{ kind: "leaderHello" },
		{ kind: "failed", payload: "dropped" },
		{ kind: "drop", id: "n1" }
	]

	it("a leader acts on follower forwards only", () => {
		const t = target("leader")

		for (const msg of all) {
			routeOutboxMessage(msg, t, route)
		}

		expect(t.ingestRemoteEnqueue).toHaveBeenCalledTimes(1)
		expect(t.executeNow).toHaveBeenCalledTimes(1)
		expect(t.broadcastState).toHaveBeenCalledTimes(1)
		expect(t.applyLeaderState).not.toHaveBeenCalled()
		expect(t.resendUnacked).not.toHaveBeenCalled()
		expect(t.applyLeaderFailed).not.toHaveBeenCalled()
	})

	it("any other role acts on leader broadcasts only", () => {
		for (const role of ["follower", "unresolved"] as const) {
			const t = target(role)

			for (const msg of all) {
				routeOutboxMessage(msg, t, route)
			}

			expect(t.ingestRemoteEnqueue).not.toHaveBeenCalled()
			expect(t.executeNow).not.toHaveBeenCalled()
			expect(t.broadcastState).not.toHaveBeenCalled()
			expect(t.applyLeaderState).toHaveBeenCalledWith({})
			expect(t.resendUnacked).toHaveBeenCalledTimes(1)
			expect(t.applyLeaderFailed).toHaveBeenCalledWith("dropped")
		}
	})

	it("an invalid payload is dropped before it reaches the target", () => {
		const leader = target("leader")
		const follower = target("follower")

		routeOutboxMessage({ kind: "enqueue", payload: { chat: "nope" } }, leader, route)
		routeOutboxMessage({ kind: "state", payload: "nope" }, follower, route)

		expect(leader.ingestRemoteEnqueue).not.toHaveBeenCalled()
		expect(follower.applyLeaderState).not.toHaveBeenCalled()
	})
})
