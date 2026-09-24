import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"

// countUnreadMessages/sumUnread are pure, but they live in hook modules that transitively import the SDK
// client (a Vite `?worker`, unresolvable under node) — mock that boundary so the import chain evaluates,
// same posture as chatsQueries.test.ts.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { isMessageUnread, chatHasUnread, chatLastFocus } from "@/features/chats/lib/unread.logic"
import { countUnreadMessages } from "@/features/chats/hooks/useChatUnreadCount"
import { sumUnread } from "@/features/chats/hooks/useChatsUnreadCount"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 100n,
		...overrides
	}
}

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 2,
		senderEmail: "peer@x.io",
		senderNickName: "Peer",
		message: "hi",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 200n,
		...overrides
	}
}

// What the SDK hands over for a chat this account never focused: sdk-rs.d.ts types lastFocus as bigint,
// but an unset focus arrives as undefined.
function neverFocusedChat(overrides: Partial<Chat> = {}): Chat {
	return { ...mockChat(overrides), lastFocus: undefined } as unknown as Chat
}

const SELF = 1n

describe("chatLastFocus", () => {
	it("reads a chat never focused as the epoch, whether lastFocus is undefined or absent", () => {
		const absent: Partial<Chat> = mockChat()

		delete absent.lastFocus

		expect(chatLastFocus(neverFocusedChat())).toBe(0n)
		expect(chatLastFocus(absent)).toBe(0n)
	})

	it("passes a focus time through", () => {
		expect(chatLastFocus(mockChat({ lastFocus: 100n }))).toBe(100n)
	})
})

// Raw predicate coverage (muted/lastFocus/self/boundary/blocked-scan matrices) moved to
// @filen/shared's src/tests/chatUnread.test.ts (isMessageUnreadCore / chatHasUnreadCore) — these are
// thin adapter tests proving web's flat `senderId: number` → `BigInt()` coercion, the never-focused
// `lastFocus` read as the epoch, and `getMessages(uuid)` reader closure map correctly into the shared core.
describe("isMessageUnread", () => {
	it("is unread: a foreign message newer than lastFocus in an unmuted chat", () => {
		expect(isMessageUnread(mockMessage({ sentTimestamp: 200n }), mockChat({ lastFocus: 100n }), SELF)).toBe(true)
	})

	it("is unread: a foreign message in a chat this account never focused", () => {
		expect(isMessageUnread(mockMessage({ sentTimestamp: 200n }), neverFocusedChat(), SELF)).toBe(true)
	})

	it("is not unread: our own message in a chat this account never focused", () => {
		expect(isMessageUnread(mockMessage({ senderId: 1, sentTimestamp: 200n }), neverFocusedChat(), SELF)).toBe(false)
	})

	it("is not unread: our own message (senderId coerced from number to bigint before compare)", () => {
		expect(isMessageUnread(mockMessage({ senderId: 1, sentTimestamp: 200n }), mockChat(), SELF)).toBe(false)
	})

	it("is not unread: an unresolved current user id", () => {
		expect(isMessageUnread(mockMessage({ sentTimestamp: 200n }), mockChat(), undefined)).toBe(false)
	})

	it("is not unread: the sender is blocked by userId", () => {
		const blocked = deriveBlockedUsers([{ userId: 2n, email: "other@x.io" }])

		expect(isMessageUnread(mockMessage({ senderId: 2, sentTimestamp: 200n }), mockChat(), SELF, blocked)).toBe(false)
	})

	it("is not unread: the sender is blocked by email fallback (userId mismatch)", () => {
		const blocked = deriveBlockedUsers([{ userId: 999n, email: "peer@x.io" }])

		expect(
			isMessageUnread(mockMessage({ senderId: 2, senderEmail: "peer@x.io", sentTimestamp: 200n }), mockChat(), SELF, blocked)
		).toBe(false)
	})
})

describe("chatHasUnread (cheap boolean tier, with blocked cross-ref)", () => {
	it("true for a foreign newer lastMessage", () => {
		const chat = mockChat({ lastFocus: 0n, lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) })

		expect(chatHasUnread(chat, SELF)).toBe(true)
	})

	it("false for our own last message (senderId coerced from number to bigint before compare)", () => {
		expect(chatHasUnread(mockChat({ lastFocus: 0n, lastMessage: mockMessage({ senderId: 1, sentTimestamp: 900n }) }), SELF)).toBe(false)
	})

	it("true for a foreign lastMessage in a chat this account never focused", () => {
		expect(chatHasUnread(neverFocusedChat({ lastMessage: mockMessage({ senderId: 2, sentTimestamp: 900n }) }), SELF)).toBe(true)
	})
})

