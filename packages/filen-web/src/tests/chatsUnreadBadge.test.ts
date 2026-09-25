// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, Fragment, useLayoutEffect, type ReactNode } from "react"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { listChats, listMessagesBefore, leaveChatOp, purgeChatInflightState } = vi.hoisted(() => ({
	listChats: vi.fn<() => Promise<Chat[]>>(),
	listMessagesBefore: vi.fn<(chat: Chat, before: bigint) => Promise<ChatMessage[]>>(),
	leaveChatOp: vi.fn<(chat: Chat) => Promise<void>>(),
	purgeChatInflightState: vi.fn<(chatUuid: string) => Promise<void>>(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listChats, listMessagesBefore, leaveChat: leaveChatOp } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/features/chats/lib/inflight", () => ({ purgeChatInflightState }))

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { CHATS_QUERY_KEY, chatsQueryGet, useChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet, chatMessagesQueryKey, useChatMessages } from "@/features/chats/queries/chatMessages"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import { useChatUnreadCount } from "@/features/chats/hooks/useChatUnreadCount"
import { detachUnreadBadges } from "@/features/chats/lib/messagesVersion"
import { handleAuthSuccess, handleChatEvent, handleReconnecting, resetSocketReconnectState } from "@/features/chats/lib/socketHandlers"
import { setFocusedChat } from "@/features/chats/lib/focusedChat"
import { leaveChat } from "@/features/chats/lib/actions"
import { refetchChatsAndMessages } from "@/features/chats/lib/refetchChatsAndMessages"
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

// Stands in for the rail's own reads (its account and contact requests).
const railRead = vi.fn(() => Promise.resolve(true))

// The rail's shape: the badge beside those reads.
function RailProbe() {
	const count = useChatsUnreadCount(USER_ID)

	useQuery({ queryKey: ["rail"], queryFn: railRead })

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
	leaveChatOp.mockReset()
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

	// Removing a message cache alone re-renders nothing: leaving drops the chat from the list first, and that
	// list write re-renders the rail.
	it("drops a chat left", async () => {
		const a1 = peerMessage("a1", "a", 150n)
		const b1 = peerMessage("b1", "b", 150n)
		listChats.mockResolvedValue([mockChat("a", a1), mockChat("b", b1)])
		listMessagesBefore.mockImplementation(chat => Promise.resolve(chat.uuid === testUuid("a") ? [a1] : [b1]))
		leaveChatOp.mockResolvedValue(undefined)

		const { unmount } = render(createElement(RailBadgeProbe), { wrapper })
		await drain()

		expect(committed.at(-1)).toBe(2)

		committed.length = 0

		expect(await leaveChat(mockChat("a", a1))).toEqual({ status: "success" })

		// waitFor lifts act, so each cache notification renders when it lands, as in a browser.
		await waitFor(() => {
			expect(committed.at(-1)).toBe(1)
		})
		await drain()

		expect(committed).toEqual([1])

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

// Sign-out up to its wipe, in performLogout's order: detach the rail badge, stop the reads in flight, then
// empty the in-memory cache.
async function wipeCache(): Promise<void> {
	await act(async () => {
		detachUnreadBadges()
		await queryClient.cancelQueries()
		queryClient.clear()
	})
}

// Between sign-out's wipe and its reload, a rail render reads the rail's queries back into the emptied
// cache, against a client that is being logged out.
describe("signing out", () => {
	const a1 = peerMessage("a1", "a", 150n)

	// The rail with one chat and its unread message resident.
	async function renderRail(): Promise<() => void> {
		listChats.mockResolvedValue([mockChat("a", a1)])
		listMessagesBefore.mockResolvedValue([a1])

		const { unmount } = render(createElement(RailProbe), { wrapper })
		await drain()

		expect(committed.at(-1)).toBe(1)

		committed.length = 0

		return unmount
	}

	function expectRailUntouched(): void {
		expect(committed).toEqual([])
		expect(railRead).toHaveBeenCalledTimes(1)
	}

	it("renders nothing once the cache is wiped", async () => {
		const unmount = await renderRail()

		await wipeCache()
		await settle()

		expectRailUntouched()
		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(1)
		expect(queryClient.getQueryCache().getAll()).toEqual([])

		unmount()
	})

	it("renders nothing for a message read that lands after the wipe", async () => {
		listChats.mockResolvedValue([mockChat("a", a1)])
		const answer = holdMessageReads()

		const { unmount } = render(createElement(RailProbe), { wrapper })
		await settle()

		committed.length = 0
		await wipeCache()
		answer("a", [a1])
		await settle()

		expectRailUntouched()
		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(1)

		unmount()
	})

	// Each patch below lands after the wipe and recreates the list it removed.
	it("renders nothing for a message delivered just before the wipe", async () => {
		const unmount = await renderRail()
		const a2 = peerMessage("a2", "a", 200n)

		handleChatEvent({ inner: { type: "messageNew", msg: a2 }, chatMessageId: 1n })
		await wipeCache()
		await settle()

		expect(chatsQueryGet()).toEqual([])
		expect(chatMessagesQueryGet(testUuid("a"))).toEqual([a2])
		expectRailUntouched()

		unmount()
	})

	// Sign-out neither waits out nor cancels the send's reconcile window, which holds back an own message's echo.
	it("renders nothing for an own message's echo landing after the wipe", async () => {
		const unmount = await renderRail()
		const own = { ...peerMessage("own", "a", 200n), senderId: Number(USER_ID) }

		// The handler tells an own message by the cached account.
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: USER_ID })
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		handleChatEvent({ inner: { type: "messageNew", msg: own }, chatMessageId: 1n })
		await wipeCache()
		// Past the window, and the flush it schedules.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_100)
		})
		vi.useRealTimers()
		await settle()

		expect(chatMessagesQueryGet(testUuid("a"))).toEqual([own])
		expectRailUntouched()

		unmount()
	})

	it("renders nothing for a chat deleted just before the wipe", async () => {
		const unmount = await renderRail()
		const purged = deferred<undefined>()

		// The removal waits on the chat's queued sends and draft being purged first.
		purgeChatInflightState.mockReturnValueOnce(purged.promise)
		handleChatEvent({ inner: { type: "conversationDeleted", uuid: testUuid("a") }, chatMessageId: 1n })
		await wipeCache()
		purged.resolve(undefined)
		await settle()

		expect(chatsQueryGet()).toEqual([])
		expect(chatMessagesQueryGet(testUuid("a"))).toEqual([])
		expectRailUntouched()

		unmount()
	})

	// Events the worker sent before it dropped the socket are still dispatched, and can leave chats in the list.
	it("renders nothing for a chat and its message arriving after the wipe", async () => {
		const unmount = await renderRail()

		await wipeCache()
		handleChatEvent({ inner: { type: "conversationsNew", chat: mockChat("d") }, chatMessageId: 1n })
		handleChatEvent({ inner: { type: "messageNew", msg: peerMessage("d1", "d", 400n) }, chatMessageId: 2n })
		await settle()

		expect(chatsQueryGet()).toHaveLength(1)
		expect(chatMessagesQueryGet(testUuid("d"))).toHaveLength(1)
		expectRailUntouched()

		unmount()
	})
})

