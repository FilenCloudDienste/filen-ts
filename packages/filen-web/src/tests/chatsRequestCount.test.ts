// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query"
import type { Chat, ChatMessage, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { listChats, listMessagesBefore, sendChatMessage } = vi.hoisted(() => ({
	listChats: vi.fn<() => Promise<Chat[]>>(),
	listMessagesBefore: vi.fn<(chat: Chat, before: bigint) => Promise<ChatMessage[]>>(),
	// Never settles: the restored outbox's push stays in flight, so only the restore's list read is counted.
	sendChatMessage: vi.fn(() => new Promise<never>(() => undefined))
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listChats, listMessagesBefore, sendChatMessage } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

vi.mock("@/features/chats/lib/inflight", () => ({ purgeChatInflightState: () => Promise.resolve() }))

import { queryClient } from "@/queries/client"
import { CHATS_LIST_REREAD_MS, chatsQueryGet, chatsQueryUpsert, useChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet, chatMessagesQueryUpdate, useChatMessages } from "@/features/chats/queries/chatMessages"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import { handleAuthSuccess, handleChatEvent, handleReconnecting, resetSocketReconnectState } from "@/features/chats/lib/socketHandlers"
import { Sync } from "@/features/chats/lib/sync"
import { buildOptimisticMessage } from "@/features/chats/lib/sync.logic"
import useChatsInflightStore from "@/features/chats/store/useChatsInflight"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"

const USER_ID = 7n

function mockChat(label: string): Chat {
	return { uuid: testUuid(label), ownerId: 1n, participants: [], muted: false, created: 0n, lastFocus: 0n }
}

function mockMessage(chat: Chat): ChatMessage {
	return {
		uuid: testUuid(`m${chat.uuid.slice(0, 4)}`),
		chat: chat.uuid,
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

const CHATS = [mockChat("a"), mockChat("b"), mockChat("c")]
const [CHAT_A] = CHATS as [Chat, Chat, Chat]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
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

// Lets every queued bulk pass (they serialize on a mutex) and query fetch run to completion.
async function drain(): Promise<void> {
	await settle()
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

// The authed shell at boot on /chats: the rail's unread hook (mount-once pass + self-heal) next to the
// sidebar's own list read.
function renderShellOnChats() {
	return renderHook(
		() => {
			useChatsUnreadCount(USER_ID)
			useChats()
		},
		{ wrapper }
	)
}

// The bridge moves the socket session before its handlers see the event.
function dropSocket(): void {
	socketDropped()
	handleReconnecting()
}

function recoverSocket(): void {
	socketAuthenticated()
	handleAuthSuccess()
}

function threadMessage(label: string, sentTimestamp: bigint): ChatMessage {
	return { ...mockMessage(CHAT_A), uuid: testUuid(label), sentTimestamp }
}

// An open thread whose cached page is missing m2 (read before the socket was up to deliver it) mounts
// and reads, and a socket delivery of m3 lands mid-read: the patch cancels the read, so the gap stays.
async function cancelThreadReadWithPatch() {
	const [m1, m2, m3] = [threadMessage("m1", 10n), threadMessage("m2", 20n), threadMessage("m3", 30n)]
	const page = deferred<ChatMessage[]>()
	queryClient.setQueryData(["chats", "list"], CHATS)
	chatMessagesQueryUpdate(CHAT_A.uuid, () => [m1])
	listMessagesBefore.mockImplementationOnce(() => page.promise)

	const thread = renderHook(() => useChatMessages(CHAT_A.uuid), { wrapper })

	await act(async () => {
		await Promise.resolve()
	})
	// The read after the patch sees the server with m3 in it.
	listMessagesBefore.mockImplementation(() => Promise.resolve([m1, m2, m3]))
	act(() => {
		chatMessagesQueryUpdate(CHAT_A.uuid, prev => [...prev, m3])
	})
	page.resolve([m1, m2])
	await drain()

	return { thread, complete: [m1, m2, m3] }
}

beforeEach(() => {
	queryClient.clear()
	kvStore.clear()
	resetSocketReconnectState()
	socketAuthenticated()
	useChatsInflightStore.setState({ inflightMessages: {}, inflightErrors: {} })
	listChats.mockReset()
	listMessagesBefore.mockReset()
	listChats.mockImplementation(() => Promise.resolve(CHATS))
	listMessagesBefore.mockImplementation(chat => Promise.resolve([mockMessage(chat)]))
})

afterEach(() => {
	focusManager.setFocused(undefined)
	vi.useRealTimers()
})

describe("chat list and message request counts", () => {
	it("boot on /chats reads the list once and each chat's messages once", async () => {
		const list = deferred<Chat[]>()
		listChats.mockImplementationOnce(() => list.promise)

		const { unmount } = renderShellOnChats()

		await act(async () => {
			await Promise.resolve()
		})
		expect(listChats).toHaveBeenCalledTimes(1)

		list.resolve(CHATS)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(CHATS.length)

		unmount()
	})

	// A reload restores the list from disk but not the bulk-written message caches, so the self-heal
	// fires at mount next to the mount-once pass and queues behind it.
	it("a reload with a restored list reads it once and each chat's messages once", async () => {
		queryClient.setQueryData(["chats", "list"], CHATS)

		const { unmount } = renderShellOnChats()
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(CHATS.length)

		unmount()
	})

	it("remounting the list and an open thread reuses the cache", async () => {
		const shell = renderShellOnChats()
		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		const mountThread = () =>
			renderHook(
				() => {
					useChats()
					useChatMessages(CHAT_A.uuid)
				},
				{ wrapper }
			)

		mountThread().unmount()
		const thread = mountThread()
		await drain()

		expect(listChats).not.toHaveBeenCalled()
		expect(listMessagesBefore).not.toHaveBeenCalled()

		thread.unmount()
		shell.unmount()
	})

	it("reads taken before the socket first authenticates don't count: a remount reads again", async () => {
		socketDropped()

		const shell = renderShellOnChats()
		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		socketAuthenticated()
		handleAuthSuccess()

		const thread = renderHook(
			() => {
				useChats()
				useChatMessages(CHAT_A.uuid)
			},
			{ wrapper }
		)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(1)

		thread.unmount()

		renderHook(
			() => {
				useChats()
				useChatMessages(CHAT_A.uuid)
			},
			{ wrapper }
		)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(1)

		shell.unmount()
	})

	it("a read a drop interrupts doesn't count: a remount reads again", async () => {
		const list = deferred<Chat[]>()
		const page = deferred<ChatMessage[]>()
		listChats.mockImplementationOnce(() => list.promise)
		listMessagesBefore.mockImplementationOnce(() => page.promise)
		queryClient.setQueryData(["chats", "list"], CHATS)

		const thread = renderHook(
			() => {
				useChats()
				useChatMessages(CHAT_A.uuid)
			},
			{ wrapper }
		)

		await act(async () => {
			await Promise.resolve()
		})
		dropSocket()
		list.resolve(CHATS)
		page.resolve([mockMessage(CHAT_A)])
		await drain()
		thread.unmount()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		renderHook(
			() => {
				useChats()
				useChatMessages(CHAT_A.uuid)
			},
			{ wrapper }
		)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(1)
	})

	it("a list read a patch cancels is read again at once, and shows what it was reading for", async () => {
		queryClient.setQueryData(["chats", "list"], CHATS)
		const first = deferred<Chat[]>()
		listChats.mockImplementationOnce(() => first.promise)

		const list = renderHook(() => useChats(), { wrapper })

		await act(async () => {
			await Promise.resolve()
		})
		changeElsewhere()
		act(() => {
			chatsQueryUpsert({ ...CHAT_A, name: "renamed" })
		})
		first.resolve(CHATS)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(2)
		expect(chatsQueryGet()?.[0]).toMatchObject({ lastFocus: 50n, muted: true })
		list.unmount()
	})

	it("a thread read a patch cancels is read again at once and fills the gap", async () => {
		const { thread, complete } = await cancelThreadReadWithPatch()

		expect(listMessagesBefore).toHaveBeenCalledTimes(2)
		expect(chatMessagesQueryGet(CHAT_A.uuid)?.map(m => m.uuid)).toEqual(complete.map(m => m.uuid))
		thread.unmount()
	})

	it("the thread read after a cancel counts: a remount and a return to the tab read nothing more", async () => {
		const { thread } = await cancelThreadReadWithPatch()

		thread.unmount()
		const remounted = renderHook(() => useChatMessages(CHAT_A.uuid), { wrapper })
		await drain()
		hide()
		await show()

		expect(listMessagesBefore).toHaveBeenCalledTimes(2)
		remounted.unmount()
	})

	it("a socket reconnect runs exactly one full pass, and a mount during the gap re-reads", async () => {
		const shell = renderShellOnChats()
		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		dropSocket()

		const thread = renderHook(() => useChatMessages(CHAT_A.uuid), { wrapper })
		await drain()

		expect(listMessagesBefore).toHaveBeenCalledTimes(1)
		listMessagesBefore.mockClear()

		recoverSocket()
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(CHATS.length)

		thread.unmount()
		shell.unmount()
	})

	it("a chat introduced by the socket heals only its own messages", async () => {
		const shell = renderShellOnChats()
		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		const introduced = mockChat("d")

		act(() => {
			handleChatEvent({ inner: { type: "conversationsNew", chat: introduced }, chatMessageId: 1n })
		})
		await drain()

		expect(listChats).not.toHaveBeenCalled()
		expect(listMessagesBefore).toHaveBeenCalledExactlyOnceWith(introduced, expect.any(BigInt))

		shell.unmount()
	})

	it("a thread whose cache only holds socket patches loads its page on mount", async () => {
		queryClient.setQueryData(["chats", "list"], CHATS)
		chatMessagesQueryUpdate(CHAT_A.uuid, () => [mockMessage(CHAT_A)])

		const thread = renderHook(() => useChatMessages(CHAT_A.uuid), { wrapper })
		await drain()

		expect(listMessagesBefore).toHaveBeenCalledTimes(1)

		thread.unmount()
	})

	it("a patch that cancels the resync's list read makes it read again instead of keeping the patched cache", async () => {
		const shell = renderShellOnChats()
		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		const introduced = mockChat("d")
		const first = deferred<Chat[]>()
		listChats.mockImplementationOnce(() => first.promise)
		listChats.mockImplementationOnce(() => Promise.resolve([...CHATS, introduced]))

		dropSocket()
		recoverSocket()

		await act(async () => {
			await Promise.resolve()
		})
		expect(listChats).toHaveBeenCalledTimes(1)

		act(() => {
			chatsQueryUpsert({ ...CHAT_A, muted: true })
		})
		first.resolve(CHATS)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(2)
		expect(chatsQueryGet()?.map(c => c.uuid)).toEqual([...CHATS, introduced].map(c => c.uuid))
		expect(listMessagesBefore).toHaveBeenCalledTimes(CHATS.length + 1)

		shell.unmount()
	})

	it("the outbox restore joins the boot list read instead of issuing its own", async () => {
		kvStore.set("inflightChatMessages", {
			[CHAT_A.uuid]: {
				chat: CHAT_A,
				messages: [
					buildOptimisticMessage({
						chatUuid: CHAT_A.uuid,
						inflightId: testUuid("inflight"),
						content: "hi",
						replyTo: undefined,
						sentTimestamp: 1n,
						sender: { id: USER_ID, email: "me@filen.io", avatarUrl: undefined, nickName: "Me" }
					})
				]
			}
		})

		const list = deferred<Chat[]>()
		listChats.mockImplementationOnce(() => list.promise)

		const shell = renderShellOnChats()
		const outbox = new Sync()
		outbox.start()

		await settle()
		list.resolve(CHATS)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(sendChatMessage).toHaveBeenCalledTimes(1)

		outbox.cancel()
		shell.unmount()
	})
})

// The chats route with a thread open: the list's own read next to the thread's.
async function mountOpenThread() {
	const view = renderHook(
		() => {
			useChatsUnreadCount(USER_ID)
			useChats()
			useChatMessages(CHAT_A.uuid)
		},
		{ wrapper }
	)

	await drain()
	listChats.mockClear()
	listMessagesBefore.mockClear()

	return view
}

function hide(): void {
	act(() => {
		focusManager.setFocused(false)
	})
}

async function show(): Promise<void> {
	act(() => {
		focusManager.setFocused(true)
	})
	await drain()
}

// Read state and mute changed on another device, which no socket event reports.
function changeElsewhere(): void {
	listChats.mockImplementation(() => Promise.resolve([{ ...CHAT_A, lastFocus: 50n, muted: true }, ...CHATS.slice(1)]))
}

async function elapse(ms: number): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, ms))
	})
	await drain()
}

describe("chat list and thread requests on returning to the tab", () => {
	it("a return soon after the last list read reads nothing", async () => {
		const view = await mountOpenThread()

		hide()
		await show()

		expect(listChats).not.toHaveBeenCalled()
		expect(listMessagesBefore).not.toHaveBeenCalled()

		view.unmount()
	})

	it("a return once the list read is old re-reads the list only, and shows another device's read state and mute", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })

		const view = await mountOpenThread()

		hide()
		changeElsewhere()
		vi.setSystemTime(Date.now() + CHATS_LIST_REREAD_MS)
		await show()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).not.toHaveBeenCalled()
		expect(chatsQueryGet()?.[0]).toMatchObject({ lastFocus: 50n, muted: true })

		view.unmount()
	})

	it("a return inside the window re-reads the list once when the window ends, bounding a change made elsewhere", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })

		const view = await mountOpenThread()

		hide()
		changeElsewhere()
		vi.setSystemTime(Date.now() + CHATS_LIST_REREAD_MS - 50)
		await show()

		expect(listChats).not.toHaveBeenCalled()

		hide()
		await show()
		await elapse(150)

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).not.toHaveBeenCalled()
		expect(chatsQueryGet()?.[0]).toMatchObject({ lastFocus: 50n, muted: true })

		view.unmount()
	})

	it("hiding the tab again drops the deferred read; the next return makes it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })

		const view = await mountOpenThread()
		const readAt = Date.now()

		hide()
		vi.setSystemTime(readAt + CHATS_LIST_REREAD_MS - 50)
		await show()
		hide()
		await elapse(150)

		expect(listChats).not.toHaveBeenCalled()

		vi.setSystemTime(readAt + CHATS_LIST_REREAD_MS)
		await show()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).not.toHaveBeenCalled()

		view.unmount()
	})

	it("a socket patch cancelling the return's read makes it read again, so the change still shows", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })

		const view = await mountOpenThread()
		const first = deferred<Chat[]>()

		listChats.mockImplementationOnce(() => first.promise)
		hide()
		changeElsewhere()
		vi.setSystemTime(Date.now() + CHATS_LIST_REREAD_MS)
		act(() => {
			focusManager.setFocused(true)
		})
		await act(async () => {
			await Promise.resolve()
		})

		act(() => {
			chatsQueryUpsert({ ...CHAT_A, name: "renamed" })
		})
		first.resolve(CHATS)
		await drain()

		expect(listChats).toHaveBeenCalledTimes(2)
		expect(chatsQueryGet()?.[0]).toMatchObject({ lastFocus: 50n, muted: true })

		view.unmount()
	})

	it("off the chats route, where only the rail's badge reads the list, a return reads nothing", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })

		const view = renderHook(() => useChatsUnreadCount(USER_ID), { wrapper })

		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		hide()
		vi.setSystemTime(Date.now() + CHATS_LIST_REREAD_MS)
		await show()

		expect(listChats).not.toHaveBeenCalled()
		expect(listMessagesBefore).not.toHaveBeenCalled()

		view.unmount()
	})

	it("a return while the socket is down re-reads the list and the open thread", async () => {
		const view = await mountOpenThread()

		hide()
		dropSocket()
		await show()

		expect(listChats).toHaveBeenCalledTimes(1)
		expect(listMessagesBefore).toHaveBeenCalledTimes(1)

		view.unmount()
	})

	it("after a reconnect's full pass, a return reads nothing", async () => {
		const view = await mountOpenThread()

		dropSocket()
		recoverSocket()
		await drain()
		listChats.mockClear()
		listMessagesBefore.mockClear()

		hide()
		await show()

		expect(listChats).not.toHaveBeenCalled()
		expect(listMessagesBefore).not.toHaveBeenCalled()

		view.unmount()
	})
})
