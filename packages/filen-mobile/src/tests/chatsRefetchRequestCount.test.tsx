// @vitest-environment happy-dom

// Request counts for the chats listing + per-chat message pages against a REAL QueryClient, with the
// SDK boundary (listChats / listMessagesBefore) spied: what a launch, a foreground (socket AuthSuccess)
// and a concurrently mounted list / open chat actually put on the wire.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const sdk = vi.hoisted(() => ({
	listChats: vi.fn(),
	listMessagesBefore: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("@/features/transfers/transfers", () => ({ default: { upload: vi.fn() } }))
vi.mock("@/features/transfers/quota", () => ({ uploadQuotaRefusal: vi.fn(async () => null) }))
vi.mock("@/features/drive/drive", () => ({ default: { enablePublicLink: vi.fn() } }))
vi.mock("@/lib/utils", () => ({}))
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn(),
	makeDriveItemPublicLink: vi.fn()
}))
vi.mock("@/features/chats/chatsInflight", () => ({ purgeChatInflightState: vi.fn() }))
vi.mock("@filen/sdk-rs", () => ({
	ChatTypingType: { Up: 0, Down: 1 },
	AnyNormalDir: { Dir: class {}, Root: class {} },
	DirMeta_Tags: { Decoded: "Decoded" }
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({ authedSdkClient: sdk })
	}
}))

// The real TanStack client with the app's refetch defaults, minus the SQLite persister.
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	const DEFAULT_QUERY_OPTIONS = {
		refetchOnMount: "always",
		refetchOnReconnect: "always",
		staleTime: 0,
		retry: false,
		networkMode: "offlineFirst"
	} as const

	const queryClient = new QueryClient({
		defaultOptions: {
			queries: DEFAULT_QUERY_OPTIONS
		}
	})

	return {
		default: queryClient,
		queryClient,
		DEFAULT_QUERY_OPTIONS,
		queryUpdater: {
			get: (queryKey: unknown[]) => queryClient.getQueryData(queryKey),
			set: (queryKey: unknown[], updater: unknown) =>
				queryClient.setQueryData(queryKey, (prev: unknown) =>
					typeof updater === "function" ? (updater as (p: unknown) => unknown)(prev) : updater
				)
		}
	}
})

import { renderHook, waitFor, cleanup } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import queryClient from "@/queries/client"
import chats from "@/features/chats/chats"
import useChatsQuery from "@/features/chats/queries/useChats.query"
import useChatMessagesQuery, { chatMessagesQueryUpdate, chatMessagesQueryGet } from "@/features/chats/queries/useChatMessages.query"
import type { Chat, ChatMessage } from "@/types"

function message(chatUuid: string, uuid: string, sentTimestamp: bigint, overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		chat: chatUuid,
		inner: { uuid, senderId: 2n, senderEmail: "peer@test", senderAvatar: undefined, senderNickName: undefined, message: `text ${uuid}` },
		replyTo: undefined,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp,
		undecryptable: false,
		...overrides
	} as ChatMessage
}

function chat(uuid: string, lastMessage: ChatMessage | undefined): Chat {
	return {
		uuid,
		lastMessage,
		ownerId: 1n,
		key: "key",
		name: undefined,
		participants: [],
		muted: false,
		created: 1n,
		lastFocus: 1n,
		undecryptable: false
	} as Chat
}

function seedMessages(chatUuid: string, messages: ChatMessage[]): void {
	chatMessagesQueryUpdate({
		params: { uuid: chatUuid },
		updater: messages.map(m => ({ ...m, inflightId: "" }))
	})
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children)
}

// 20 chats, each cache already ending at its lastMessage — the steady state after a short background.
const CHAT_COUNT = 20
const lasts = Array.from({ length: CHAT_COUNT }, (_, i) => message(`c${i}`, `m${i}`, BigInt(100 + i)))
const listing = lasts.map((last, i) => chat(`c${i}`, last))

beforeEach(() => {
	queryClient.clear()
	sdk.listChats.mockReset()
	sdk.listMessagesBefore.mockReset()
	sdk.listChats.mockResolvedValue(listing)
	sdk.listMessagesBefore.mockImplementation(async (c: Chat) => (c.lastMessage ? [c.lastMessage] : []))

	queryClient.setQueryData(["useChatsQuery"], listing)
	listing.forEach((c, i) => seedMessages(c.uuid, [message(c.uuid, `older${i}`, 1n), lasts[i] as ChatMessage]))
})

// No vitest globals, so testing-library's auto-cleanup never runs: unmount observers explicitly.
afterEach(() => {
	cleanup()
})

