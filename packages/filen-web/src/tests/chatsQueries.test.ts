import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, ChatParticipant, UuidStr } from "@filen/sdk-rs"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a
// short label the same way notesQueries.test.ts's testUuid does.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching notesQueries.test.ts: the real sdk client module imports a Vite
// `?worker`, unresolvable under node vitest.
const { listChats, listMessagesBefore, getAllChatsUnreadCount } = vi.hoisted(() => ({
	listChats: vi.fn<() => Promise<Chat[]>>(),
	listMessagesBefore: vi.fn<(chat: Chat, before: bigint) => Promise<ChatMessage[]>>(),
	getAllChatsUnreadCount: vi.fn<() => Promise<bigint>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { listChats, listMessagesBefore, getAllChatsUnreadCount }
}))

// Same rationale as notesQueries.test.ts's useQuery intercept: only the `enabled`/`queryFn` wiring
// this module owns is directly assertable, real internals never exercised.
const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }))

vi.mock("@tanstack/react-query", async importOriginal => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>()
	return { ...actual, useQuery }
})

// A bare, unconfigured QueryClient stands in for the real singleton — the patchers only need
// genuine setQueryData/getQueryData/cancelQueries cache mechanics, never the production client's
// OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import {
	CHATS_QUERY_KEY,
	chatsQueryGet,
	chatsQueryRemove,
	chatsQueryReplaceAll,
	chatsQueryUpdate,
	chatsQueryUpsert,
	fetchChats,
	useChats
} from "@/features/chats/queries/chats"
import {
	chatMessagesQueryGet,
	chatMessagesQueryKey,
	chatMessagesQueryRemove,
	chatMessagesQueryUpdate,
	chatMessagesQueryUpsert,
	fetchChatMessages,
	loadOlderChatMessages,
	useChatMessages
} from "@/features/chats/queries/chatMessages"
import {
	CHATS_UNREAD_QUERY_KEY,
	chatsUnreadQueryGet,
	chatsUnreadQuerySet,
	fetchChatsUnread,
	useChatsUnread
} from "@/features/chats/queries/chatsUnread"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

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

describe("fetchChats", () => {
	it("passes through sdkApi.listChats unchanged", async () => {
		const chats = [mockChat()]
		listChats.mockResolvedValueOnce(chats)

		await expect(fetchChats()).resolves.toBe(chats)
		expect(listChats).toHaveBeenCalledExactlyOnceWith()
	})

	it("propagates a rejection from sdkApi.listChats unchanged", async () => {
		const error = new Error("no authenticated client")
		listChats.mockRejectedValueOnce(error)

		await expect(fetchChats()).rejects.toBe(error)
	})
})

describe("useChats", () => {
	it("queries under the [chats, list] key", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useChats()

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ queryKey: CHATS_QUERY_KEY }))
	})
})

describe("chatsQueryUpdate / chatsQueryGet", () => {
	it("defaults an uncached list to [] before applying the updater", () => {
		const chat = mockChat()

		chatsQueryUpdate(prev => [...prev, chat])

		expect(chatsQueryGet()).toEqual([chat])
	})

	it("passes the previously cached array through to the updater unchanged", () => {
		const first = mockChat({ uuid: testUuid("a") })
		const second = mockChat({ uuid: testUuid("b") })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [first])

		chatsQueryUpdate(prev => [...prev, second])

		expect(chatsQueryGet()).toEqual([first, second])
	})

	it("cancels an in-flight fetch only when the query already holds cached data", () => {
		const cancelSpy = vi.spyOn(testQueryClient, "cancelQueries")

		// No cached data yet — the initial-fetch carve-out must NOT cancel.
		chatsQueryUpdate(prev => prev)
		expect(cancelSpy).not.toHaveBeenCalled()

		testQueryClient.setQueryData(CHATS_QUERY_KEY, [mockChat()])
		cancelSpy.mockClear()

		// Cached data exists now — a patch must abort any in-flight refetch first.
		chatsQueryUpdate(prev => prev)
		expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: CHATS_QUERY_KEY })
	})
})

describe("chatsQueryUpsert", () => {
	it("appends a chat not already present", () => {
		const chat = mockChat()

		chatsQueryUpsert(chat)

		expect(chatsQueryGet()).toEqual([chat])
	})

	it("replaces an existing chat in place, preserving position", () => {
		const first = mockChat({ uuid: testUuid("a") })
		const second = mockChat({ uuid: testUuid("b") })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [first, second])

		const updatedFirst = { ...first, muted: true }
		chatsQueryUpsert(updatedFirst)

		expect(chatsQueryGet()).toEqual([updatedFirst, second])
	})
})

