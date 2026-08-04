import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, Note, UuidStr } from "@filen/sdk-rs"
import type { InflightContent } from "@/features/notes/store/useNotesInflight"
import type { ChatMessageWithInflightId, InflightChatMessageErrors, InflightChatMessages } from "@/features/chats/store/useChatsInflight"
import { hasUnsyncedNotes, hasUnsyncedChatSends } from "@/features/shell/hooks/useUnsyncedWork.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockNote(): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "key",
		title: "note",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: []
	}
}

function mockChat(): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n
	}
}

function mockQueuedMessage(): ChatMessageWithInflightId {
	const message: ChatMessage = {
		uuid: testUuid("inflight"),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		message: "unsent",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1_000n
	}

	return { ...message, inflightId: testUuid("inflight") }
}

// Sign-out cancels both outboxes and wipes their storage, so the confirm's copy hinges on this
// predicate: a false negative promises the user their queued work syncs back when it is about to be
// deleted.
describe("hasUnsyncedNotes", () => {
	it("is false for an empty outbox", () => {
		expect(hasUnsyncedNotes({})).toBe(false)
	})

	it("is true while any note holds a queued edit", () => {
		const inflight: InflightContent = { [testUuid("note")]: [{ timestamp: 1, note: mockNote(), content: "typed" }] }

		expect(hasUnsyncedNotes(inflight)).toBe(true)
	})

	it("is false for a drained note whose empty entry list has not been pruned yet", () => {
		expect(hasUnsyncedNotes({ [testUuid("note")]: [] })).toBe(false)
	})
})

describe("hasUnsyncedChatSends", () => {
	it("is false with no queued sends and no failures", () => {
		expect(hasUnsyncedChatSends({}, {})).toBe(false)
	})

	it("is true while a chat holds a queued send", () => {
		const queued: InflightChatMessages = { [testUuid("chat")]: { chat: mockChat(), messages: [mockQueuedMessage()] } }

		expect(hasUnsyncedChatSends(queued, {})).toBe(true)
	})

	it("is false for a drained chat whose empty queue has not been pruned yet", () => {
		expect(hasUnsyncedChatSends({ [testUuid("chat")]: { chat: mockChat(), messages: [] } }, {})).toBe(false)
	})

	// A send dropped after its retry budget survives ONLY as an error record — its text is nowhere else,
	// and the failed bubble is still retryable until sign-out throws it away.
	it("is true for a failed send that is no longer queued", () => {
		const errors: InflightChatMessageErrors = {
			[testUuid("inflight")]: {
				error: { species: "plain", message: "nope", label: "nope" },
				permanentRejections: 3,
				message: mockQueuedMessage()
			}
		}

		expect(hasUnsyncedChatSends({}, errors)).toBe(true)
	})
})
