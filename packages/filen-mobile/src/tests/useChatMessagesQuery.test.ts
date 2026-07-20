import { vi, describe, it, expect, beforeEach } from "vitest"
import { type Chat } from "@/types"

// useChatMessages.query.fetchData resolution + cache-coherence guards:
//   1. prefer the by-value `chat` param (refetchChatsAndMessages' fan-out) — it short-circuits the
//      chats-query lookup so a chat the list query hasn't committed yet still resolves;
//   2. otherwise resolve from the chats-list query (the sole substrate for chat identity);
//   3. on a TRUE miss (no by-value chat, not in the chats query), return the already-cached messages
//      (chatMessagesQueryGet) rather than [] so a remount/focus/reconnect re-run does not clobber
//      socket-delivered or optimistic messages with an empty success result.
//   The `chat` param is NEVER part of the query key — chatMessagesQueryKey strips it to { uuid }.

const { mockGetSdkClients, mockSdkClient, mockChatsQueryGet, mockQueryUpdaterGet } = vi.hoisted(() => {
	const mockSdkClient = {
		listMessagesBefore: vi.fn()
	}

	return {
		mockSdkClient,
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockSdkClient }),
		mockChatsQueryGet: vi.fn().mockReturnValue([]),
		mockQueryUpdaterGet: vi.fn().mockReturnValue(undefined)
	}
})

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	// sortParams feeds chatMessagesQueryGet's key on the true-miss path — identity is fine for the test.
	sortParams: <T>(params: T): T => params
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
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

import { fetchData, chatMessagesQueryKey } from "@/features/chats/queries/useChatMessages.query"

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

const makeChat = (uuid: string): Chat => ({ uuid, key: "k" }) as unknown as Chat

describe("useChatMessages.query fetchData (resolution + cache coherence)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockSdkClient.listMessagesBefore.mockReset()
		mockChatsQueryGet.mockReset().mockReturnValue([])
		mockQueryUpdaterGet.mockReset().mockReturnValue(undefined)
	})

	it("resolves the chat by value (chat param) and lists its messages without consulting the chats query", async () => {
		mockSdkClient.listMessagesBefore.mockResolvedValueOnce([mockMessage("m1", "hi")])

		const result = await fetchData({ uuid: "chat-1", chat: makeChat("chat-1") })

		// The by-value chat short-circuits the ?? — the chats query is never consulted.
		expect(mockChatsQueryGet).not.toHaveBeenCalled()
		expect(mockSdkClient.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect(result).toHaveLength(1)
		expect(result[0]!.inner.uuid).toBe("m1")
		expect(result[0]!.inflightId).toBe("")
	})

	it("prefers the by-value chat over a chats-query entry for the same uuid", async () => {
		const byValue = makeChat("chat-1")

		// The list query also holds an entry for this uuid — the by-value chat must win.
		mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1", key: "from-list" }])
		mockSdkClient.listMessagesBefore.mockResolvedValueOnce([])

		await fetchData({ uuid: "chat-1", chat: byValue })

		expect(mockChatsQueryGet).not.toHaveBeenCalled()
		expect(mockSdkClient.listMessagesBefore).toHaveBeenCalledWith(byValue, expect.anything(), undefined)
	})

	it("resolves via the chats query when no by-value chat is passed, then lists messages", async () => {
		mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1", key: "k" }])
		mockSdkClient.listMessagesBefore.mockResolvedValueOnce([mockMessage("m2", "from-chats-query")])

		const result = await fetchData({ uuid: "chat-1" })

		expect(mockChatsQueryGet).toHaveBeenCalled()
		expect(mockSdkClient.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect(result).toHaveLength(1)
		expect(result[0]!.inner.uuid).toBe("m2")
	})

	it("on a TRUE miss returns the already-cached messages (no empty-clobber)", async () => {
		// No by-value chat, not in the chats query.
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

	it("chatMessagesQueryKey strips the by-value chat — { uuid, chat } keys identically to { uuid }", () => {
		const withChat = chatMessagesQueryKey({ uuid: "chat-1", chat: makeChat("chat-1") })
		const withoutChat = chatMessagesQueryKey({ uuid: "chat-1" })

		expect(withChat).toEqual({ uuid: "chat-1" })
		expect(withChat).toEqual(withoutChat)
	})
})
