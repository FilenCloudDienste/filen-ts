import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Worker-free seams from the shared outbox harness (tests/support/chatsOutbox). This file exercises the PUSH
// loop: sequential per-chat order, dequeue-on-commit + cache patch, the commit-boundary never-rethrow
// tail, the 3-strike failed transition + retry/remove, and the logout-abort flush suppression.
const { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } = await vi.hoisted(async () =>
	(await import("@/tests/support/chatsOutbox")).chatsSdkMocks()
)

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendChatMessage, markChatRead, updateLastChatFocusTimesNow, listChats, getChat } }))

const { kvStore, kvGetJson, kvSetJson, kvDelete } = await vi.hoisted(async () =>
	(await import("@/tests/support/chatsOutbox")).chatsKvMocks()
)

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson, kvDelete }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { Sync, sync, enqueueChatMessage } from "@/features/chats/lib/sync"
import { retryInflightMessage, removeInflightMessage } from "@/features/chats/lib/inflight"
import { log } from "@/lib/log"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { chatsQueryGet, chatsQueryUpdate, chatsQueryUpsert } from "@/features/chats/queries/chats"
import {
	useChatsInflightStore,
	type ChatMessageWithInflightId,
	type InflightChatMessageError,
	type InflightChatMessageErrors,
	type InflightChatMessages
} from "@/features/chats/store/useChatsInflight"
import { SENDER, confirmedMessage, group, mockTransport, optimistic, outboxChat, tick } from "@/tests/support/chatsOutbox"

