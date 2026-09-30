import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import {
	chatDisplayName,
	chatMessagePreview,
	chatPreviewTier,
	chatTitle,
	compareBySentTimestamp,
	isChatOwner,
	isChatUndecryptable,
	isLastMessageFromBlocked,
	messageSenderName,
	otherParticipants
} from "@/features/chats/lib/sort"
import { deriveBlockedUsers } from "@filen/shared"
import { mockPlainBlockedContact } from "@/tests/support/contactFixtures"
import { testUuid } from "@/tests/support/uuid"

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

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

// exactOptionalPropertyTypes distinguishes "key absent" (valid for an optional field) from "key
// present with value undefined" (rejected) — this builds an undecryptable-style Chat (the group
// key genuinely absent, matching what the wasm surface returns for an undecryptable chat) by
// simply never including the key, rather than assigning it undefined. Same pattern as notes'
// notesSort.test.ts mockNoteWithoutTitle.
function mockUndecryptableChat(overrides: Omit<Partial<Chat>, "key"> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		message: "hello",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1_000n,
		...overrides
	}
}

// Same exactOptionalPropertyTypes rationale as mockUndecryptableChat above, applied to
// ChatMessage.message (undefined ⇒ the message content did not decrypt).
function mockUndecryptableMessage(overrides: Omit<Partial<ChatMessage>, "message"> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 1_000n,
		...overrides
	}
}

describe("compareBySentTimestamp", () => {
	it("orders oldest first, bigint-safe past Number precision", () => {
		const big = 2n ** 63n

		expect(compareBySentTimestamp({ sentTimestamp: big }, { sentTimestamp: big + 1n })).toBe(-1)
		expect(compareBySentTimestamp({ sentTimestamp: big + 1n }, { sentTimestamp: big })).toBe(1)
		expect(compareBySentTimestamp({ sentTimestamp: big }, { sentTimestamp: big })).toBe(0)
	})
})

describe("isChatOwner", () => {
	it("is true when the given userId matches the chat's ownerId", () => {
		expect(isChatOwner(mockChat({ ownerId: 5n }), 5n)).toBe(true)
	})

	it("is false when the given userId does not match", () => {
		expect(isChatOwner(mockChat({ ownerId: 5n }), 6n)).toBe(false)
	})

	it("is false when userId is undefined (no resolved account yet)", () => {
		expect(isChatOwner(mockChat({ ownerId: 5n }), undefined)).toBe(false)
	})
})

describe("otherParticipants", () => {
	it("excludes only the viewer's own row", () => {
		const self = mockParticipant({ userId: 1n })
		const other = mockParticipant({ userId: 2n })

		expect(otherParticipants(mockChat({ participants: [self, other] }), 1n)).toEqual([other])
	})

	it("keeps every participant when the viewer is unresolved", () => {
		const participants = [mockParticipant({ userId: 1n }), mockParticipant({ userId: 2n })]

		expect(otherParticipants(mockChat({ participants }), undefined)).toEqual(participants)
	})
})

describe("isChatUndecryptable", () => {
	it("is true when key is undefined", () => {
		expect(isChatUndecryptable(mockUndecryptableChat())).toBe(true)
	})

	it("is false when key is present", () => {
		expect(isChatUndecryptable(mockChat({ key: "k" }))).toBe(false)
	})
})

describe("chatDisplayName — display-name derivation table", () => {
	const self = 1n
	const solo = "Just you"

	it("falls back to the raw uuid for an undecryptable chat, ignoring name/participants", () => {
		const uuid = testUuid("undecryptable")
		const chat = mockUndecryptableChat({ uuid, name: "should be ignored" })

		expect(chatDisplayName(chat, self, solo)).toBe(uuid)
	})

	it("uses the explicit chat name when set", () => {
		const chat = mockChat({ name: "Team Chat", participants: [mockParticipant({ userId: self })] })

		expect(chatDisplayName(chat, self, solo)).toBe("Team Chat")
	})

	it("ignores an empty-string name and falls through to participant derivation", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com" })
		const chat = mockChat({ name: "", participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self, solo)).toBe("other@example.com")
	})

	it("excludes the current user from the joined group name", () => {
		const p1 = mockParticipant({ userId: 2n, email: "other@example.com" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self, email: "self@example.com" }), p1] })

		expect(chatDisplayName(chat, self, solo)).toBe("other@example.com")
	})

	it("returns the solo fallback when every other participant left (only self remains)", () => {
		const chat = mockChat({ participants: [mockParticipant({ userId: self })] })

		expect(chatDisplayName(chat, self, solo)).toBe(solo)
	})

	it("returns the solo fallback when the participants array is completely empty", () => {
		const chat = mockChat({ participants: [] })

		expect(chatDisplayName(chat, self, solo)).toBe(solo)
	})

	it("a custom chat name wins over the solo fallback", () => {
		const chat = mockChat({ name: "Team Chat", participants: [] })

		expect(chatDisplayName(chat, self, solo)).toBe("Team Chat")
	})
})

