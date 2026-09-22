// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	chatMessages: [] as unknown[] | undefined,
	chatMessagesQueryStatus: "success" as "success" | "error" | "pending",
	stringifiedClient: { userId: 1n } as { userId: bigint } | null
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/features/chats/queries/useChatMessages.query", () => ({
	default: (_params: unknown, _options: unknown) => ({
		status: mocks.chatMessagesQueryStatus,
		data: mocks.chatMessages
	}),
	fetchData: vi.fn().mockResolvedValue([])
}))

vi.mock("@/lib/auth", () => ({
	useStringifiedClient: () => mocks.stringifiedClient
}))

// useBlockedUsers pulls the contacts query → query client → op-sqlite; stub it (no blocked users).
vi.mock("@/features/contacts/hooks/useBlockedUsers", () => ({
	default: () => ({ userIds: new Set(), emails: new Set() })
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
import { useChatUnreadCount } from "@/features/chats/hooks/useChatUnreadCount"
import type { Chat, ChatMessage } from "@/types"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: "chat-1",
		ownerId: 1n,
		muted: false,
		participants: [],
		undecryptable: false,
		key: "some-key",
		created: 1n,
		lastFocus: 100n,
		lastMessage: {
			sentTimestamp: 200n,
			inner: {
				senderId: 999n
			}
		},
		...overrides
	} as unknown as Chat
}

function makeMessage(overrides: Partial<{ senderId: bigint; sentTimestamp: bigint }> = {}): ChatMessage {
	return {
		chat: "chat-1",
		inner: {
			uuid: "msg-1",
			message: "hello",
			senderId: overrides.senderId ?? 999n,
			senderEmail: "other@test.com",
			senderNickName: undefined
		},
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: overrides.sentTimestamp ?? 200n,
		replyTo: undefined,
		undecryptable: false
	} as unknown as ChatMessage
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	mocks.chatMessages = []
	mocks.chatMessagesQueryStatus = "success"
	mocks.stringifiedClient = { userId: 1n }
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useChatUnreadCount", () => {
	it("returns 0 when the query has no data at all", () => {
		// The load-bearing `!chatMessagesQuery.data` guard. Every other test hands the mock an array, so
		// without this one the guard could be deleted and the suite would stay green while a chat whose
		// messages were never fetched — a routine state for a disabled observer with nothing persisted —
		// crashed the row on `.filter` of undefined.
		mocks.chatMessages = undefined

		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 while there is genuinely nothing cached yet", () => {
		mocks.chatMessagesQueryStatus = "pending"

		const chat = makeChat()

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("still counts from cached messages after the last fetch failed (#103)", () => {
		// The offline case: the refetch fails and TanStack flips `status` to "error" while KEEPING
		// the messages. This used to report zero unread for as long as the device was offline.
		mocks.chatMessagesQueryStatus = "error"
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n, senderId: 999n })]

		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(1)
	})

	it("returns 0 without a signed-in user, whatever is cached", () => {
		// "Unread by me" has no meaning without a user. Asserted directly now — it used to fall out
		// of the status gate by accident, which is why replacing that gate exposed it.
		mocks.stringifiedClient = null
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n, senderId: 999n })]

		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 when messages array is empty", () => {
		mocks.chatMessages = []

		const chat = makeChat()

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 when chat.muted=true regardless of timestamps", () => {
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n, senderId: 999n })]

		const chat = makeChat({ muted: true })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 when chat.lastFocus is null/undefined", () => {
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n })]

		const chat = makeChat({ lastFocus: null as unknown as bigint })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 when chat.lastMessage is null/undefined", () => {
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n })]

		const chat = makeChat({ lastMessage: null as unknown as Chat["lastMessage"] })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 when message.sentTimestamp === chat.lastFocus (boundary — strictly greater than required)", () => {
		mocks.chatMessages = [makeMessage({ sentTimestamp: 100n, senderId: 999n })]

		// lastFocus = 100n, sentTimestamp = 100n — NOT strictly greater than
		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 0 when message.sentTimestamp < chat.lastFocus", () => {
		mocks.chatMessages = [makeMessage({ sentTimestamp: 50n, senderId: 999n })]

		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("returns 1 when a single message has sentTimestamp > lastFocus and sender is not self", () => {
		// mocks.stringifiedClient.userId = 1n, sender = 999n → not self
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n, senderId: 999n })]

		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(1)
	})

	it("returns 0 when message is from self (senderId === stringifiedClient.userId) even if newer than lastFocus", () => {
		// userId = 1n, sender = 1n → self
		mocks.stringifiedClient = { userId: 1n }
		mocks.chatMessages = [makeMessage({ sentTimestamp: 200n, senderId: 1n })]

		const chat = makeChat({ lastFocus: 100n })

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(0)
	})

	it("counts only messages passing ALL four conditions simultaneously", () => {
		mocks.stringifiedClient = { userId: 1n }

		const chat = makeChat({ lastFocus: 100n, muted: false })

		mocks.chatMessages = [
			// Message 1: timestamp > lastFocus AND not self → COUNTS
			makeMessage({ sentTimestamp: 200n, senderId: 999n }),
			// Message 2: timestamp === lastFocus (boundary, NOT strictly greater) → does NOT count
			makeMessage({ sentTimestamp: 100n, senderId: 999n }),
			// Message 3: timestamp > lastFocus but self → does NOT count
			makeMessage({ sentTimestamp: 200n, senderId: 1n }),
			// Message 4: timestamp > lastFocus AND not self → COUNTS
			makeMessage({ sentTimestamp: 300n, senderId: 888n })
		]

		const { result } = renderHook(() => useChatUnreadCount(chat))

		expect(result.current).toBe(2)
	})
})

// The former "isMessageUnread — direct unit tests (#192)" block here duplicated chatSelectors.test.ts's
// raw-predicate coverage; it has been folded into @filen/shared's src/tests/chatUnread.test.ts
// (isMessageUnreadCore). chatSelectors.test.ts keeps mobile's thin adapter test.