function seed(chatUuid: string, messages: ChatMessageWithInflightId[]): void {
	useChatsInflightStore.setState(prev => ({
		inflightMessages: { ...prev.inflightMessages, [chatUuid]: { chat: outboxChat(chatUuid), messages } },
		inflightErrors: prev.inflightErrors
	}))
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
	sendChatMessage.mockImplementation((chat: Chat) => Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-1-1-1") }))
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

			return Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, `srv-${message}`) })
		})

		seed("chat-a-a-a", [
			optimistic("chat-a-a-a", "inf-3-3-3", 300n, "m3"),
			optimistic("chat-a-a-a", "inf-1-1-1", 100n, "m1"),
			optimistic("chat-a-a-a", "inf-2-2-2", 200n, "m2")
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

			return Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-1-1-1") })
		})

		// Simulate a disk-restored queue: the stored `chat` is a stale snapshot the wasm send must NOT use
		// (on the real surface it wedges the loop). It carries a sentinel name so the assertion can prove
		// the send did not touch it.
		const stale: Chat = { ...outboxChat("chat-a-a-a"), name: "STALE_DISK_SNAPSHOT" }

		useChatsInflightStore.setState({
			inflightMessages: { "chat-a-a-a": { chat: stale, messages: [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")] } },
			inflightErrors: {}
		})

		// A LIVE chat is warm in the list cache (restore's cache-warm / the sidebar).
		chatsQueryUpsert({ ...outboxChat("chat-a-a-a"), name: "LIVE" })

		sync.syncNow()
		await tick()
		await tick()

		expect(sentChat?.name).toBe("LIVE")
		expect(getChat).not.toHaveBeenCalled()
		expect(queue()["chat-a-a-a"]).toBeUndefined()
	})

	it("falls back to getChat when the list cache misses (a fresh-boot /drive shell, list not mounted)", async () => {
		seed("chat-c-c-c", [optimistic("chat-c-c-c", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()
		await tick()

		expect(getChat).toHaveBeenCalledWith("chat-c-c-c")
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(queue()["chat-c-c-c"]).toBeUndefined()
	})
})

describe("a chat deleted while its socket event was missed", () => {
	it("drops the chat's queue, failed sends and draft once getChat says it is gone and the list lacks it", async () => {
		chatsQueryUpsert(outboxChat("chat-other-1"))
		seed("chat-gone-1", [optimistic("chat-gone-1", "inf-1-1-1", 1n, "hi")])
		useChatsInflightStore.setState(prev => ({
			inflightErrors: {
				...prev.inflightErrors,
				"inf-2-2-2": {
					error: sdkError("Server"),
					permanentRejections: 3,
					message: optimistic("chat-gone-1", "inf-2-2-2", 2n, "old")
				}
			}
		}))
		getChat.mockResolvedValueOnce(undefined)

		sync.syncNow()
		await tick()
		await tick()

		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(queue()["chat-gone-1"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors).toEqual({})
		expect(kvDelete).toHaveBeenCalledWith(expect.stringContaining("chat-gone-1"))
		// Persisted, so a reload does not restore it either.
		expect(kvStore.get("inflightChatMessages")).toBeUndefined()

		// The next pass has nothing to re-read.
		sync.syncNow()
		await tick()
		await tick()

		expect(getChat).toHaveBeenCalledTimes(1)
	})

	it("keeps the queue for a later pass while the list has not loaded", async () => {
		seed("chat-gone-1", [optimistic("chat-gone-1", "inf-1-1-1", 1n, "hi")])
		getChat.mockResolvedValueOnce(undefined)

		sync.syncNow()
		await tick()
		await tick()

		expect(inflightIdsIn("chat-gone-1")).toEqual(["inf-1-1-1"])
	})

	it("keeps the queue when getChat fails", async () => {
		chatsQueryUpsert(outboxChat("chat-other-1"))
		seed("chat-gone-1", [optimistic("chat-gone-1", "inf-1-1-1", 1n, "hi")])
		getChat.mockRejectedValueOnce(new Error("network down"))

		sync.syncNow()
		await tick()
		await tick()

		expect(inflightIdsIn("chat-gone-1")).toEqual(["inf-1-1-1"])
	})
})

function inflightIdsIn(chatUuid: string): string[] {
	return (queue()[chatUuid]?.messages ?? []).map(m => m.inflightId)
}

describe("commit — dequeue + reconcile the message cache off the returned chat", () => {
	it("replaces the optimistic copy (uuid === inflightId) with the confirmed server message and drains the queue", async () => {
		await enqueueChatMessage({ chat: outboxChat("chat-a-a-a"), content: "hi", sender: SENDER })
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

// The SDK hands back the chat the send started from, with the sent message as its lastMessage.
describe("commit — the conversation row", () => {
	it("shows the sent message and keeps the rest of the cached row", async () => {
		chatsQueryUpsert({ ...outboxChat("chat-a-a-a"), name: "LIVE", lastFocus: 50n })
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()
		await tick()

		expect(chatsQueryGet()).toEqual([
			{ ...outboxChat("chat-a-a-a"), name: "LIVE", lastFocus: 50n, lastMessage: confirmedMessage("chat-a-a-a", "srv-1-1-1") }
		])
	})

	it("adds the chat when the list does not hold it", async () => {
		seed("chat-c-c-c", [optimistic("chat-c-c-c", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()
		await tick()

		expect(chatsQueryGet()).toEqual([{ ...outboxChat("chat-c-c-c"), lastMessage: confirmedMessage("chat-c-c-c", "srv-1-1-1") }])
	})

	it("keeps a reply that landed during the send, and the open chat's read state with it", async () => {
		let releaseSend: (() => void) | undefined
		sendChatMessage.mockImplementation(
			(chat: Chat) =>
				new Promise(resolve => {
					releaseSend = () => {
						resolve({ ...chat, lastMessage: { ...confirmedMessage(chat.uuid, "srv-1-1-1"), sentTimestamp: 100n } })
					}
				})
		)
		chatsQueryUpsert({ ...outboxChat("chat-a-a-a"), lastFocus: 50n })
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await tick()

		// What the socket handler writes for a reply in the open chat.
		const reply = { ...confirmedMessage("chat-a-a-a", "srv-2-2-2"), senderId: 8, sentTimestamp: 200n }
		chatsQueryUpdate(prev => prev.map(c => ({ ...c, lastMessage: reply, lastFocus: 200n })))

		releaseSend?.()
		await tick()
		await tick()

		expect(chatsQueryGet()).toEqual([{ ...outboxChat("chat-a-a-a"), lastFocus: 200n, lastMessage: reply }])
	})
})

describe("commit boundary — the durable dequeue lands BEFORE the best-effort housekeeping", () => {
	it("persists every committed message's dequeue before markChatRead, which fires once per chat per pass", async () => {
		// Both kv writers count as "flush": the first commit leaves one message queued (kvSetJson), the
		// second drains the chat (kvDelete).
		const order: string[] = []

		kvSetJson.mockImplementation((key: string, value: unknown) => {
			order.push("flush")
			kvStore.set(key, value)

			return Promise.resolve()
		})
		kvDelete.mockImplementation((key: string) => {
			order.push("flush")
			kvStore.delete(key)

			return Promise.resolve()
		})
		markChatRead.mockImplementation(() => {
			order.push("markChatRead")

			return Promise.resolve()
		})
		sendChatMessage.mockImplementation((chat: Chat, message: string) =>
			Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, `srv-${message}`) })
		)

		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "m1"), optimistic("chat-a-a-a", "inf-2-2-2", 2n, "m2")])

		sync.syncNow()
		await tick()
		await tick()

		// The trailing flush is the end-of-pass one; markChatRead is reached only after both messages are
		// off disk, and once for the chat's last commit.
		expect(order).toEqual(["flush", "flush", "markChatRead", "flush"])
		expect(markChatRead).toHaveBeenCalledTimes(1)
		// Stamped from the chat the pass's LAST commit returned.
		expect(updateLastChatFocusTimesNow.mock.calls.map(([chats]) => chats.map(chat => chat.lastMessage?.uuid))).toEqual([["srv-m2"]])
		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(kvStore.has("inflightChatMessages")).toBe(false)
	})
})

describe("commit boundary — the post-commit tail never re-throws (no duplicate on a housekeeping failure)", () => {
	it("keeps the message committed + dequeued even when markChatRead rejects after the send resolved", async () => {
		markChatRead.mockRejectedValue(new Error("read failed"))
		updateLastChatFocusTimesNow.mockRejectedValue(new Error("focus failed"))

		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

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
						resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-1-1-1") })
					}
				})
		)

		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

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
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

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
						resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-1-1-1") })
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
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

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
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

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
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		for (let pass = 0; pass < 3; pass += 1) {
			sync.syncNow()
			await tick()
			await tick()
		}

		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeDefined()

		// Now succeed on retry.
		sendChatMessage.mockImplementation((chat: Chat) =>
			Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-1-1-1") })
		)

		await retryInflightMessage({ chat: outboxChat("chat-a-a-a"), message: optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi") })
		await tick()
		await tick()

		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeUndefined()
	})

	it("remove drops the queued entry, its error record and the optimistic cache copy", async () => {
		await enqueueChatMessage({ chat: outboxChat("chat-b-b-b"), content: "hi", sender: SENDER })
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
			await removeInflightMessage({ chat: outboxChat("chat-b-b-b"), message })
		}

		expect(queue()["chat-b-b-b"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors).toEqual({})
		const cached = chatMessagesQueryGet("chat-b-b-b") ?? []
		expect(message ? cached.some(m => m.uuid === message.uuid) : false).toBe(false)
	})
})

describe("a send the leader drops at the rejection bound reaches every tab as failed", () => {
	// A follower's send, forwarded to a leader whose three passes are all rejected. The store is one per tab
	// in the app and one per file here, so each tab's turn runs on its own copy of the store. The follower is
	// the module's own outbox, the one retry/remove drive; beforeEach starts it as leader again.
	async function droppedForward(): Promise<{
		follower: Sync
		followerTransport: ReturnType<typeof mockTransport>
		leader: Sync
		leaderTransport: ReturnType<typeof mockTransport>
		leaderErrors: InflightChatMessageErrors
		inflightId: string
	}> {
		const follower = sync
		const followerTransport = mockTransport()

		follower.attachTransport(followerTransport)
		follower.startAsFollower()

		await follower.enqueue({ chat: outboxChat("chat-f-f-f"), content: "lost text", sender: SENDER })

		const forward = followerTransport.sendEnqueue.mock.calls[0]?.[0]

		if (forward === undefined) {
			throw new Error("expected a forwarded send")
		}

		const followerTab = useChatsInflightStore.getState()

		useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {}, sendingInflightIds: {} })

		const leader = new Sync()
		const leaderTransport = mockTransport()

		leader.attachTransport(leaderTransport)
		leader.start()
		await tick()

		sendChatMessage.mockRejectedValue(sdkError("Server"))
		leader.ingestRemoteEnqueue(forward)
		await tick()
		await tick()

		for (let pass = 0; pass < 2; pass += 1) {
			leader.syncNow()
			await tick()
			await tick()
		}

		const leaderTab = useChatsInflightStore.getState()

		// Back to the follower tab: it has seen the leader confirm the forward.
		useChatsInflightStore.setState({
			inflightMessages: followerTab.inflightMessages,
			inflightErrors: followerTab.inflightErrors,
			sendingInflightIds: {}
		})
		follower.applyLeaderState(group("chat-f-f-f", forward.message))

		expect(leaderTab.inflightErrors[forward.message.inflightId]?.permanentRejections).toBe(3)

		return {
			follower,
			followerTransport,
			leader,
			leaderTransport,
			leaderErrors: leaderTab.inflightErrors,
			inflightId: forward.message.inflightId
		}
	}

	it("shows a follower its dropped send as failed, with the text, instead of removing the bubble", async () => {
		const { follower, followerTransport, leaderTransport, inflightId } = await droppedForward()

		expect(leaderTransport.broadcastFailed).toHaveBeenCalledTimes(1)

		for (const [failed] of leaderTransport.broadcastFailed.mock.calls) {
			follower.applyLeaderFailed(structuredClone(failed))
		}

		// The leader's next state broadcast no longer lists the send.
		follower.applyLeaderState({})

		expect(queue()["chat-f-f-f"]).toBeUndefined()
		const failed = useChatsInflightStore.getState().inflightErrors[inflightId]
		expect(failed?.message.message).toBe("lost text")
		expect(failed?.permanentRejections).toBe(3)

		// Settled: a takeover does not forward it again.
		follower.resendUnacked()
		expect(followerTransport.sendEnqueue).toHaveBeenCalledTimes(1)
	})

	it("retries a follower's failed send through the leader, which gives it a fresh rejection budget", async () => {
		const { follower, followerTransport, leader, leaderTransport, leaderErrors, inflightId } = await droppedForward()
		const failed = leaderTransport.broadcastFailed.mock.calls[0]?.[0]

		if (failed === undefined) {
			throw new Error("expected a dropped send")
		}

		follower.applyLeaderFailed(failed)
		follower.applyLeaderState({})
		sendChatMessage.mockClear()

		await retryInflightMessage({ chat: outboxChat("chat-f-f-f"), message: failed.message })

		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(useChatsInflightStore.getState().inflightErrors[inflightId]).toBeUndefined()
		expect(queue()["chat-f-f-f"]?.messages.map(m => m.inflightId)).toEqual([inflightId])

		const retry = followerTransport.sendEnqueue.mock.calls[1]?.[0]

		if (retry === undefined) {
			throw new Error("expected the retry to be forwarded")
		}

		// The leader confirms it with its next state broadcast.
		follower.applyLeaderState(group("chat-f-f-f", retry.message))

		// The leader tab, still holding its record of the drop, takes the retry and sends it.
		useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: leaderErrors, sendingInflightIds: {} })
		sendChatMessage.mockImplementation((chat: Chat) =>
			Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-9-9-9") })
		)

		leader.ingestRemoteEnqueue(retry)
		await tick()
		await tick()

		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(useChatsInflightStore.getState().inflightErrors[inflightId]).toBeUndefined()
		expect(queue()["chat-f-f-f"]).toBeUndefined()
	})

	// A send from the leader tab itself, rejected three times there. Returns the leader tab's store and the
	// dropped entry it broadcast; the leader is the module's own outbox, the one retry drives.
	async function droppedLocal(leaderTransport: ReturnType<typeof mockTransport>): Promise<InflightChatMessageError> {
		sync.attachTransport(leaderTransport)
		seed("chat-l-l-l", [optimistic("chat-l-l-l", "inf-l-l-l", 1n, "leader text")])
		sendChatMessage.mockRejectedValue(sdkError("Server"))

		for (let pass = 0; pass < 3; pass += 1) {
			sync.syncNow()
			await tick()
			await tick()
		}

		const failed = leaderTransport.broadcastFailed.mock.calls[0]?.[0]

		if (failed === undefined) {
			throw new Error("expected a dropped send")
		}

		return failed
	}

	it("clears a follower's failed record when a retry in the leader tab queues the send again and commits it", async () => {
		const leaderTransport = mockTransport()
		const failed = await droppedLocal(leaderTransport)
		const inflightId = failed.message.inflightId
		const leaderTab = useChatsInflightStore.getState()

		// The follower tab has the dropped send as failed.
		useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {}, sendingInflightIds: {} })

		const follower = new Sync()

		follower.attachTransport(mockTransport())
		follower.startAsFollower()
		follower.applyLeaderFailed(structuredClone(failed))
		follower.applyLeaderState({})
		expect(useChatsInflightStore.getState().inflightErrors[inflightId]?.message.message).toBe("leader text")

		const followerTab = useChatsInflightStore.getState()

		// Retry in the leader tab, which now commits.
		useChatsInflightStore.setState({
			inflightMessages: leaderTab.inflightMessages,
			inflightErrors: leaderTab.inflightErrors,
			sendingInflightIds: {}
		})
		leaderTransport.broadcastState.mockClear()
		sendChatMessage.mockImplementation((chat: Chat) =>
			Promise.resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-7-7-7") })
		)

		await retryInflightMessage({ chat: outboxChat("chat-l-l-l"), message: failed.message })
		await tick()
		await tick()

		expect(sendChatMessage).toHaveBeenCalledTimes(4)

		const states = leaderTransport.broadcastState.mock.calls.map(([state]) => state)

		expect(states[0]?.["chat-l-l-l"]?.messages.map(m => m.inflightId)).toEqual([inflightId])

		// Back in the follower tab, the states the leader really broadcast: pending, then confirmed and gone.
		useChatsInflightStore.setState({
			inflightMessages: followerTab.inflightMessages,
			inflightErrors: followerTab.inflightErrors,
			sendingInflightIds: {}
		})
		follower.applyLeaderState(structuredClone(states[0] ?? {}))
		expect(useChatsInflightStore.getState().inflightErrors[inflightId]).toBeUndefined()
		expect(queue()["chat-l-l-l"]?.messages.map(m => m.inflightId)).toEqual([inflightId])

		for (const state of states.slice(1)) {
			follower.applyLeaderState(structuredClone(state))
		}

		expect(useChatsInflightStore.getState().inflightErrors[inflightId]).toBeUndefined()
		expect(queue()["chat-l-l-l"]).toBeUndefined()
	})

	it("never broadcasts a state still listing the dropped send after announcing the drop", async () => {
		const leaderTransport = mockTransport()
		const order: ("failed" | "listed" | "omitted")[] = []

		leaderTransport.broadcastFailed.mockImplementation(() => {
			order.push("failed")
		})
		leaderTransport.broadcastState.mockImplementation(state => {
			order.push(state["chat-l-l-l"]?.messages.some(m => m.inflightId === "inf-l-l-l") === true ? "listed" : "omitted")
		})

		// A state request (a newly opened tab) lands while each disk write is in flight, the drop's included.
		const write = kvDelete.getMockImplementation()

		kvDelete.mockImplementation((key: string) => {
			sync.broadcastState()

			return write?.(key) ?? Promise.resolve()
		})

		try {
			await droppedLocal(leaderTransport)
		} finally {
			if (write !== undefined) {
				kvDelete.mockImplementation(write)
			}
		}

		expect(order).toContain("failed")
		expect(order.slice(order.indexOf("failed") + 1)).not.toContain("listed")
	})
})