// query-core's gc removes a message cache nothing observes; browser timers wrap GC_TIME to about 21 days.
describe("a message cache the gc collects", () => {
	const a1 = peerMessage("a1", "a", 150n)
	const a2 = peerMessage("a2", "a", 200n)

	function collectMessages(chatLabel: string): void {
		const query = queryClient.getQueryCache().find({ queryKey: chatMessagesQueryKey(testUuid(chatLabel)), exact: true })

		if (query === undefined) {
			throw new Error(`no message cache for ${chatLabel}`)
		}

		act(() => {
			queryClient.getQueryCache().remove(query)
		})
	}

	it("is read again for the rail badge", async () => {
		listChats.mockResolvedValue([mockChat("a", a2)])
		listMessagesBefore.mockResolvedValue([a1, a2])

		const { result, unmount } = renderBadge()
		await drain()

		expect(result.current).toBe(2)

		collectMessages("a")
		await drain()

		expect(listMessagesBefore).toHaveBeenCalledTimes(2)
		expect(chatMessagesQueryGet(testUuid("a"))).toEqual([a1, a2])

		handleChatEvent({ inner: { type: "messageNew", msg: peerMessage("a3", "a", 250n) }, chatMessageId: 1n })
		await waitFor(() => {
			expect(result.current).toBe(3)
		})

		unmount()
	})

	// The rail's heal hasn't refilled it yet: the patch recreates the cache with only what it brings.
	it("is read again when its thread opens after a patch recreated it", async () => {
		listChats.mockResolvedValue([mockChat("a", a1)])
		listMessagesBefore.mockResolvedValue([a1])
		await act(() => refetchChatsAndMessages())

		collectMessages("a")
		handleChatEvent({ inner: { type: "messageNew", msg: a2 }, chatMessageId: 1n })
		await waitFor(() => {
			expect(chatMessagesQueryGet(testUuid("a"))).toEqual([a2])
		})

		listMessagesBefore.mockResolvedValue([a1, a2])

		const { result, unmount } = renderHook(() => useChatMessages(testUuid("a")), { wrapper })
		await drain()

		expect(listMessagesBefore).toHaveBeenCalledTimes(2)
		expect(result.current.data).toEqual([a1, a2])

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
