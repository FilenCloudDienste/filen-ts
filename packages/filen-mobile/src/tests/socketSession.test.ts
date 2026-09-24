// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, cleanup, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"

const { mockListChats, mockListMessagesBefore, holder } = vi.hoisted(() => ({
	mockListChats: vi.fn(),
	mockListMessagesBefore: vi.fn(),
	holder: { client: null as unknown as import("@tanstack/react-query").QueryClient }
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {
		refetchOnMount: "always",
		staleTime: 0,
		retry: false
	},
	get default() {
		return holder.client
	},
	queryUpdater: {
		get: (queryKey: unknown[]) => holder.client.getQueryData(queryKey),
		set: (queryKey: unknown[], updater: unknown) => holder.client.setQueryData(queryKey, updater)
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: {
				listChats: mockListChats,
				listMessagesBefore: mockListMessagesBefore
			}
		})
	}
}))

vi.mock("@/features/chats/chatsWrap", () => ({
	wrapChat: (chat: unknown) => chat,
	wrapMessage: (message: unknown) => message
}))

import { noteSocketDataEvent, socketCoveredRefetchOnMount, trackServerReads } from "@/queries/socketSession"
import useSocketStore from "@/stores/useSocket.store"
import useChatsQuery, { CHATS_LIST_REUSE_MS, BASE_QUERY_KEY as CHATS_KEY } from "@/features/chats/queries/useChats.query"
import useChatMessagesQuery from "@/features/chats/queries/useChatMessages.query"

const chat = { uuid: "chat-1" }

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: holder.client }, children)
}

async function mountAndSettle<T>(hook: () => { data: T | undefined; fetchStatus: string }): Promise<void> {
	const { result, unmount } = renderHook(hook, { wrapper })

	await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
	await waitFor(() => expect(result.current.data).toBeDefined())

	unmount()
}

async function tick(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 2))
}

// A socket drop and reconnect, as a background/foreground cycle or a network flap produces.
async function reconnect(): Promise<void> {
	useSocketStore.getState().setState("disconnected")
	await tick()
	useSocketStore.getState().setState("connected")
}

beforeEach(async () => {
	holder.client = new QueryClient()
	trackServerReads(holder.client.getQueryCache())
	mockListChats.mockReset().mockResolvedValue([chat])
	mockListMessagesBefore.mockReset().mockResolvedValue([{ uuid: "m1" }])
	useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
	useSocketStore.getState().setState("connected")
	await tick()
})

afterEach(() => {
	cleanup()
	holder.client.clear()
	vi.useRealTimers()
})

