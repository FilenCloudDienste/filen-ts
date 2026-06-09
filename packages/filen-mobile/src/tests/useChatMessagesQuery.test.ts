import { vi, describe, it, expect, beforeEach } from "vitest"

// #18 — useChatMessages.query.fetchData cache-coherence guards:
//   1. on a cache.chatUuidToChat miss, fall back to the chats query before giving up;
//   2. on a TRUE miss (not in cache nor chats query), return the already-cached messages
//      (chatMessagesQueryGet) rather than [] so a remount/focus/reconnect re-run does not
//      clobber socket-delivered or optimistic messages with an empty success result.

const { mockGetSdkClients, mockSdkClient, mockChatsQueryGet, mockQueryUpdaterGet, cacheMap } = vi.hoisted(() => {
	const mockSdkClient = {
		listMessagesBefore: vi.fn()
	}

	return {
		mockSdkClient,
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockSdkClient }),
		mockChatsQueryGet: vi.fn().mockReturnValue([]),
		mockQueryUpdaterGet: vi.fn().mockReturnValue(undefined),
		cacheMap: new Map<string, unknown>()
	}
})

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	// sortParams is used by chatMessagesQueryGet on the true-miss path — identity is fine for the test.
	sortParams: <T>(params: T): T => params
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		chatUuidToChat: cacheMap
	}
}))

vi.mock("@/features/chats/queries/useChats.query", () => ({
	chatsQueryGet: mockChatsQueryGet
}))

vi.mock("@/features/chats/chatsWrap", () => ({
	wrapMessage: vi.fn((msg: unknown) => ({ ...(msg as Record<string, unknown>), undecryptable: false }))
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: mockQueryUpdaterGet,
		set: vi.fn()
	}
}))

import { fetchData } from "@/features/chats/queries/useChatMessages.query"

function mockMessage(uuid: string, message: string) {
	return {
		chat: "chat-1",
		inner: { uuid, message, senderId: 1n, senderEmail: "t@t.com", senderNickName: undefined },
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		replyTo: undefined
	}
}

describe("useChatMessages.query fetchData (#18 cache coherence)", () => {
	beforeEach(() => {
		cacheMap.clear()
		mockGetSdkClients.mockClear()
		mockSdkClient.listMessagesBefore.mockReset()
		mockChatsQueryGet.mockReset().mockReturnValue([])
		mockQueryUpdaterGet.mockReset().mockReturnValue(undefined)
	})

	it("resolves the chat from cache.chatUuidToChat and lists its messages", async () => {
		cacheMap.set("chat-1", { uuid: "chat-1", key: "k" })
		mockSdkClient.listMessagesBefore.mockResolvedValueOnce([mockMessage("m1", "hi")])

		const result = await fetchData({ uuid: "chat-1" })

		expect(mockSdkClient.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect(result).toHaveLength(1)
		expect(result[0]!.inner.uuid).toBe("m1")
		expect(result[0]!.inflightId).toBe("")
	})

	it("falls back to the chats query on a cache miss, then lists messages", async () => {
		// Not in cache.
		mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1", key: "k" }])
		mockSdkClient.listMessagesBefore.mockResolvedValueOnce([mockMessage("m2", "from-chats-query")])

		const result = await fetchData({ uuid: "chat-1" })

		expect(mockChatsQueryGet).toHaveBeenCalled()
		expect(mockSdkClient.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect(result).toHaveLength(1)
		expect(result[0]!.inner.uuid).toBe("m2")
	})

	it("seeds cache.chatUuidToChat after resolving via the chats-query fallback", async () => {
		mockChatsQueryGet.mockReturnValue([{ uuid: "chat-seed", key: "k" }])
		mockSdkClient.listMessagesBefore.mockResolvedValueOnce([])

		await fetchData({ uuid: "chat-seed" })

		expect(cacheMap.get("chat-seed")).toBeDefined()
	})

	it("on a TRUE miss returns the already-cached messages (no empty-clobber)", async () => {
		// Not in cache, not in chats query.
		mockChatsQueryGet.mockReturnValue([{ uuid: "other-chat", key: "k" }])

		const cached = [{ ...mockMessage("socket-msg", "delivered via socket"), inflightId: "" }]

		mockQueryUpdaterGet.mockReturnValue(cached)

		const result = await fetchData({ uuid: "missing-chat" })

		// Did NOT hit the network and did NOT return [] — returned the existing cached messages.
		expect(mockSdkClient.listMessagesBefore).not.toHaveBeenCalled()
		expect(result).toBe(cached)
		expect(result).toHaveLength(1)
		expect(result[0]!.inner.uuid).toBe("socket-msg")
	})

	it("on a TRUE miss with no cached messages returns an empty array", async () => {
		mockChatsQueryGet.mockReturnValue([])
		mockQueryUpdaterGet.mockReturnValue(undefined)

		const result = await fetchData({ uuid: "totally-unknown" })

		expect(mockSdkClient.listMessagesBefore).not.toHaveBeenCalled()
		expect(result).toEqual([])
	})
})
