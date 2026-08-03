import { describe, expect, it } from "vitest"
import type { BlockedContact, Chat, ChatMessage, ChatParticipant, UuidStr } from "@filen/sdk-rs"
import {
	chatDisplayName,
	chatMessagePreview,
	chatPreviewTier,
	isChatUndecryptable,
	isLastMessageFromBlocked,
	messageSenderName,
	sortChats
} from "@/features/chats/lib/sort"
import { deriveBlockedUsers } from "@/features/contacts/lib/blocking"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a
// short label the same way notesSort.test.ts's testUuid does.
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

function mockBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: testUuid("blocked"),
		userId: 2n,
		email: "b@example.com",
		nickName: "",
		timestamp: 0n,
		...overrides
	}
}

// Mirrors mobile's `components/list/index.tsx:36-45` sort exactly (verified against source this
// session).
describe("sortChats", () => {
	it("orders by lastMessage.sentTimestamp descending", () => {
		const older = mockChat({ uuid: testUuid("older"), lastMessage: mockMessage({ sentTimestamp: 100n }) })
		const newer = mockChat({ uuid: testUuid("newer"), lastMessage: mockMessage({ sentTimestamp: 200n }) })

		expect(sortChats([older, newer]).map(c => c.uuid)).toEqual([newer.uuid, older.uuid])
	})

	it("treats a chat with no lastMessage as timestamp 0 (sorts to the bottom)", () => {
		const withMessage = mockChat({ uuid: testUuid("withMessage"), lastMessage: mockMessage({ sentTimestamp: 1n }) })
		const withoutMessage = mockChat({ uuid: testUuid("withoutMessage") })

		expect(sortChats([withoutMessage, withMessage]).map(c => c.uuid)).toEqual([withMessage.uuid, withoutMessage.uuid])
	})

	// The comparator converts with Number(), so ADJACENT bigints past MAX_SAFE_INTEGER collapse and fall
	// through to the uuid tiebreak — accepted, since ms timestamps sit nowhere near that range. What is
	// pinned here is that a bigint that far out still survives the conversion with its ordering intact.
	it("orders large bigint sentTimestamps that survive the comparator's Number() conversion", () => {
		const huge = mockChat({ uuid: testUuid("huge"), lastMessage: mockMessage({ sentTimestamp: 9_007_199_254_740_992n }) })
		const hugePlusOne = mockChat({
			uuid: testUuid("hugePlusOne"),
			lastMessage: mockMessage({ sentTimestamp: 9_007_199_254_740_994n })
		})

		expect(sortChats([huge, hugePlusOne]).map(c => c.uuid)).toEqual([hugePlusOne.uuid, huge.uuid])
	})

	it("tiebreaks two chats with equal (or absent) lastMessage timestamps deterministically by uuid, descending", () => {
		// parseNumbersFromString extracts digits from the uuid; "bbb-..." has no digits at all (both
		// resolve to 0) — use uuids carrying distinct digit runs so the tiebreak has something to bite.
		const a = mockChat({ uuid: testUuid("1") })
		const b = mockChat({ uuid: testUuid("2") })

		const sorted = sortChats([a, b])
		expect(sorted.map(c => c.uuid)).toEqual([b.uuid, a.uuid])
		// Stable regardless of input order.
		expect(sortChats([b, a]).map(c => c.uuid)).toEqual([b.uuid, a.uuid])
	})

	it("does not mutate the input array", () => {
		const input = [
			mockChat({ uuid: testUuid("a"), lastMessage: mockMessage({ sentTimestamp: 1n }) }),
			mockChat({ uuid: testUuid("b"), lastMessage: mockMessage({ sentTimestamp: 2n }) })
		]
		const snapshot = [...input]

		sortChats(input)

		expect(input).toEqual(snapshot)
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

	it("1:1 — uses the other participant's nickName when present", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com", nickName: "Bob" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self, solo)).toBe("Bob")
	})

	it("1:1 — falls back to email when the other participant has no nickName", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com", nickName: undefined })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self, solo)).toBe("other@example.com")
	})

	it("1:1 — treats an empty-string nickName the same as absent", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com", nickName: "" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self, solo)).toBe("other@example.com")
	})

	it("group — joins every other participant's display name, locale-sorted", () => {
		const p1 = mockParticipant({ userId: 2n, email: "zeta@example.com", nickName: undefined })
		const p2 = mockParticipant({ userId: 3n, email: "unused@example.com", nickName: "Alpha" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), p1, p2] })

		expect(chatDisplayName(chat, self, solo)).toBe("Alpha, zeta@example.com")
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
	const blocked = deriveBlockedUsers([mockBlockedContact({ userId: 9n, email: "zoe@example.com" })])

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
	const blocked = deriveBlockedUsers([mockBlockedContact({ userId: 9n, email: "zoe@example.com" })])

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
