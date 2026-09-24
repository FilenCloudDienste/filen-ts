// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, Fragment, useLayoutEffect, type ReactNode } from "react"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { listChats, listMessagesBefore } = vi.hoisted(() => ({
	listChats: vi.fn<() => Promise<Chat[]>>(),
	listMessagesBefore: vi.fn<(chat: Chat, before: bigint) => Promise<ChatMessage[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listChats, listMessagesBefore } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/features/chats/lib/inflight", () => ({ purgeChatInflightState: () => Promise.resolve() }))

import { queryClient } from "@/queries/client"
import { CHATS_QUERY_KEY, chatsQueryGet, useChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey, useChatMessages } from "@/features/chats/queries/chatMessages"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import { useChatUnreadCount } from "@/features/chats/hooks/useChatUnreadCount"
import { handleAuthSuccess, handleChatEvent, handleReconnecting, resetSocketReconnectState } from "@/features/chats/lib/socketHandlers"
import { setFocusedChat } from "@/features/chats/lib/focusedChat"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"

const USER_ID = 7n

// Read up to 100: only messages from the peer sent after that count.
function mockChat(label: string, lastMessage?: ChatMessage): Chat {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 100n,
		...(lastMessage !== undefined ? { lastMessage } : {})
	}
}

function peerMessage(label: string, chatLabel: string, sentTimestamp: bigint): ChatMessage {
	return {
		uuid: testUuid(label),
		chat: testUuid(chatLabel),
		senderId: 2,
		senderEmail: "p@x.io",
		senderNickName: "P",
		message: label,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

// Server pages held open per chat until the test answers them, so the resync's list write renders first,
// as it does over a real network.
function holdMessageReads(): (chatLabel: string, page: ChatMessage[]) => void {
	const held = new Map<string, (page: ChatMessage[]) => void>()

	listMessagesBefore.mockImplementation(chat => {
		const page = deferred<ChatMessage[]>()

		held.set(chat.uuid, page.resolve)

		return page.promise
	})

	return (chatLabel, page) => {
		const resolve = held.get(testUuid(chatLabel))

		if (resolve === undefined) {
			throw new Error(`no held read for ${chatLabel}`)
		}

		resolve(page)
	}
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

async function drain(): Promise<void> {
	await settle()
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

// The always-mounted rail badge.
function renderBadge() {
	return renderHook(() => useChatsUnreadCount(USER_ID), { wrapper })
}

// Every value the probes below commit, in order: what could reach the screen, render by render.
const committed: number[] = []

function RailBadgeProbe() {
	const count = useChatsUnreadCount(USER_ID)

	useLayoutEffect(() => {
		committed.push(count)
	})

	return null
}

function RowBadgeProbe({ chat }: { chat: Chat }) {
	const count = useChatUnreadCount(chat, USER_ID, EMPTY_BLOCKED_USERS)

	useLayoutEffect(() => {
		committed.push(count)
	})

	return null
}

// The sidebar's shape: the list hands each row its chat, and the row observes its own messages.
function SidebarProbe() {
	const chats = useChats({ enabled: false }).data ?? []

	return createElement(
		Fragment,
		null,
		chats.map(chat => createElement(RowBadgeProbe, { key: chat.uuid, chat }))
	)
}

// Commits how many messages the open thread shows.
function ThreadProbe({ chat }: { chat: Chat }) {
	const messageCount = useChatMessages(chat.uuid, { enabled: false }).data?.length ?? 0

	useLayoutEffect(() => {
		committed.push(messageCount)
	})

	return null
}

// The thread route's shape: it resolves the open chat from the list and hands it to the thread.
function ThreadRouteProbe({ uuid }: { uuid: string }) {
	const chat = useChats({ enabled: false }).data?.find(c => c.uuid === uuid)

	return chat === undefined ? null : createElement(ThreadProbe, { chat })
}

beforeEach(() => {
	queryClient.clear()
	resetSocketReconnectState()
	socketAuthenticated()
	setFocusedChat(null)
	listChats.mockReset()
	listMessagesBefore.mockReset()
	committed.length = 0
})

afterEach(() => {
	vi.useRealTimers()
})

describe("rail unread badge", () => {
	it("counts what a boot's resync brings in for a restored list whose message caches are missing or old", async () => {
		const aRead = peerMessage("a0", "a", 50n)
		const bRead = peerMessage("b0", "b", 50n)
		const aNew = [peerMessage("a1", "a", 150n), peerMessage("a2", "a", 200n)]
		const bNew = peerMessage("b1", "b", 300n)

		// A reload restores the list and an opened thread's page, never the bulk-written message caches.
		queryClient.setQueryData(CHATS_QUERY_KEY, [mockChat("a", aRead), mockChat("b", bRead)])
		queryClient.setQueryData(chatMessagesQueryKey(testUuid("b")), [bRead])
		listChats.mockResolvedValue([mockChat("a", aNew[1]), mockChat("b", bNew)])
		const answer = holdMessageReads()

		const { result, unmount } = renderBadge()
		await settle()

		expect(result.current).toBe(0)

		answer("a", [aRead, ...aNew])
		answer("b", [bRead, bNew])
		await drain()

		expect(result.current).toBe(3)

		unmount()
	})

	it("counts the messages a reconnect's resync brings in", async () => {
		const a1 = peerMessage("a1", "a", 150n)
		listChats.mockResolvedValue([mockChat("a", a1)])
		listMessagesBefore.mockResolvedValue([a1])

		const { result, unmount } = renderBadge()
		await drain()

		expect(result.current).toBe(1)

		const missed = [peerMessage("a2", "a", 200n), peerMessage("a3", "a", 250n)]
		listChats.mockResolvedValue([mockChat("a", missed[1])])
		const answer = holdMessageReads()

		socketDropped()
		handleReconnecting()
		socketAuthenticated()
		handleAuthSuccess()
		await settle()

		answer("a", [a1, ...missed])
		await drain()

		expect(result.current).toBe(3)

		unmount()
	})

	it("drops a message a socket delete removes", async () => {
		const a1 = peerMessage("a1", "a", 150n)
		const a2 = peerMessage("a2", "a", 200n)
		listChats.mockResolvedValue([mockChat("a", a2)])
		listMessagesBefore.mockResolvedValue([a1, a2])

		const { result, unmount } = renderBadge()
		await drain()

		expect(result.current).toBe(2)

		act(() => {
			handleChatEvent({ inner: { type: "messageDelete", uuid: a2.uuid }, chatMessageId: 1n })
		})
		await drain()

		expect(result.current).toBe(1)

		unmount()
	})

	it("still heals a chat introduced after the boot's resync filled the rest", async () => {
		const a1 = peerMessage("a1", "a", 150n)
		listChats.mockResolvedValue([mockChat("a", a1)])
		const answer = holdMessageReads()

		const { result, unmount } = renderBadge()
		await settle()
		answer("a", [a1])
		await drain()

		expect(result.current).toBe(1)

		const d1 = peerMessage("d1", "d", 400n)
		listMessagesBefore.mockResolvedValue([d1])

		act(() => {
			handleChatEvent({ inner: { type: "conversationsNew", chat: mockChat("d", d1) }, chatMessageId: 1n })
		})
		await drain()

		expect(listMessagesBefore).toHaveBeenLastCalledWith(mockChat("d", d1), expect.any(BigInt))
		expect(result.current).toBe(2)

		unmount()
	})
})

// The delivery puts the message in the thread and advances the chat's lastFocus past it. A render that
// sees the message without the advance counts it, and the chat's older unread, for as long as it is up.
describe("a message from someone else in the open chat", () => {
	const a1 = peerMessage("a1", "a", 150n)
	const a2 = peerMessage("a2", "a", 200n)

	function deliverToOpenChat(): void {
		setFocusedChat(testUuid("a"))
		handleChatEvent({ inner: { type: "messageNew", msg: a2 }, chatMessageId: 1n })
	}

	// waitFor lifts act while it waits, so each cache notification renders when it lands, as in a browser.
	async function awaitDelivery(): Promise<void> {
		await waitFor(() => {
			expect(chatsQueryGet()?.[0]?.lastFocus).toBe(200n)
			expect(committed.at(-1)).toBe(0)
		})
		await drain()
	}

	it("never reaches the rail badge", async () => {
		listChats.mockResolvedValue([mockChat("a", a1)])
		listMessagesBefore.mockResolvedValue([a1])

		const { unmount } = render(createElement(RailBadgeProbe), { wrapper })
		await drain()

		expect(committed.at(-1)).toBe(1)

		committed.length = 0
		deliverToOpenChat()
		await awaitDelivery()

		expect(committed).toEqual([0])

		unmount()
	})

	// The row renders on its own message observer, with the chat its sidebar last handed it.
	it("never reaches the chat's row badge", async () => {
		queryClient.setQueryData(CHATS_QUERY_KEY, [mockChat("a", a1)])
		queryClient.setQueryData(chatMessagesQueryKey(testUuid("a")), [a1])

		const { unmount } = render(createElement(SidebarProbe), { wrapper })

		expect(committed).toEqual([1])

		committed.length = 0
		deliverToOpenChat()
		await awaitDelivery()

		expect(committed).toEqual([0])

		unmount()
	})
})

describe("a chat deleted while it is open", () => {
	it("drops the thread without first rendering it emptied", async () => {
		queryClient.setQueryData(CHATS_QUERY_KEY, [mockChat("a")])
		queryClient.setQueryData(chatMessagesQueryKey(testUuid("a")), [peerMessage("a1", "a", 150n)])

		const { unmount } = render(createElement(ThreadRouteProbe, { uuid: testUuid("a") }), { wrapper })

		expect(committed).toEqual([1])

		committed.length = 0
		handleChatEvent({ inner: { type: "conversationDeleted", uuid: testUuid("a") }, chatMessageId: 1n })
		await waitFor(() => {
			expect(chatsQueryGet()).toEqual([])
		})
		await drain()

		expect(committed).toEqual([])

		unmount()
	})
})
