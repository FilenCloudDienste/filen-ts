// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	chatsQueryStatus: "success" as "success" | "error" | "pending",
	chatsQueryData: [] as unknown[],
	// chatMessagesQueryGet returns a messages array or null (missing)
	chatMessagesMap: new Map<string, unknown[] | null>(),
	stringifiedClient: { userId: 1n } as { userId: bigint } | null,
	refetchChatsAndMessages: vi.fn().mockResolvedValue(undefined)
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/features/chats/queries/useChats.query", () => ({
	default: (_options: unknown) => ({
		status: mocks.chatsQueryStatus,
		data: mocks.chatsQueryData
	}),
	fetchData: vi.fn().mockResolvedValue([])
}))

vi.mock("@/features/chats/queries/useChatMessages.query", () => ({
	chatMessagesQueryGet: (params: { uuid: string }) => mocks.chatMessagesMap.get(params.uuid) ?? null,
	default: vi.fn(),
	fetchData: vi.fn().mockResolvedValue([])
}))

vi.mock("@/features/chats/chats", () => ({
	default: {
		refetchChatsAndMessages: () => mocks.refetchChatsAndMessages()
	}
}))

vi.mock("@/lib/auth", () => ({
	useStringifiedClient: () => mocks.stringifiedClient
}))

// useBlockedUsers pulls the contacts query → query client → op-sqlite; stub it (no blocked users).
vi.mock("@/features/contacts/hooks/useBlockedUsers", () => ({
	default: () => ({ userIds: new Set(), emails: new Set() })
}))

