import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, ChatParticipant, UuidStr } from "@filen/sdk-rs"
import { filterChats } from "@/features/chats/components/chatsSidebar.logic"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockParticipant(overrides: Partial<ChatParticipant> = {}): ChatParticipant {
	return {
		userId: 1n,
		email: "a@example.com",
		nickName: undefined,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n,
		...overrides
	}
}

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 2,
		senderEmail: "b@example.com",
		senderNickName: undefined,
		message: "hi",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1_000n,
		...overrides
	}
}

function mockChat(label: string, overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		key: "chat-key",
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

// Undecryptable = group key genuinely absent (never `key: undefined`, per exactOptionalPropertyTypes).
function mockUndecryptableChat(label: string, overrides: Omit<Partial<Chat>, "key"> = {}): Chat {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

const SELF = 1n

describe("filterChats", () => {
	it("returns the full sorted list for an empty search term", () => {
		const older = mockChat("a", { lastMessage: mockMessage({ sentTimestamp: 100n }) })
		const newer = mockChat("b", { lastMessage: mockMessage({ sentTimestamp: 200n }) })

		// sortChats orders newest-lastMessage first, independent of input order.
		expect(filterChats([older, newer], "", SELF).map(c => c.uuid)).toEqual([newer.uuid, older.uuid])
	})

	it("matches on the conversation display name", () => {
		const named = mockChat("a", { name: "Weekend Plans" })
		const other = mockChat("b", { name: "Work" })

		expect(filterChats([named, other], "weekend", SELF).map(c => c.uuid)).toEqual([named.uuid])
	})

	it("matches on a participant email or nickname", () => {
		const chat = mockChat("a", {
			name: "Untitled",
			participants: [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n, email: "zoe@example.com" })]
		})

		expect(filterChats([chat], "zoe@", SELF).map(c => c.uuid)).toEqual([chat.uuid])
	})

	it("excludes undecryptable conversations from a term match but keeps them for an empty search", () => {
		const undecryptable = mockUndecryptableChat("a")

		expect(filterChats([undecryptable], "", SELF).map(c => c.uuid)).toEqual([undecryptable.uuid])
		expect(filterChats([undecryptable], "anything", SELF)).toEqual([])
	})
})

describe("chatHasUnread (derived, D4)", () => {
	it("is true when the last message is from another sender and newer than lastFocus", () => {
		const chat = mockChat("a", { lastFocus: 500n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })

		expect(chatHasUnread(chat, SELF)).toBe(true)
	})

	it("is false when the last message is not newer than lastFocus", () => {
		const chat = mockChat("a", { lastFocus: 900n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 500n }) })

		expect(chatHasUnread(chat, SELF)).toBe(false)
	})

	it("is false for our own last message (senderId coerced from number to bigint)", () => {
		const chat = mockChat("a", { lastFocus: 0n, lastMessage: mockMessage({ senderId: 1, sentTimestamp: 900n }) })

		expect(chatHasUnread(chat, SELF)).toBe(false)
	})

	it("is false when muted, when there is no last message, or when the user is unknown", () => {
		const muted = mockChat("a", { muted: true, lastFocus: 0n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })
		const noMessage = mockChat("b", { lastFocus: 0n })
		const withUnread = mockChat("c", { lastFocus: 0n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })

		expect(chatHasUnread(muted, SELF)).toBe(false)
		expect(chatHasUnread(noMessage, SELF)).toBe(false)
		expect(chatHasUnread(withUnread, undefined)).toBe(false)
	})
})
