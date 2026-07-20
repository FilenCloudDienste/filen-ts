import { vi, describe, it, expect, beforeEach } from "vitest"
import { type Chat } from "@/types"

const { mockCacheSet, mockQueryUpdaterSet } = vi.hoisted(() => ({
	mockCacheSet: vi.fn(),
	mockQueryUpdaterSet: vi.fn((_key: unknown, updater: unknown) =>
		typeof updater === "function" ? (updater as (prev: unknown) => unknown)(undefined) : updater
	)
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: { set: mockQueryUpdaterSet }
}))

vi.mock("@/lib/auth", () => ({ default: {} }))

vi.mock("@/lib/cache", () => ({
	default: {
		chatUuidToChat: { get: vi.fn(), set: mockCacheSet }
	}
}))

vi.mock("@/features/chats/chatsWrap", () => ({ wrapChat: (c: unknown) => c }))

import { chatsQueryUpdate } from "@/features/chats/queries/useChats.query"

const makeChat = (uuid: string): Chat => ({ uuid, name: `chat-${uuid}` }) as unknown as Chat

// chatsQueryUpdate is the optimistic path (chats.create / socket). cache.chatUuidToChat is otherwise
// seeded ONLY by the list query's fetchData, and useChatMessagesQuery.fetchData resolves the chat by
// uuid FROM that cache — so the updater must keep it in sync to avoid a refetch-first dependency.
describe("chatsQueryUpdate cache sync", () => {
	beforeEach(() => {
		mockCacheSet.mockClear()
		mockQueryUpdaterSet.mockClear()
	})

	it("seeds cache.chatUuidToChat for every chat in a direct-array update", () => {
		const a = makeChat("a")
		const b = makeChat("b")

		chatsQueryUpdate({ updater: [a, b] })

		expect(mockCacheSet).toHaveBeenCalledWith("a", a)
		expect(mockCacheSet).toHaveBeenCalledWith("b", b)
	})

	it("seeds cache.chatUuidToChat for a chat added by a function updater", () => {
		const created = makeChat("new")

		chatsQueryUpdate({ updater: prev => [...prev, created] })

		expect(mockCacheSet).toHaveBeenCalledWith("new", created)
	})
})
