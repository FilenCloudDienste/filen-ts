import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@filen/sdk-rs"
import { composeMessageList, mergeChatInflight, buildOptimisticMessage, type OptimisticSender } from "@/features/chats/lib/sync.logic"
import type { ChatMessageWithInflightId, InflightChatMessages } from "@/features/chats/store/useChatsInflight"

// Pure core of the chat send outbox — no store/IO. Uuid-shaped fields are the SDK's branded UuidStr;
// literal strings with 3+ dashes satisfy that template type directly, so no casts are needed.

const SENDER: OptimisticSender = { id: 7n, email: "me@filen.io", avatarUrl: undefined, nickName: "Me" }

function confirmed(uuid: string, sentTimestamp: bigint, message = "hi"): ChatMessage {
	return {
		uuid: uuid as ChatMessage["uuid"],
		chat: "chat-a-a-a",
		senderId: 7,
		senderEmail: "me@filen.io",
		senderNickName: "Me",
		message,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp
	}
}

function optimistic(inflightId: string, sentTimestamp: bigint, content = "queued"): ChatMessageWithInflightId {
	return buildOptimisticMessage({
		chatUuid: "chat-a-a-a",
		inflightId: inflightId as ChatMessage["uuid"],
		content,
		replyTo: undefined,
		sentTimestamp,
		sender: SENDER
	})
}

describe("buildOptimisticMessage", () => {
	it("sets the optimistic uuid to the inflightId and stamps sender fields (senderId narrowed to number)", () => {
		const message = optimistic("inf-1-1-1", 100n, "hello")

		expect(message.inflightId).toBe("inf-1-1-1")
		expect(message.uuid).toBe("inf-1-1-1")
		expect(message.chat).toBe("chat-a-a-a")
		expect(message.senderId).toBe(7)
		expect(message.message).toBe("hello")
		expect(message.sentTimestamp).toBe(100n)
		expect(message.edited).toBe(false)
	})

	it("omits an absent avatar/replyTo key rather than setting it undefined (exactOptionalPropertyTypes)", () => {
		const message = optimistic("inf-2-2-2", 1n)

		expect("senderAvatar" in message).toBe(false)
		expect("replyTo" in message).toBe(false)
	})
})

describe("composeMessageList", () => {
	it("merges confirmed + pending + failed and sorts ASCENDING (pending/failed newest land after confirmed)", () => {
		const list = composeMessageList({
			queryMessages: [confirmed("srv-2-2-2", 200n), confirmed("srv-1-1-1", 100n)],
			inflightMessages: [optimistic("inf-9-9-9", 900n)],
			failedMessages: [optimistic("inf-5-5-5", 500n)]
		})

		expect(list.map(m => m.uuid)).toEqual(["srv-1-1-1", "srv-2-2-2", "inf-5-5-5", "inf-9-9-9"])
	})

	it("first-wins dedup: an optimistic entry already in the query cache (uuid === inflightId) is not re-added", () => {
		// The enqueue path writes the optimistic copy into the query cache; the store still holds it too.
		const opt = optimistic("inf-7-7-7", 300n)

		const list = composeMessageList({
			queryMessages: [opt],
			inflightMessages: [opt],
			failedMessages: []
		})

		expect(list.filter(m => m.uuid === "inf-7-7-7")).toHaveLength(1)
	})

	it("re-injects a pending entry the query cache no longer has (survives a refetch that dropped it)", () => {
		const list = composeMessageList({
			queryMessages: [confirmed("srv-1-1-1", 100n)],
			inflightMessages: [optimistic("inf-8-8-8", 800n)],
			failedMessages: []
		})

		expect(list.map(m => m.uuid)).toContain("inf-8-8-8")
	})

	it("dedups a message present in BOTH the pending queue and the failed map (transient error, still queued)", () => {
		const opt = optimistic("inf-6-6-6", 600n)

		const list = composeMessageList({
			queryMessages: [],
			inflightMessages: [opt],
			failedMessages: [opt]
		})

		expect(list).toHaveLength(1)
		expect(list[0]?.uuid).toBe("inf-6-6-6")
	})
})

describe("mergeChatInflight — union-by-inflightId, live-wins (the divergence from notes' overwrite merge)", () => {
	function group(chatUuid: string, messages: ChatMessageWithInflightId[]): InflightChatMessages {
		return {
			[chatUuid]: {
				chat: { uuid: chatUuid } as InflightChatMessages[string]["chat"],
				messages
			}
		}
	}

	it("seeds a chat the live store does not have from disk", () => {
		const merged = mergeChatInflight({}, group("chat-a-a-a", [optimistic("inf-1-1-1", 1n)]))

		expect(merged["chat-a-a-a"]?.messages.map(m => m.inflightId)).toEqual(["inf-1-1-1"])
	})

	it("unions disk entries missing from the live queue WITHOUT clobbering a message sent during restore", () => {
		const live = group("chat-a-a-a", [optimistic("inf-live-9-9", 900n, "sent-during-restore")])
		const disk = group("chat-a-a-a", [optimistic("inf-live-9-9", 900n, "stale-disk-copy"), optimistic("inf-disk-1-1", 100n)])

		const merged = mergeChatInflight(live, disk)
		const messages = merged["chat-a-a-a"]?.messages ?? []

		// Live copy of the shared id wins (kept as the FIRST entry, content unchanged); the disk-only id is appended.
		expect(messages.map(m => m.inflightId)).toEqual(["inf-live-9-9", "inf-disk-1-1"])
		expect(messages.find(m => m.inflightId === "inf-live-9-9")?.message).toBe("sent-during-restore")
	})

	it("is a no-op for a chat whose disk entries are all already live", () => {
		const live = group("chat-a-a-a", [optimistic("inf-1-1-1", 1n)])
		const merged = mergeChatInflight(live, group("chat-a-a-a", [optimistic("inf-1-1-1", 1n)]))

		expect(merged["chat-a-a-a"]?.messages).toHaveLength(1)
	})
})