describe("chatHasUnread with a blocked last-message sender", () => {
	const blocked = deriveBlockedUsers([{ userId: 2n, email: "peer@x.io" }])

	function blockedLastMessageChat(overrides: Partial<Chat> = {}): Chat {
		return mockChat({
			lastFocus: 100n,
			lastMessage: mockMessage({ senderId: 2, senderEmail: "peer@x.io", sentTimestamp: 900n }),
			...overrides
		})
	}

	it("is true when an older cached message from a non-blocked sender is still unread (getMessages(uuid) wiring)", () => {
		const older = mockMessage({ uuid: testUuid("older"), senderId: 3, senderEmail: "third@x.io", sentTimestamp: 500n })

		expect(chatHasUnread(blockedLastMessageChat(), SELF, blocked, () => [older])).toBe(true)
	})

	it("answers on the cheap path without touching the reader when the last sender is not blocked", () => {
		const chat = mockChat({
			lastFocus: 100n,
			lastMessage: mockMessage({ senderId: 3, senderEmail: "third@x.io", sentTimestamp: 900n })
		})
		const getMessages = vi.fn(() => undefined)

		expect(chatHasUnread(chat, SELF, blocked, getMessages)).toBe(true)
		expect(getMessages).not.toHaveBeenCalled()
	})
})

describe("countUnreadMessages", () => {
	it("counts exactly the unread messages, excluding own, old, and blocked senders", () => {
		const chat = mockChat({ lastFocus: 100n })
		const blocked = deriveBlockedUsers([{ userId: 3n, email: "b@x.io" }])
		const messages = [
			mockMessage({ uuid: testUuid("m1"), senderId: 2, sentTimestamp: 150n }), // unread
			mockMessage({ uuid: testUuid("m2"), senderId: 2, sentTimestamp: 200n }), // unread
			mockMessage({ uuid: testUuid("m3"), senderId: 1, sentTimestamp: 250n }), // own → no
			mockMessage({ uuid: testUuid("m4"), senderId: 2, sentTimestamp: 50n }), // old → no
			mockMessage({ uuid: testUuid("m5"), senderId: 3, sentTimestamp: 300n }) // blocked → no
		]

		expect(countUnreadMessages(messages, chat, SELF, blocked)).toBe(2)
	})

	it("is zero for an empty message list", () => {
		expect(countUnreadMessages([], mockChat(), SELF, EMPTY_BLOCKED_USERS)).toBe(0)
	})

	it("counts every foreign message in a chat this account never focused", () => {
		const messages = [
			mockMessage({ uuid: testUuid("m1"), senderId: 2, sentTimestamp: 150n }),
			mockMessage({ uuid: testUuid("m2"), senderId: 2, sentTimestamp: 200n }),
			mockMessage({ uuid: testUuid("m3"), senderId: 1, sentTimestamp: 250n })
		]

		expect(countUnreadMessages(messages, neverFocusedChat(), SELF, EMPTY_BLOCKED_USERS)).toBe(2)
	})
})

describe("sumUnread (global tally + missing-cache self-heal signal)", () => {
	const chatA = mockChat({ uuid: testUuid("a"), lastFocus: 100n })
	const chatB = mockChat({ uuid: testUuid("b"), lastFocus: 100n })

	it("sums unread across every chat whose message cache is resident", () => {
		const cache = new Map<string, ChatMessage[]>([
			[chatA.uuid, [mockMessage({ uuid: testUuid("m1"), senderId: 2, sentTimestamp: 150n })]],
			[
				chatB.uuid,
				[
					mockMessage({ uuid: testUuid("m2"), senderId: 2, sentTimestamp: 150n }),
					mockMessage({ uuid: testUuid("m3"), senderId: 2, sentTimestamp: 200n })
				]
			]
		])

		const result = sumUnread([chatA, chatB], uuid => cache.get(uuid), SELF, EMPTY_BLOCKED_USERS)

		expect(result).toEqual({ count: 3, hasMissingMessages: false })
	})

	it("flags hasMissingMessages and skips (does NOT zero-count) a chat with no resident message cache", () => {
		const cache = new Map<string, ChatMessage[]>([[chatA.uuid, [mockMessage({ senderId: 2, sentTimestamp: 150n })]]])

		const result = sumUnread([chatA, chatB], uuid => cache.get(uuid), SELF, EMPTY_BLOCKED_USERS)

		// chatB's cache is undefined → excluded from the count and flagged for a bulk self-heal.
		expect(result).toEqual({ count: 1, hasMissingMessages: true })
	})

	it("is a clean zero for no chats", () => {
		expect(sumUnread([], () => undefined, SELF, EMPTY_BLOCKED_USERS)).toEqual({ count: 0, hasMissingMessages: false })
	})
})
