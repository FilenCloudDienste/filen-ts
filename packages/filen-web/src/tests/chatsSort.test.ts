import { describe, expect, it } from "vitest"
import type { Chat, ChatMessage, ChatParticipant, UuidStr } from "@filen/sdk-rs"
import { chatDisplayName, chatMessagePreview, isChatUndecryptable, sortChats } from "@/features/chats/lib/sort"

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

	it("bigint sentTimestamp values beyond Number.MAX_SAFE_INTEGER still order correctly", () => {
		const huge = mockChat({ uuid: testUuid("huge"), lastMessage: mockMessage({ sentTimestamp: 9_007_199_254_740_993n }) })
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

	it("falls back to the raw uuid for an undecryptable chat, ignoring name/participants", () => {
		const uuid = testUuid("undecryptable")
		const chat = mockUndecryptableChat({ uuid, name: "should be ignored" })

		expect(chatDisplayName(chat, self)).toBe(uuid)
	})

	it("uses the explicit chat name when set", () => {
		const chat = mockChat({ name: "Team Chat", participants: [mockParticipant({ userId: self })] })

		expect(chatDisplayName(chat, self)).toBe("Team Chat")
	})

	it("ignores an empty-string name and falls through to participant derivation", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com" })
		const chat = mockChat({ name: "", participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self)).toBe("other@example.com")
	})

	it("1:1 — uses the other participant's nickName when present", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com", nickName: "Bob" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self)).toBe("Bob")
	})

	it("1:1 — falls back to email when the other participant has no nickName", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com", nickName: undefined })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self)).toBe("other@example.com")
	})

	it("1:1 — treats an empty-string nickName the same as absent", () => {
		const other = mockParticipant({ userId: 2n, email: "other@example.com", nickName: "" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), other] })

		expect(chatDisplayName(chat, self)).toBe("other@example.com")
	})

	it("group — joins every other participant's display name, locale-sorted", () => {
		const p1 = mockParticipant({ userId: 2n, email: "zeta@example.com", nickName: undefined })
		const p2 = mockParticipant({ userId: 3n, email: "unused@example.com", nickName: "Alpha" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self }), p1, p2] })

		expect(chatDisplayName(chat, self)).toBe("Alpha, zeta@example.com")
	})

	it("excludes the current user from the joined group name", () => {
		const p1 = mockParticipant({ userId: 2n, email: "other@example.com" })
		const chat = mockChat({ participants: [mockParticipant({ userId: self, email: "self@example.com" }), p1] })

		expect(chatDisplayName(chat, self)).toBe("other@example.com")
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