describe("socketCoveredRefetchOnMount — generic rule", () => {
	const queryFn = vi.fn(async () => "fresh")

	function useCovered(maxAgeMs?: number) {
		return useQuery({
			queryKey: ["covered"],
			queryFn,
			staleTime: 0,
			retry: false,
			refetchOnMount: socketCoveredRefetchOnMount(maxAgeMs)
		})
	}

	beforeEach(() => {
		queryFn.mockClear()
	})

	// A read whose result may lack a change that arrived while it was in flight.
	async function readOverlapping(during: () => void): Promise<void> {
		let release = () => {}

		queryFn.mockImplementationOnce(
			() =>
				new Promise<string>(resolve => {
					release = () => resolve("fresh")
				})
		)

		const { result, unmount } = renderHook(() => useCovered(), { wrapper })

		await waitFor(() => expect(result.current.fetchStatus).toBe("fetching"))

		during()
		release()

		await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))

		unmount()
	}

	it("a socket event while the read is in flight makes it no read: the next mount reads again", async () => {
		await readOverlapping(() => noteSocketDataEvent())
		await mountAndSettle(() => useCovered())
		// That read ran clean, so it is reused.
		await mountAndSettle(() => useCovered())

		expect(queryFn).toHaveBeenCalledTimes(2)
	})

	it("a patch its result overwrote makes it no read, and drops the read before it", async () => {
		await mountAndSettle(() => useCovered())

		holder.client.invalidateQueries({ queryKey: ["covered"], refetchType: "none" })

		await readOverlapping(() => {
			holder.client.setQueryData(["covered"], "patched")
		})
		await mountAndSettle(() => useCovered())

		expect(queryFn).toHaveBeenCalledTimes(3)
	})

	it("a remount reuses a read from the current socket session", async () => {
		await mountAndSettle(() => useCovered())
		await mountAndSettle(() => useCovered())

		expect(queryFn).toHaveBeenCalledTimes(1)
	})

	it("a restored or patched value is no read: the first mount reads", async () => {
		holder.client.setQueryData(["covered"], "persisted")

		await mountAndSettle(() => useCovered())
		await mountAndSettle(() => useCovered())

		expect(queryFn).toHaveBeenCalledTimes(1)
	})

	it("a value the persister answered from storage is no read either", async () => {
		function useRestored() {
			return useQuery({
				queryKey: ["restored"],
				queryFn,
				retry: false,
				// What the storage persister does on a hit: restore the stored timestamp, skip the queryFn.
				persister: async (_fn, _ctx, query) => {
					query.setState({ dataUpdatedAt: 1 })

					return "from storage"
				},
				refetchOnMount: socketCoveredRefetchOnMount()
			})
		}

		await mountAndSettle(useRestored)

		expect(queryFn).not.toHaveBeenCalled()

		// No server read happened, so the next mount (now without the storage stub) reads.
		await mountAndSettle(() =>
			useQuery({ queryKey: ["restored"], queryFn, retry: false, refetchOnMount: socketCoveredRefetchOnMount() })
		)

		expect(queryFn).toHaveBeenCalledTimes(1)
	})

	it("a socket drop between the reads makes the next mount read", async () => {
		await mountAndSettle(() => useCovered())
		await reconnect()
		await mountAndSettle(() => useCovered())

		expect(queryFn).toHaveBeenCalledTimes(2)
	})

	it("an invalidation makes the next mount read", async () => {
		await mountAndSettle(() => useCovered())
		await holder.client.invalidateQueries({ queryKey: ["covered"], refetchType: "none" })
		await mountAndSettle(() => useCovered())

		expect(queryFn).toHaveBeenCalledTimes(2)
	})

	it("with a max age, an older read is not reused", async () => {
		await mountAndSettle(() => useCovered(1000))

		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1001 })

		await mountAndSettle(() => useCovered(1000))

		expect(queryFn).toHaveBeenCalledTimes(2)
	})
})

describe("chats — reopen request counts", () => {
	it("chat A → back → chat A without a socket gap lists the messages once", async () => {
		holder.client.setQueryData([CHATS_KEY], [chat])

		await mountAndSettle(() => useChatMessagesQuery({ uuid: "chat-1" }))
		await mountAndSettle(() => useChatMessagesQuery({ uuid: "chat-1" }))

		expect(mockListMessagesBefore).toHaveBeenCalledTimes(1)
	})

	it("after a reconnect, reopening lists the messages again", async () => {
		holder.client.setQueryData([CHATS_KEY], [chat])

		await mountAndSettle(() => useChatMessagesQuery({ uuid: "chat-1" }))
		await reconnect()
		await mountAndSettle(() => useChatMessagesQuery({ uuid: "chat-1" }))

		expect(mockListMessagesBefore).toHaveBeenCalledTimes(2)
	})

	it("a chats-list remount within the reuse window lists chats once, past it again", async () => {
		await mountAndSettle(() => useChatsQuery())
		await mountAndSettle(() => useChatsQuery())

		expect(mockListChats).toHaveBeenCalledTimes(1)

		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + CHATS_LIST_REUSE_MS + 1 })

		await mountAndSettle(() => useChatsQuery())

		expect(mockListChats).toHaveBeenCalledTimes(2)
	})
})