describe("chats.refetchChatsAndMessages request counts", () => {
	it("unchanged chats: 1 listChats, 0 listMessagesBefore (was 1 + 20)", async () => {
		await chats.refetchChatsAndMessages()

		expect(sdk.listChats).toHaveBeenCalledTimes(1)
		expect(sdk.listMessagesBefore).not.toHaveBeenCalled()
	})

	it("repeated foregrounds keep re-reading only the listing (read state has no socket event while away)", async () => {
		await chats.refetchChatsAndMessages()
		await chats.refetchChatsAndMessages()
		await chats.refetchChatsAndMessages()

		expect(sdk.listChats).toHaveBeenCalledTimes(3)
		expect(sdk.listMessagesBefore).not.toHaveBeenCalled()
	})

	it("one chat's lastMessage moved: exactly 1 listMessagesBefore, and its page is replaced", async () => {
		const newer = message("c3", "m3-new", 500n)

		sdk.listChats.mockResolvedValue(listing.map(c => (c.uuid === "c3" ? chat("c3", newer) : c)))

		await chats.refetchChatsAndMessages()

		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect((sdk.listMessagesBefore.mock.calls[0]?.[0] as Chat).uuid).toBe("c3")
		expect(chatMessagesQueryGet({ uuid: "c3" })?.map(m => m.inner.uuid)).toEqual(["m3-new"])
	})

	it("same lastMessage uuid with a later edit: exactly 1", async () => {
		const edited = { ...(lasts[5] as ChatMessage), edited: true, editedTimestamp: 900n }

		sdk.listChats.mockResolvedValue(listing.map(c => (c.uuid === "c5" ? chat("c5", edited) : c)))

		await chats.refetchChatsAndMessages()

		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
	})

	it("an empty chat whose cached page is []: 0", async () => {
		sdk.listChats.mockResolvedValue([...listing, chat("empty", undefined)])
		seedMessages("empty", [])

		await chats.refetchChatsAndMessages()

		expect(sdk.listMessagesBefore).not.toHaveBeenCalled()
	})

	it("a chat with no cached page: exactly 1", async () => {
		sdk.listChats.mockResolvedValue([...listing, chat("fresh", message("fresh", "f1", 1n))])

		await chats.refetchChatsAndMessages()

		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect(chatMessagesQueryGet({ uuid: "fresh" })?.map(m => m.inner.uuid)).toEqual(["f1"])
	})

	it("an open chat's in-flight read is shared, not duplicated", async () => {
		const newer = message("c0", "m0-new", 500n)
		const pending = deferred<ChatMessage[]>()

		sdk.listChats.mockResolvedValue(listing.map(c => (c.uuid === "c0" ? chat("c0", newer) : c)))
		sdk.listMessagesBefore.mockImplementation(() => pending.promise)

		// The chat screen mounts and starts its own read; the reconnect fan-out lands meanwhile.
		renderHook(() => useChatMessagesQuery({ uuid: "c0" }), { wrapper })

		await waitFor(() => expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1))

		const refetch = chats.refetchChatsAndMessages()

		await waitFor(() => expect(sdk.listChats).toHaveBeenCalledTimes(1))

		pending.resolve([newer])

		await refetch

		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
	})

	it("the open chat is re-read even with an unchanged lastMessage: an older message deleted meanwhile drops out", async () => {
		renderHook(() => useChatMessagesQuery({ uuid: "c0" }), { wrapper })

		// The chat screen's own mount read.
		await waitFor(() => expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(queryClient.getQueryState(["useChatMessagesQuery", { uuid: "c0" }])?.fetchStatus).toBe("idle"))

		seedMessages("c0", [message("c0", "deleted-while-away", 1n), lasts[0] as ChatMessage])
		sdk.listMessagesBefore.mockClear()

		await chats.refetchChatsAndMessages()

		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect((sdk.listMessagesBefore.mock.calls[0]?.[0] as Chat).uuid).toBe("c0")
		expect(chatMessagesQueryGet({ uuid: "c0" })?.map(m => m.inner.uuid)).toEqual(["m0"])
	})

	it("the chats list's unread badges (disabled observers) don't make a chat count as open", async () => {
		for (const c of listing) {
			renderHook(() => useChatMessagesQuery({ uuid: c.uuid }, { enabled: false }), { wrapper })
		}

		await chats.refetchChatsAndMessages()

		expect(sdk.listMessagesBefore).not.toHaveBeenCalled()
	})

	it("a mounted chats list's in-flight listing read is shared, not duplicated", async () => {
		const pending = deferred<Chat[]>()

		sdk.listChats.mockImplementation(() => pending.promise)

		renderHook(() => useChatsQuery(), { wrapper })

		await waitFor(() => expect(sdk.listChats).toHaveBeenCalledTimes(1))

		const refetch = chats.refetchChatsAndMessages()

		pending.resolve(listing)

		await refetch

		expect(sdk.listChats).toHaveBeenCalledTimes(1)
		expect(sdk.listMessagesBefore).not.toHaveBeenCalled()
	})
})

describe("chats.fetchMissingMessages request counts", () => {
	it("reads only the pages missing from the cache and never the listing", async () => {
		queryClient.setQueryData(["useChatsQuery"], [...listing, chat("fresh", message("fresh", "f1", 1n))])

		await chats.fetchMissingMessages()

		expect(sdk.listChats).not.toHaveBeenCalled()
		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
		expect((sdk.listMessagesBefore.mock.calls[0]?.[0] as Chat).uuid).toBe("fresh")
	})

	it("shares the read the fan-out already has in flight for the same chat", async () => {
		const pending = deferred<ChatMessage[]>()

		sdk.listChats.mockResolvedValue([...listing, chat("fresh", message("fresh", "f1", 1n))])
		sdk.listMessagesBefore.mockImplementation(() => pending.promise)

		const refetch = chats.refetchChatsAndMessages()

		// The listing commits first, which is what flips the badge hook's missing-pages effect.
		await waitFor(() => expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1))

		const missing = chats.fetchMissingMessages()

		pending.resolve([message("fresh", "f1", 1n)])

		await Promise.all([refetch, missing])

		expect(sdk.listMessagesBefore).toHaveBeenCalledTimes(1)
	})
})
