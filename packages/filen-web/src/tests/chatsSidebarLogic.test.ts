import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, ChatParticipant, UuidStr } from "@filen/sdk-rs"
import { filterChats, staleChatSelectionUuids } from "@/features/chats/components/chatsSidebar.logic"
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

	// Search also matches the conversation's last-message text (name/email/nickname already covered
	// above), same as mobile's list search.
	it("matches on the last-message text", () => {
		const chat = mockChat("a", { name: "Untitled", lastMessage: mockMessage({ message: "let's meet at noon" }) })
		const other = mockChat("b", { name: "Other", lastMessage: mockMessage({ message: "unrelated" }) })

		expect(filterChats([chat, other], "meet at noon", SELF).map(c => c.uuid)).toEqual([chat.uuid])
	})

	// A chat the viewer merely joined (not owned) and that has never had a message is hidden from
	// the list entirely; an owned-but-empty chat, or any chat with at least one message regardless of
	// ownership, still shows. Applies to both the empty-search and term-search paths.
	describe("owned-or-has-a-message visibility", () => {
		it("hides a chat with no messages that the viewer does not own", () => {
			const invitedEmpty = mockChat("a", { ownerId: 2n })

			expect(filterChats([invitedEmpty], "", SELF)).toEqual([])
		})

		it("keeps an owned chat even with no messages yet", () => {
			const ownedEmpty = mockChat("a", { ownerId: SELF })

			expect(filterChats([ownedEmpty], "", SELF).map(c => c.uuid)).toEqual([ownedEmpty.uuid])
		})

		it("keeps a non-owned chat once it has at least one message", () => {
			const invitedWithMessage = mockChat("a", { ownerId: 2n, lastMessage: mockMessage() })

			expect(filterChats([invitedWithMessage], "", SELF).map(c => c.uuid)).toEqual([invitedWithMessage.uuid])
		})

		it("hides an unowned, message-less chat from a term search too, not just the empty-search list", () => {
			const invitedEmpty = mockChat("a", { ownerId: 2n, name: "Weekend Plans" })

			expect(filterChats([invitedEmpty], "weekend", SELF)).toEqual([])
		})

		it("treats an unresolved current-user id as not-owner, hiding message-less chats", () => {
			const chat = mockChat("a", { ownerId: 1n })

			expect(filterChats([chat], "", undefined)).toEqual([])
		})
	})
})

describe("chatHasUnread (client-derived)", () => {
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

describe("staleChatSelectionUuids", () => {
	it("returns the uuids of selected chats no longer present in the live set", () => {
		const chatA = mockChat("a")
		const chatB = mockChat("b")

		// chatB was deleted/left elsewhere (a conversationDeleted socket event, or another tab) — it's
		// still in the selection but no longer in the live chats query result.
		expect(staleChatSelectionUuids([chatA, chatB], [chatA])).toEqual([chatB.uuid])
	})

	it("returns an empty array when every selected chat is still live", () => {
		const chatA = mockChat("a")
		const chatB = mockChat("b")

		expect(staleChatSelectionUuids([chatA, chatB], [chatA, chatB])).toEqual([])
	})

	it("returns an empty array for an empty selection", () => {
		expect(staleChatSelectionUuids([], [mockChat("a")])).toEqual([])
	})

	it("treats every selected chat as stale when the live set is empty", () => {
		const chatA = mockChat("a")
		const chatB = mockChat("b")

		expect(staleChatSelectionUuids([chatA, chatB], [])).toEqual([chatA.uuid, chatB.uuid])
	})
})