describe("logout — an aborted pass never flushes (the wipe is not resurrected)", () => {
	it("suppresses the post-pass disk flush when cancel() aborts the in-flight pass", async () => {
		let releaseSend: (() => void) | undefined
		sendChatMessage.mockImplementation(
			(chat: Chat) =>
				new Promise(resolve => {
					releaseSend = () => {
						resolve({ ...chat, lastMessage: confirmedMessage(chat.uuid, "srv-1-1-1") })
					}
				})
		)

		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

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

// A send that stays queued stops its chat's pass (order is load-bearing), so the outbox runs the pass again
// on its own timer: 30 s, 2 min, 10 min, then every 10 min. The messages behind the failed one go out after it.
describe("a chat's pass stopped at a failed send runs again on a timer", () => {
	function sent(): string[] {
		return sendChatMessage.mock.calls.map(call => call[1])
	}

	async function after(ms: number): Promise<void> {
		await vi.advanceTimersByTimeAsync(ms)
	}

	afterEach(() => {
		sync.cancel()
		vi.useRealTimers()
	})

	it("retries the failed head first, then sends the messages queued behind it in order", async () => {
		vi.useFakeTimers()
		chatsQueryUpsert(outboxChat("chat-a-a-a"))
		sendChatMessage.mockRejectedValueOnce(sdkError("Reqwest"))
		seed("chat-a-a-a", [
			optimistic("chat-a-a-a", "inf-1-1-1", 100n, "m1"),
			optimistic("chat-a-a-a", "inf-2-2-2", 200n, "m2"),
			optimistic("chat-a-a-a", "inf-3-3-3", 300n, "m3")
		])

		sync.syncNow()
		await after(0)

		// The head failed and the pass stopped: nothing later went out before it.
		expect(sent()).toEqual(["m1"])
		expect(inflightIdsIn("chat-a-a-a")).toEqual(["inf-1-1-1", "inf-2-2-2", "inf-3-3-3"])
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeDefined()

		await after(29_999)
		expect(sent()).toEqual(["m1"])

		await after(1)
		expect(sent()).toEqual(["m1", "m1", "m2", "m3"])
		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("backs off 30 s, 2 min, 10 min while the send keeps failing", async () => {
		vi.useFakeTimers()
		chatsQueryUpsert(outboxChat("chat-a-a-a"))
		sendChatMessage.mockRejectedValue(sdkError("Reqwest"))
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await after(0)
		expect(sent()).toHaveLength(1)

		await after(30_000)
		expect(sent()).toHaveLength(2)

		await after(119_999)
		expect(sent()).toHaveLength(2)
		await after(1)
		expect(sent()).toHaveLength(3)

		await after(600_000)
		expect(sent()).toHaveLength(4)
	})

	it("runs a rejection under the drop bound again too, until the bound drops it", async () => {
		vi.useFakeTimers()
		chatsQueryUpsert(outboxChat("chat-a-a-a"))
		sendChatMessage.mockRejectedValue(sdkError("Server"))
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await after(0)
		await after(30_000)
		await after(120_000)

		expect(sent()).toHaveLength(3)
		expect(queue()["chat-a-a-a"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]?.permanentRejections).toBe(3)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("waits while offline", async () => {
		vi.useFakeTimers()
		chatsQueryUpsert(outboxChat("chat-a-a-a"))
		sendChatMessage.mockRejectedValueOnce(sdkError("Reqwest"))
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await after(0)
		onlineManager.setOnline(false)
		sync.pauseResend()
		await after(3_600_000)

		expect(sent()).toHaveLength(1)
	})

	it("is cleared on cancel (logout)", async () => {
		vi.useFakeTimers()
		chatsQueryUpsert(outboxChat("chat-a-a-a"))
		sendChatMessage.mockRejectedValueOnce(sdkError("Reqwest"))
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await after(0)
		expect(vi.getTimerCount()).toBe(1)

		sync.cancel()
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe("a chat the pass cannot resolve", () => {
	afterEach(() => {
		sync.cancel()
		vi.useRealTimers()
	})

	it("shows the oldest send as failed (with Retry), without a strike, and runs the pass again", async () => {
		vi.useFakeTimers()
		getChat.mockRejectedValueOnce(sdkError("Reqwest"))
		seed("chat-c-c-c", [optimistic("chat-c-c-c", "inf-2-2-2", 200n, "m2"), optimistic("chat-c-c-c", "inf-1-1-1", 100n, "m1")])

		sync.syncNow()
		await vi.advanceTimersByTimeAsync(0)

		expect(sendChatMessage).not.toHaveBeenCalled()
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toMatchObject({ permanentRejections: 0 })
		expect(useChatsInflightStore.getState().inflightErrors["inf-2-2-2"]).toBeUndefined()
		expect(inflightIdsIn("chat-c-c-c")).toEqual(["inf-2-2-2", "inf-1-1-1"])

		await vi.advanceTimersByTimeAsync(30_000)

		expect(sendChatMessage.mock.calls.map(call => call[1])).toEqual(["m1", "m2"])
		expect(queue()["chat-c-c-c"]).toBeUndefined()
		expect(useChatsInflightStore.getState().inflightErrors["inf-1-1-1"]).toBeUndefined()
	})

	it("retries a chat getChat found missing while the list has not loaded", async () => {
		vi.useFakeTimers()
		getChat.mockResolvedValueOnce(undefined)
		seed("chat-c-c-c", [optimistic("chat-c-c-c", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await vi.advanceTimersByTimeAsync(0)
		expect(sendChatMessage).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(30_000)
		expect(sendChatMessage).toHaveBeenCalledTimes(1)
		expect(queue()["chat-c-c-c"]).toBeUndefined()
	})
})

// A send the SDK worker never settles holds the pass and its mutex: reported once, never aborted.
describe("a send outstanding too long", () => {
	afterEach(() => {
		sync.cancel()
		vi.useRealTimers()
	})

	it("warns once after 30 s and leaves the send running", async () => {
		vi.useFakeTimers()

		const warn = vi.spyOn(log, "warn")

		chatsQueryUpsert(outboxChat("chat-a-a-a"))
		sendChatMessage.mockReturnValue(new Promise<Chat>(() => undefined))
		seed("chat-a-a-a", [optimistic("chat-a-a-a", "inf-1-1-1", 1n, "hi")])

		sync.syncNow()
		await vi.advanceTimersByTimeAsync(29_999)
		expect(warn.mock.calls.filter(call => call[1] === "sendChatMessage still outstanding")).toEqual([])

		await vi.advanceTimersByTimeAsync(600_001)

		expect(warn.mock.calls.filter(call => call[1] === "sendChatMessage still outstanding")).toEqual([
			["chats-sync", "sendChatMessage still outstanding", "inf-1-1-1", "30000ms"]
		])
		expect(inflightIdsIn("chat-a-a-a")).toEqual(["inf-1-1-1"])
		warn.mockRestore()
	})
})
