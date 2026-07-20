import { vi, describe, it, expect, beforeEach } from "vitest"
import { type Chat } from "@/types"

const { mockQueryUpdaterSet } = vi.hoisted(() => ({
	// Mirror queryUpdater.set closely enough for the test: invoke the passed updater with no prior
	// data and expose its return value (the list the real updater would persist) via the mock result.
	mockQueryUpdaterSet: vi.fn((_key: unknown, updater: unknown) =>
		typeof updater === "function" ? (updater as (prev: unknown) => unknown)(undefined) : updater
	)
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: { set: mockQueryUpdaterSet }
}))

vi.mock("@/lib/auth", () => ({ default: {} }))

vi.mock("@/features/chats/chatsWrap", () => ({ wrapChat: (c: unknown) => c }))

import { chatsQueryUpdate } from "@/features/chats/queries/useChats.query"

const makeChat = (uuid: string): Chat => ({ uuid, name: `chat-${uuid}` }) as unknown as Chat

// chatsQueryUpdate is the optimistic path (chats.create / socket). It commits the computed list to
// the single chats-list query verbatim — that query is the sole substrate consumers resolve against.
describe("chatsQueryUpdate", () => {
	beforeEach(() => {
		mockQueryUpdaterSet.mockClear()
	})

	it("commits a direct-array update unchanged", () => {
		const a = makeChat("a")
		const b = makeChat("b")

		chatsQueryUpdate({ updater: [a, b] })

		expect(mockQueryUpdaterSet).toHaveBeenCalledTimes(1)
		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([a, b])
	})

	it("applies a function updater against the prior list", () => {
		const created = makeChat("new")

		chatsQueryUpdate({ updater: prev => [...prev, created] })

		expect(mockQueryUpdaterSet.mock.results[0]?.value).toEqual([created])
	})
})
