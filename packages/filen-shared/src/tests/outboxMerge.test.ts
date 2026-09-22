import { describe, it, expect } from "vitest"
import { mergeInflightQueuesByUnion } from "@filen/shared"

// Plain literal types instantiating the generic — no app-specific SDK shapes, just the constraint
// shape (`{ inflightId: string }` messages inside a `{ messages: ... }` entry).
type Message = {
	inflightId: string
	text: string
}

type Entry = {
	chatUuid: string
	messages: Message[]
}

function message(inflightId: string, text: string): Message {
	return { inflightId, text }
}

// Ported from mobile's mergeInflight cases (chatsSync.test.ts describe("mergeInflight", ...)).
describe("mergeInflightQueuesByUnion — mobile cases", () => {
	it("seeds chats the current store does not have", () => {
		const current: Record<string, Entry> = {}
		const fromDisk: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("msg-1", "disk")]
			}
		}

		const merged = mergeInflightQueuesByUnion(current, fromDisk)

		expect(merged["chat-1"]!.messages).toHaveLength(1)
	})

	it("keeps the live copy when both sides carry the same inflightId", () => {
		const current: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("shared", "live")]
			}
		}
		const fromDisk: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("shared", "disk")]
			}
		}

		const merged = mergeInflightQueuesByUnion(current, fromDisk)

		expect(merged["chat-1"]!.messages).toHaveLength(1)
		expect(merged["chat-1"]!.messages[0]!.text).toBe("live")
	})

	it("unions disjoint messages of the same chat (live + disk)", () => {
		const current: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("live-only", "live")]
			}
		}
		const fromDisk: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("disk-only", "disk")]
			}
		}

		const merged = mergeInflightQueuesByUnion(current, fromDisk)
		const ids = merged["chat-1"]!.messages.map(m => m.inflightId)

		expect(ids).toHaveLength(2)
		expect(ids).toContain("live-only")
		expect(ids).toContain("disk-only")
	})

	it("preserves live-only chats untouched", () => {
		const liveEntry: Entry = {
			chatUuid: "chat-live",
			messages: [message("live-1", "stays")]
		}
		const current: Record<string, Entry> = {
			"chat-live": liveEntry
		}
		const fromDisk: Record<string, Entry> = {
			"chat-disk": {
				chatUuid: "chat-disk",
				messages: [message("disk-1", "disk")]
			}
		}

		const merged = mergeInflightQueuesByUnion(current, fromDisk)

		expect(merged["chat-live"]).toBe(liveEntry)
		expect(merged["chat-disk"]).toBeDefined()
	})

	it("does not mutate either input", () => {
		const current: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("live-only", "live")]
			}
		}
		const fromDisk: Record<string, Entry> = {
			"chat-1": {
				chatUuid: "chat-1",
				messages: [message("disk-only", "disk")]
			}
		}

		const merged = mergeInflightQueuesByUnion(current, fromDisk)

		expect(merged).not.toBe(current)
		expect(current["chat-1"]!.messages).toHaveLength(1)
		expect(fromDisk["chat-1"]!.messages).toHaveLength(1)
	})
})

// Ported from web's mergeChatInflight cases (chatsComposeMessageList.test.ts
// describe("mergeChatInflight — union-by-inflightId, live-wins...", ...)).
describe("mergeInflightQueuesByUnion — web cases", () => {
	function group(chatUuid: string, messages: Message[]): Record<string, Entry> {
		return {
			[chatUuid]: {
				chatUuid,
				messages
			}
		}
	}

	it("seeds a chat the live store does not have from disk", () => {
		const merged = mergeInflightQueuesByUnion({}, group("chat-a-a-a", [message("inf-1-1-1", "queued")]))

		expect(merged["chat-a-a-a"]?.messages.map(m => m.inflightId)).toEqual(["inf-1-1-1"])
	})

	it("unions disk entries missing from the live queue WITHOUT clobbering a message sent during restore", () => {
		const live = group("chat-a-a-a", [message("inf-live-9-9", "sent-during-restore")])
		const disk = group("chat-a-a-a", [message("inf-live-9-9", "stale-disk-copy"), message("inf-disk-1-1", "queued")])

		const merged = mergeInflightQueuesByUnion(live, disk)
		const messages = merged["chat-a-a-a"]?.messages ?? []

		// Live copy of the shared id wins (kept as the FIRST entry, content unchanged); the disk-only id is appended.
		expect(messages.map(m => m.inflightId)).toEqual(["inf-live-9-9", "inf-disk-1-1"])
		expect(messages.find(m => m.inflightId === "inf-live-9-9")?.text).toBe("sent-during-restore")
	})

	it("is a no-op for a chat whose disk entries are all already live", () => {
		const live = group("chat-a-a-a", [message("inf-1-1-1", "queued")])
		const merged = mergeInflightQueuesByUnion(live, group("chat-a-a-a", [message("inf-1-1-1", "queued")]))

		expect(merged["chat-a-a-a"]?.messages).toHaveLength(1)
	})
})