describe("chatsQueryRemove", () => {
	it("removes a chat by uuid, leaving the rest untouched", () => {
		const first = mockChat({ uuid: testUuid("a") })
		const second = mockChat({ uuid: testUuid("b") })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [first, second])

		chatsQueryRemove(testUuid("a"))

		expect(chatsQueryGet()).toEqual([second])
	})
})

describe("chatsQueryReplaceAll", () => {
	it("replaces the whole cached list", () => {
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [mockChat({ uuid: testUuid("a") })])
		const next = [mockChat({ uuid: testUuid("b") }), mockChat({ uuid: testUuid("c") })]

		chatsQueryReplaceAll(next)

		expect(chatsQueryGet()).toEqual(next)
	})
})

describe("chatMessagesQueryKey", () => {
	it("builds the [chats, messages, {chatUuid}] tuple with the cursor kept OUT of the key", () => {
		expect(chatMessagesQueryKey("abc")).toEqual(["chats", "messages", { chatUuid: "abc" }])
	})
})

describe("fetchChatMessages", () => {
	it("resolves the chat from the chats list cache and fetches the initial page via listMessagesBefore", async () => {
		const chat = mockChat({ uuid: testUuid("a") })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		const messages = [mockMessage({ sentTimestamp: 1n }), mockMessage({ uuid: testUuid("m2"), sentTimestamp: 2n })]
		listMessagesBefore.mockResolvedValueOnce(messages)

		const result = await fetchChatMessages(chat.uuid)

		expect(result).toEqual([messages[0], messages[1]])
		expect(listMessagesBefore).toHaveBeenCalledExactlyOnceWith(chat, expect.any(BigInt))
	})

	it("sorts the fetched page ascending by sentTimestamp regardless of return order", async () => {
		const chat = mockChat({ uuid: testUuid("a") })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		const older = mockMessage({ uuid: testUuid("older"), sentTimestamp: 1n })
		const newer = mockMessage({ uuid: testUuid("newer"), sentTimestamp: 2n })
		listMessagesBefore.mockResolvedValueOnce([newer, older])

		const result = await fetchChatMessages(chat.uuid)

		expect(result.map(m => m.uuid)).toEqual([older.uuid, newer.uuid])
	})

	it("returns the already-cached messages (never []) when the chat is not in the chats list cache", async () => {
		const cached = [mockMessage()]
		testQueryClient.setQueryData(chatMessagesQueryKey("missing"), cached)

		const result = await fetchChatMessages("missing")

		expect(result).toBe(cached)
		expect(listMessagesBefore).not.toHaveBeenCalled()
	})

	it("returns [] for an uncached miss on a chat not in the list", async () => {
		await expect(fetchChatMessages("missing")).resolves.toEqual([])
	})
})

describe("useChatMessages", () => {
	it("disables the query for an empty chatUuid", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useChatMessages("")

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})

	it("enables the query once a chatUuid is given", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useChatMessages("abc")

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true, queryKey: chatMessagesQueryKey("abc") }))
	})
})

describe("chatMessagesQueryUpdate / chatMessagesQueryGet", () => {
	it("scopes the cache per chat uuid", () => {
		const messageA = mockMessage({ uuid: testUuid("a") })
		const messageB = mockMessage({ uuid: testUuid("b") })

		chatMessagesQueryUpdate("chat-a", prev => [...prev, messageA])
		chatMessagesQueryUpdate("chat-b", prev => [...prev, messageB])

		expect(chatMessagesQueryGet("chat-a")).toEqual([messageA])
		expect(chatMessagesQueryGet("chat-b")).toEqual([messageB])
	})

	it("cancels an in-flight fetch only when that chat's cache already holds data", () => {
		const cancelSpy = vi.spyOn(testQueryClient, "cancelQueries")

		chatMessagesQueryUpdate("chat-a", prev => prev)
		expect(cancelSpy).not.toHaveBeenCalled()

		testQueryClient.setQueryData(chatMessagesQueryKey("chat-a"), [mockMessage()])
		cancelSpy.mockClear()

		chatMessagesQueryUpdate("chat-a", prev => prev)
		expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: chatMessagesQueryKey("chat-a") })
	})
})

