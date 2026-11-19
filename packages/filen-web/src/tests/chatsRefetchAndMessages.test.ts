import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage } from "@filen/sdk-rs"

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
import { setFocusedChat } from "@/features/chats/lib/focusedChat"
import { testUuid } from "@/tests/support/uuid"

// By default a chat with a last message newer than its lastFocus: one whose unread the list cannot rule out.
// `lastMessage: null` builds one with no last message.
function mockChat(label: string, overrides: Omit<Partial<Chat>, "lastMessage"> & { lastMessage?: ChatMessage | null } = {}): Chat {
	const { lastMessage = mockMessage(`last-${label}`, label), ...rest } = overrides

	return {
		uuid: testUuid(label),
		ownerId: 1n,
		key: "k",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...(lastMessage !== null ? { lastMessage } : {}),
		...rest
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
	setFocusedChat(null)
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

	// The reconnect resync pulls only the newest page per chat; an open thread with older pages scrolled
	// in must not lose them to it.
	it("merges each chat's newest page into its cache instead of replacing the paged-in history", async () => {
		const a = mockChat("a")
		const pagedIn: ChatMessage = { ...mockMessage("old", "a"), sentTimestamp: 1n }
		const newest = mockMessage("new", "a")
		testQueryClient.setQueryData(["chats", "messages", { chatUuid: a.uuid }], [pagedIn, newest])
		listChats.mockResolvedValueOnce([a])
		listMessagesBefore.mockResolvedValueOnce([newest])

		await refetchChatsAndMessages()

		expect(chatMessagesQueryGet(a.uuid)?.map(m => m.uuid)).toEqual([pagedIn.uuid, newest.uuid])
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

	// The list row proves these read, so their pages are not read; opening the thread reads them.
	it("reads no page for a chat that is muted, has no last message, or whose last message is not newer than lastFocus", async () => {
		const muted = mockChat("muted", { muted: true })
		const empty = mockChat("empty", { lastMessage: null })
		const read = mockChat("read", { lastFocus: 10n })
		const unread = mockChat("unread", { lastFocus: 9n })
		listChats.mockResolvedValueOnce([muted, empty, read, unread])
		listMessagesBefore.mockResolvedValue([])

		await refetchChatsAndMessages()

		expect(listMessagesBefore.mock.calls.map(([chat]) => chat.uuid)).toEqual([unread.uuid])
		expect(chatMessagesQueryGet(muted.uuid)).toBeUndefined()
		expect(chatMessagesQueryGet(read.uuid)).toBeUndefined()
	})

	it("still reads the page of a chat whose newer last message is from a blocked sender", async () => {
		// The list cannot tell a blocked sender apart, and an older unread may sit behind their message.
		const blockedLast = mockChat("blocked-last", { lastMessage: { ...mockMessage("bm", "blocked-last"), senderEmail: "blocked@x.io" } })
		listChats.mockResolvedValueOnce([blockedLast])
		listMessagesBefore.mockResolvedValue([])

		await refetchChatsAndMessages()

		expect(listMessagesBefore).toHaveBeenCalledTimes(1)
	})

	it("the missing-only heal skips a provably read chat too", async () => {
		testQueryClient.setQueryData(["chats", "list"], [mockChat("read", { lastFocus: 10n }), mockChat("unread")])
		listMessagesBefore.mockResolvedValue([])

		await refetchChatsAndMessages({ onlyMissing: true })

		expect(listMessagesBefore.mock.calls.map(([chat]) => chat.uuid)).toEqual([testUuid("unread")])
	})

	// A mounted thread does not re-read on its own, so the reconnect pass is what brings in what it missed.
	it("reads the open thread's page on the full pass even when its row proves it read", async () => {
		const muted = mockChat("muted", { muted: true })
		const read = mockChat("read", { lastFocus: 10n })
		listChats.mockResolvedValue([muted, read])
		listMessagesBefore.mockResolvedValue([])

		setFocusedChat(muted.uuid)
		await refetchChatsAndMessages()
		expect(listMessagesBefore.mock.calls.map(([chat]) => chat.uuid)).toEqual([muted.uuid])

		listMessagesBefore.mockClear()
		setFocusedChat(read.uuid)
		await refetchChatsAndMessages()
		expect(listMessagesBefore.mock.calls.map(([chat]) => chat.uuid)).toEqual([read.uuid])

		listMessagesBefore.mockClear()
		setFocusedChat(null)
		await refetchChatsAndMessages()
		expect(listMessagesBefore).not.toHaveBeenCalled()
	})
})