describe("chatTitle", () => {
	const undecryptable = "Cannot decrypt"
	const solo = "Just you"

	it("returns the undecryptable label, even with no resolved viewer", () => {
		const chat = mockUndecryptableChat({ name: "should be ignored" })

		expect(chatTitle(chat, 1n, undecryptable, solo)).toBe(undecryptable)
		expect(chatTitle(chat, undefined, undecryptable, solo)).toBe(undecryptable)
	})

	it("returns the display name once the viewer is resolved", () => {
		const chat = mockChat({ participants: [mockParticipant({ userId: 1n })] })

		expect(chatTitle(chat, 1n, undecryptable, solo)).toBe(solo)
	})

	it("falls back to the uuid while the viewer is unresolved", () => {
		const uuid = testUuid("unresolved")
		const chat = mockChat({ uuid, name: "Team Chat" })

		expect(chatTitle(chat, undefined, undecryptable, solo)).toBe(uuid)
	})
})

describe("chatMessagePreview — lastMessage tier only", () => {
	it("returns null when there is no lastMessage", () => {
		expect(chatMessagePreview(mockChat())).toBeNull()
	})

	it("returns null when the lastMessage is undecryptable (message undefined)", () => {
		const chat = mockChat({ lastMessage: mockUndecryptableMessage() })

		expect(chatMessagePreview(chat)).toBeNull()
	})

	it("returns the lastMessage's text when present", () => {
		const chat = mockChat({ lastMessage: mockMessage({ message: "hey there" }) })

		expect(chatMessagePreview(chat)).toBe("hey there")
	})
})

describe("messageSenderName", () => {
	it("prefers a non-empty nickname", () => {
		expect(messageSenderName(mockMessage({ senderNickName: "Zoe", senderEmail: "zoe@example.com" }))).toBe("Zoe")
	})

	it("falls back to the email when the nickname is undefined", () => {
		expect(messageSenderName(mockMessage({ senderNickName: undefined, senderEmail: "zoe@example.com" }))).toBe("zoe@example.com")
	})

	it("falls back to the email when the nickname is an empty string", () => {
		expect(messageSenderName(mockMessage({ senderNickName: "", senderEmail: "zoe@example.com" }))).toBe("zoe@example.com")
	})
})

describe("isLastMessageFromBlocked", () => {
	const blocked = deriveBlockedUsers([mockPlainBlockedContact({ userId: 9n, email: "zoe@example.com" })])

	it("is false when the chat has no lastMessage", () => {
		expect(isLastMessageFromBlocked(mockChat(), blocked)).toBe(false)
	})

	// senderId is `number` on the wasm surface — this pins the BigInt coercion against a bigint userId.
	it("is true when the numeric senderId matches a blocked bigint userId", () => {
		const chat = mockChat({ lastMessage: mockMessage({ senderId: 9, senderEmail: "unlisted@example.com" }) })

		expect(isLastMessageFromBlocked(chat, blocked)).toBe(true)
	})

	it("is true when only the email matches", () => {
		const chat = mockChat({ lastMessage: mockMessage({ senderId: 77, senderEmail: "ZOE@example.com" }) })

		expect(isLastMessageFromBlocked(chat, blocked)).toBe(true)
	})

	it("is false when neither identity matches", () => {
		const chat = mockChat({ lastMessage: mockMessage({ senderId: 77, senderEmail: "other@example.com" }) })

		expect(isLastMessageFromBlocked(chat, blocked)).toBe(false)
	})
})

describe("chatPreviewTier", () => {
	const blocked = deriveBlockedUsers([mockPlainBlockedContact({ userId: 9n, email: "zoe@example.com" })])

	function chatFromBlockedSender(): Chat {
		return mockChat({ lastMessage: mockMessage({ senderId: 9, senderEmail: "zoe@example.com", message: "hidden" }) })
	}

	// A live typing label always wins — the blocked treatment must never bleed onto it.
	it("returns typing when a typing label is present, even with a blocked last sender", () => {
		expect(chatPreviewTier(chatFromBlockedSender(), "Zoe is typing…", blocked)).toBe("typing")
	})

	it("returns blocked when nobody is typing and the last sender is blocked", () => {
		expect(chatPreviewTier(chatFromBlockedSender(), null, blocked)).toBe("blocked")
	})

	it("returns message when nobody is typing, nobody is blocked and the last message has text", () => {
		const chat = mockChat({ lastMessage: mockMessage({ senderId: 3, senderEmail: "c@example.com", message: "hey" }) })

		expect(chatPreviewTier(chat, null, blocked)).toBe("message")
	})

	it("returns empty when there is no lastMessage at all", () => {
		expect(chatPreviewTier(mockChat(), null, blocked)).toBe("empty")
	})

	// Documented divergence from mobile: blocked outranks the message tier and ignores decryptability, so
	// an undecryptable message from a blocked sender never falls through to "no messages yet".
	it("returns blocked for an undecryptable last message from a blocked sender", () => {
		const chat = mockChat({ lastMessage: mockUndecryptableMessage({ senderId: 9, senderEmail: "zoe@example.com" }) })

		expect(chatPreviewTier(chat, null, blocked)).toBe("blocked")
	})

	it("never returns blocked when the blocked argument is omitted (fail-open default)", () => {
		expect(chatPreviewTier(chatFromBlockedSender(), null)).toBe("message")
	})
})