describe("chatMessagesQueryUpsert", () => {
	it("inserts a new message in ascending sentTimestamp order", () => {
		const older = mockMessage({ uuid: testUuid("older"), sentTimestamp: 1n })
		const newer = mockMessage({ uuid: testUuid("newer"), sentTimestamp: 2n })
		testQueryClient.setQueryData(chatMessagesQueryKey("chat-a"), [older])

		chatMessagesQueryUpsert("chat-a", newer)

		expect(chatMessagesQueryGet("chat-a")?.map(m => m.uuid)).toEqual([older.uuid, newer.uuid])
	})

	it("replaces an existing message in place by uuid (e.g. a later edit)", () => {
		const message = mockMessage({ uuid: testUuid("a"), message: "original" })
		testQueryClient.setQueryData(chatMessagesQueryKey("chat-a"), [message])

		const edited = { ...message, message: "edited" }
		chatMessagesQueryUpsert("chat-a", edited)

		expect(chatMessagesQueryGet("chat-a")).toEqual([edited])
	})
})

describe("chatMessagesQueryRemove", () => {
	it("removes a message by uuid, leaving the rest untouched", () => {
		const first = mockMessage({ uuid: testUuid("a") })
		const second = mockMessage({ uuid: testUuid("b") })
		testQueryClient.setQueryData(chatMessagesQueryKey("chat-a"), [first, second])

		chatMessagesQueryRemove("chat-a", testUuid("a"))

		expect(chatMessagesQueryGet("chat-a")).toEqual([second])
	})
})

describe("loadOlderChatMessages — prepend + uuid-dedupe", () => {
	it("prepends an older page ahead of the existing (newer) cached messages", async () => {
		const chat = mockChat({ uuid: testUuid("a") })
		const existing = mockMessage({ uuid: testUuid("existing"), sentTimestamp: 10n })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [existing])

		const older = mockMessage({ uuid: testUuid("older"), sentTimestamp: 5n })
		listMessagesBefore.mockResolvedValueOnce([older])

		const page = await loadOlderChatMessages(chat, 10n)

		expect(page).toEqual([older])
		expect(chatMessagesQueryGet(chat.uuid)?.map(m => m.uuid)).toEqual([older.uuid, existing.uuid])
		expect(listMessagesBefore).toHaveBeenCalledExactlyOnceWith(chat, 10n)
	})

	it("drops any page entry that already exists in the cache instead of duplicating it", async () => {
		const chat = mockChat({ uuid: testUuid("a") })
		const existing = mockMessage({ uuid: testUuid("shared"), sentTimestamp: 5n })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), [existing])

		// The server-returned "older" page overlaps the cache boundary and re-includes `existing`
		// (e.g. a socket-delivered message landed there between the two requests).
		const brandNewOlder = mockMessage({ uuid: testUuid("older"), sentTimestamp: 1n })
		listMessagesBefore.mockResolvedValueOnce([brandNewOlder, existing])

		await loadOlderChatMessages(chat, 5n)

		const cached = chatMessagesQueryGet(chat.uuid)
		expect(cached?.map(m => m.uuid)).toEqual([brandNewOlder.uuid, existing.uuid])
		expect(cached).toHaveLength(2)
	})

	it("never mutates the pre-existing cache array in place", async () => {
		const chat = mockChat({ uuid: testUuid("a") })
		const existing = mockMessage({ uuid: testUuid("existing"), sentTimestamp: 10n })
		const existingArray = [existing]
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), existingArray)

		listMessagesBefore.mockResolvedValueOnce([mockMessage({ uuid: testUuid("older"), sentTimestamp: 1n })])

		await loadOlderChatMessages(chat, 10n)

		expect(existingArray).toEqual([existing])
	})
})

describe("fetchChatsUnread", () => {
	it("passes through sdkApi.getAllChatsUnreadCount unchanged", async () => {
		getAllChatsUnreadCount.mockResolvedValueOnce(3n)

		await expect(fetchChatsUnread()).resolves.toBe(3n)
	})
})

describe("useChatsUnread", () => {
	it("queries under the [chats, unread] key", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useChatsUnread()

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ queryKey: CHATS_UNREAD_QUERY_KEY }))
	})
})

describe("chatsUnreadQuerySet / chatsUnreadQueryGet", () => {
	it("round-trips a bigint count through the cache", () => {
		chatsUnreadQuerySet(7n)

		expect(chatsUnreadQueryGet()).toBe(7n)
	})
})