vi.mock("@/hooks/useEffectOnce", () => ({
	default: (fn: () => void) => {
		fn()
	}
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import type { Chat, ChatMessage } from "@/types"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeChat(uuid: string, overrides: Partial<Chat> = {}): Chat {
	return {
		uuid,
		ownerId: 1n,
		muted: false,
		participants: [],
		undecryptable: false,
		key: "key",
		created: 1n,
		lastFocus: 100n,
		lastMessage: {
			sentTimestamp: 200n,
			inner: { senderId: 999n }
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
	mocks.chatsQueryStatus = "success"
	mocks.chatsQueryData = []
	mocks.chatMessagesMap.clear()
	mocks.stringifiedClient = { userId: 1n }
	mocks.refetchChatsAndMessages.mockClear()
	mocks.refetchChatsAndMessages.mockResolvedValue(undefined)
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useChatsUnreadCount", () => {
	it("returns 0 when chatsQuery is not 'success'", () => {
		mocks.chatsQueryStatus = "pending"

		const { result } = renderHook(() => useChatsUnreadCount())

		expect(result.current).toBe(0)
	})

	it("returns 0 when stringifiedClient is null", () => {
		mocks.stringifiedClient = null
		mocks.chatsQueryStatus = "success"
		const chat = makeChat("c1")

		mocks.chatsQueryData = [chat]
		mocks.chatMessagesMap.set("c1", [makeMessage({ sentTimestamp: 200n, senderId: 999n })])

		const { result } = renderHook(() => useChatsUnreadCount())

		expect(result.current).toBe(0)
	})

	it("sets hasMissingMessages and triggers refetch when chatMessagesQueryGet returns null for any chat", () => {
		const chat1 = makeChat("c1")
		const chat2 = makeChat("c2")

		mocks.chatsQueryData = [chat1, chat2]
		// c1 has messages, c2 is null (missing)
		mocks.chatMessagesMap.set("c1", [makeMessage({ sentTimestamp: 200n, senderId: 999n })])
		// c2 → null (not in map, chatMessagesQueryGet returns null)

		const { result } = renderHook(() => useChatsUnreadCount())

		// Chat c1 has 1 unread message, chat c2 is missing (triggers refetch)
		expect(result.current).toBe(1)
		// hasMissingMessages=true → useEffect called refetchChatsAndMessages
		expect(mocks.refetchChatsAndMessages).toHaveBeenCalled()
	})

	it("skips (continue) the chat with missing messages but still counts other chats", () => {
		const chat1 = makeChat("c1") // has messages → counted
		const chat2 = makeChat("c2") // missing messages → skipped
		const chat3 = makeChat("c3") // has messages → counted

		mocks.chatsQueryData = [chat1, chat2, chat3]
		mocks.chatMessagesMap.set("c1", [makeMessage({ sentTimestamp: 200n, senderId: 999n })])
		// c2 is missing (null)
		mocks.chatMessagesMap.set("c3", [
			makeMessage({ sentTimestamp: 200n, senderId: 888n }),
			makeMessage({ sentTimestamp: 300n, senderId: 777n })
		])

		const { result } = renderHook(() => useChatsUnreadCount())

		// c1: 1 unread, c3: 2 unread, c2: skipped
		expect(result.current).toBe(3)
	})

	it("skips (continue) chats whose messages array is empty — they don't set hasMissingMessages", () => {
		const chat1 = makeChat("c1") // empty messages array
		const chat2 = makeChat("c2") // has messages

		mocks.chatsQueryData = [chat1, chat2]
		mocks.chatMessagesMap.set("c1", []) // empty array, not null
		mocks.chatMessagesMap.set("c2", [makeMessage({ sentTimestamp: 200n, senderId: 999n })])

		const { result } = renderHook(() => useChatsUnreadCount())

		// c1 skipped (empty), c2 has 1 unread
		expect(result.current).toBe(1)
		// hasMissingMessages=false means the hasMissingMessages useEffect does NOT call refetch.
		// However, useEffectOnce always fires once on mount (initial sync) when stringifiedClient
		// is non-null. We verify hasMissingMessages=false by checking refetch was called at most
		// once (only from useEffectOnce, not from the hasMissingMessages effect).
		expect(mocks.refetchChatsAndMessages).toHaveBeenCalledTimes(1)
	})

	it("hasMissingMessages=false when all chats have message arrays (even empty ones)", () => {
		const chat1 = makeChat("c1")
		const chat2 = makeChat("c2")

		mocks.chatsQueryData = [chat1, chat2]
		mocks.chatMessagesMap.set("c1", []) // empty but present
		mocks.chatMessagesMap.set("c2", []) // empty but present

		renderHook(() => useChatsUnreadCount())

		// When hasMissingMessages=false, only the useEffectOnce initial call runs (once).
		// The hasMissingMessages dependency effect does NOT fire an extra refetch.
		expect(mocks.refetchChatsAndMessages).toHaveBeenCalledTimes(1)
	})

	it("correctly sums unread counts across multiple chats", () => {
		const chat1 = makeChat("c1", { lastFocus: 100n })
		const chat2 = makeChat("c2", { lastFocus: 50n })
		const chat3 = makeChat("c3", { lastFocus: 200n })

		mocks.chatsQueryData = [chat1, chat2, chat3]

		// c1: 2 messages newer than lastFocus(100) from non-self → 2 unread
		mocks.chatMessagesMap.set("c1", [
			makeMessage({ sentTimestamp: 200n, senderId: 999n }),
			makeMessage({ sentTimestamp: 300n, senderId: 888n })
		])

		// c2: 1 message newer than lastFocus(50) from non-self → 1 unread
		mocks.chatMessagesMap.set("c2", [makeMessage({ sentTimestamp: 100n, senderId: 999n })])

		// c3: message at boundary (200n === lastFocus 200n) → 0 unread
		mocks.chatMessagesMap.set("c3", [makeMessage({ sentTimestamp: 200n, senderId: 999n })])

		const { result } = renderHook(() => useChatsUnreadCount())

		// c1: 2, c2: 1, c3: 0 → total 3
		expect(result.current).toBe(3)
	})

	it("returns 0 when chats have no unread messages (all old messages)", () => {
		const chat = makeChat("c1", { lastFocus: 500n })

		mocks.chatsQueryData = [chat]
		mocks.chatMessagesMap.set("c1", [
			makeMessage({ sentTimestamp: 100n, senderId: 999n }),
			makeMessage({ sentTimestamp: 200n, senderId: 999n })
		])

		const { result } = renderHook(() => useChatsUnreadCount())

		expect(result.current).toBe(0)
	})

	it("returns 0 when all messages are from self", () => {
		mocks.stringifiedClient = { userId: 1n }

		const chat = makeChat("c1", { lastFocus: 100n })

		mocks.chatsQueryData = [chat]
		mocks.chatMessagesMap.set("c1", [
			makeMessage({ sentTimestamp: 200n, senderId: 1n }),
			makeMessage({ sentTimestamp: 300n, senderId: 1n })
		])

		const { result } = renderHook(() => useChatsUnreadCount())

		expect(result.current).toBe(0)
	})
})
