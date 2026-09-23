// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type { SocketEvent, UserEventResult } from "@filen/sdk-rs"

const { getUserEvents } = vi.hoisted(() => ({
	getUserEvents: vi.fn<(filter?: unknown, timestamp?: bigint) => Promise<UserEventResult[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserEvents } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/shell/lib/performLogout", () => ({ performLogout: vi.fn() }))

import { queryClient } from "@/queries/client"
import { EVENTS_QUERY_KEY, loadOlderEvents, useEventsQuery } from "@/features/settings/queries/events"
import { handleGeneralEvent } from "@/features/shell/lib/generalSocketHandlers"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"

function ok(id: bigint): UserEventResult {
	return {
		type: "ok",
		id,
		timestamp: id,
		uuid: "11111111-1111-1111-1111-111111111111",
		kind: { type: "login", ip: "1.2.3.4", userAgent: "ua" }
	}
}

// Newest first, like the server's pages.
const PAGE_ONE = [ok(30n), ok(29n), ok(28n)]
const PAGE_TWO = [ok(27n), ok(26n)]

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

function mountEvents() {
	return renderHook(() => useEventsQuery(), { wrapper })
}

async function drain(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

function reads(): number {
	return getUserEvents.mock.calls.length
}

function cachedIds(): bigint[] {
	return (queryClient.getQueryData<UserEventResult[]>(EVENTS_QUERY_KEY) ?? []).flatMap(e => (e.type === "ok" ? [e.id] : []))
}

function newEvent(): Extract<SocketEvent, { type: "general" }> {
	return {
		type: "general",
		inner: {
			type: "newEvent",
			uuid: "evt-0000-0000-0000-000000000000",
			eventType: "login",
			timestamp: 31n,
			info: "{}"
		},
		generalMessageId: 0n
	}
}

// Page one, then page two scrolled in: two reads.
async function mountWithTwoPages() {
	getUserEvents.mockResolvedValueOnce(PAGE_ONE).mockResolvedValueOnce(PAGE_TWO)

	const view = mountEvents()
	await drain()
	await act(async () => {
		await loadOlderEvents(28n)
	})

	expect(reads()).toBe(2)
	expect(cachedIds()).toEqual([30n, 29n, 28n, 27n, 26n])

	return view
}

// A fresh epoch per test, so no earlier test's read still counts.
beforeEach(() => {
	queryClient.clear()
	socketAuthenticated()
	getUserEvents.mockResolvedValue(PAGE_ONE)
})

afterEach(() => {
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("account events request counts", () => {
	it("returning to the page and focusing reuse the loaded pages", async () => {
		const view = await mountWithTwoPages()

		view.unmount()
		mountEvents()
		await drain()
		act(() => {
			focusManager.setFocused(false)
			focusManager.setFocused(true)
		})
		await drain()

		expect(reads()).toBe(2)
		expect(cachedIds()).toEqual([30n, 29n, 28n, 27n, 26n])
	})

	it("a new event refreshes page one into the loaded pages", async () => {
		await mountWithTwoPages()

		getUserEvents.mockResolvedValueOnce([ok(31n), ...PAGE_ONE.slice(0, 2)])
		handleGeneralEvent(newEvent())
		await drain()

		expect(reads()).toBe(3)
		expect(cachedIds()).toEqual([31n, 30n, 29n, 28n, 27n, 26n])
	})

	it("a new event while the page is closed reads once on return and keeps the loaded pages", async () => {
		const view = await mountWithTwoPages()

		view.unmount()
		getUserEvents.mockResolvedValueOnce([ok(31n), ...PAGE_ONE.slice(0, 2)])
		handleGeneralEvent(newEvent())
		await drain()

		expect(reads()).toBe(2)

		mountEvents()
		await drain()

		expect(reads()).toBe(3)
		expect(cachedIds()).toEqual([31n, 30n, 29n, 28n, 27n, 26n])
	})

	it("a first page that no longer reaches the loaded ones replaces them", async () => {
		await mountWithTwoPages()

		getUserEvents.mockResolvedValueOnce([ok(40n), ok(39n)])
		handleGeneralEvent(newEvent())
		await drain()

		expect(cachedIds()).toEqual([40n, 39n])
	})

	it("an older page landing during a refresh survives it", async () => {
		getUserEvents.mockResolvedValueOnce(PAGE_ONE)
		mountEvents()
		await drain()

		const refresh = deferred<UserEventResult[]>()
		getUserEvents.mockImplementationOnce(() => refresh.promise).mockResolvedValueOnce(PAGE_TWO)
		handleGeneralEvent(newEvent())
		await act(async () => {
			await loadOlderEvents(28n)
		})
		refresh.resolve([ok(31n), ...PAGE_ONE])
		await drain()

		expect(reads()).toBe(3)
		expect(cachedIds()).toEqual([31n, 30n, 29n, 28n, 27n, 26n])
	})

	it("a network reconnect reads page one again", async () => {
		mountEvents()
		await drain()

		act(() => {
			onlineManager.setOnline(false)
			onlineManager.setOnline(true)
		})
		await drain()

		expect(reads()).toBe(2)
	})
})

describe("account events reads the socket didn't cover", () => {
	it("a restored slice is read on its first mount, then reused", async () => {
		queryClient.setQueryData(EVENTS_QUERY_KEY, PAGE_TWO, { updatedAt: Date.now() })

		const first = mountEvents()
		await drain()

		expect(reads()).toBe(1)

		first.unmount()
		mountEvents()
		await drain()

		expect(reads()).toBe(1)
	})

	it("a socket drop since the last read makes the next return read again", async () => {
		const view = mountEvents()
		await drain()
		view.unmount()

		socketDropped()
		socketAuthenticated()
		mountEvents()
		await drain()

		expect(reads()).toBe(2)
	})

	it("a read while the socket is down doesn't count", async () => {
		socketDropped()

		const view = mountEvents()
		await drain()
		view.unmount()
		mountEvents()
		await drain()

		expect(reads()).toBe(2)
	})
})
