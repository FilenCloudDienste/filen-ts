import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { listChats, listMessagesBefore } = vi.hoisted(() => ({
	listChats: vi.fn<() => Promise<Chat[]>>(),
	listMessagesBefore: vi.fn<(chat: Chat, before: bigint) => Promise<ChatMessage[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listChats, listMessagesBefore } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { refetchChatsAndMessages } from "@/features/chats/lib/refetchChatsAndMessages"

function mockChat(label: string): Chat {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		key: "k",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n
	}
}

function mockMessage(label: string, chatLabel: string): ChatMessage {
	return {
		uuid: testUuid(label),
		chat: testUuid(chatLabel),
		senderId: 2,
		senderEmail: "p@x.io",
		senderNickName: "P",
		message: "m",
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 10n
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

describe("refetchChatsAndMessages", () => {
	it("fetches the list, then every chat's messages, and writes both into cache", async () => {
		const a = mockChat("a")
		const b = mockChat("b")
		listChats.mockResolvedValueOnce([a, b])
		listMessagesBefore.mockImplementation(chat => Promise.resolve([mockMessage(`m-${chat.uuid}`, chat.uuid)]))

		await refetchChatsAndMessages()

		expect(chatsQueryGet()).toEqual([a, b])
		expect(chatMessagesQueryGet(a.uuid)).toHaveLength(1)
		expect(chatMessagesQueryGet(b.uuid)).toHaveLength(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(2)
	})

	it("still publishes an empty list (chats removed) and fans out over nothing", async () => {
		testQueryClient.setQueryData(["chats", "list"], [mockChat("stale")])
		listChats.mockResolvedValueOnce([])

		await refetchChatsAndMessages()

		expect(chatsQueryGet()).toEqual([])
		expect(listMessagesBefore).not.toHaveBeenCalled()
	})

	it("tolerates a per-chat message failure: the list and the other chats still land", async () => {
		const a = mockChat("a")
		const b = mockChat("b")
		listChats.mockResolvedValueOnce([a, b])
		listMessagesBefore.mockImplementation(chat => {
			if (chat.uuid === a.uuid) {
				return Promise.reject(new Error("flaky"))
			}

			return Promise.resolve([mockMessage("mb", chat.uuid)])
		})

		await refetchChatsAndMessages()

		// The flaky chat's cache stays untouched (undefined), the healthy chat's messages land, and the
		// list still publishes — a single flaky read never poisons the whole resync.
		expect(chatMessagesQueryGet(a.uuid)).toBeUndefined()
		expect(chatMessagesQueryGet(b.uuid)).toHaveLength(1)
		expect(chatsQueryGet()).toEqual([a, b])
	})

	it("serializes overlapping callers through its Semaphore(1) — never two list fetches in flight at once", async () => {
		let inFlight = 0
		let maxConcurrent = 0
		listChats.mockImplementation(async () => {
			inFlight++
			maxConcurrent = Math.max(maxConcurrent, inFlight)
			await new Promise(resolve => setTimeout(resolve, 5))
			inFlight--

			return [mockChat("a")]
		})
		listMessagesBefore.mockResolvedValue([mockMessage("m", testUuid("a"))])

		await Promise.all([refetchChatsAndMessages(), refetchChatsAndMessages(), refetchChatsAndMessages()])

		expect(maxConcurrent).toBe(1)
	})
})
