// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { focusManager, onlineManager } from "@tanstack/react-query"
import type { SocketEvent, UserEventResult } from "@filen/sdk-rs"

const { getUserEvents, persistQuery } = vi.hoisted(() => ({
	getUserEvents: vi.fn<(filter?: unknown, timestamp?: bigint) => Promise<UserEventResult[]>>(),
	persistQuery: vi.fn<(query: unknown) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserEvents } }))

vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

vi.mock("@/queries/persist", () => ({ persister: { persistQuery } }))

vi.mock("@/features/shell/lib/performLogout", () => ({ performLogout: vi.fn() }))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import {
	EVENTS_QUERY_KEY,
	EVENTS_SLICE_CAP,
	capEventsSlice,
	loadOlderEvents,
	releaseEventsSlice,
	useEventsQuery
} from "@/features/settings/queries/events"
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

const wrapper = queryClientWrapper(queryClient)

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
	// No list is mounted here to release what an earlier test paged in.
	releaseEventsSlice()
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

		const refresh = Promise.withResolvers<UserEventResult[]>()
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

// Newest first, `count` events counting down from `newest`.
function okRun(newest: bigint, count: number): UserEventResult[] {
	return Array.from({ length: count }, (_, i) => ok(newest - BigInt(i)))
}

describe("capEventsSlice", () => {
	it("keeps the newest events up to the cap", () => {
		expect(capEventsSlice(okRun(10n, 5), 3)).toEqual(okRun(10n, 3))
	})

	it("returns a slice within the cap as it is", () => {
		const slice = okRun(10n, 3)

		expect(capEventsSlice(slice, 3)).toBe(slice)
	})

	it("never cuts into a first page longer than the cap", () => {
		expect(capEventsSlice(okRun(10n, 5), 3, 4)).toEqual(okRun(10n, 4))
	})
})

describe("account events slice bound", () => {
	const FIRST = okRun(5000n, 3)
	const OLDER = okRun(4997n, EVENTS_SLICE_CAP + 100)

	async function mountPagedPastCap() {
		getUserEvents.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(OLDER)

		const view = mountEvents()
		await drain()
		await act(async () => {
			await loadOlderEvents(4998n)
		})

		expect(cachedIds()).toHaveLength(FIRST.length + OLDER.length)

		return view
	}

	it("a refresh while the list is paging keeps every page it scrolled in", async () => {
		await mountPagedPastCap()

		getUserEvents.mockResolvedValueOnce([ok(5001n), ...FIRST])
		handleGeneralEvent(newEvent())
		await drain()

		expect(cachedIds()).toHaveLength(1 + FIRST.length + OLDER.length)
	})

	it("leaving the page trims the slice to the cap, in memory and on disk, keeping its read time", async () => {
		const view = await mountPagedPastCap()
		const readAt = queryClient.getQueryState(EVENTS_QUERY_KEY)?.dataUpdatedAt

		persistQuery.mockClear()
		view.unmount()
		releaseEventsSlice()

		expect(cachedIds()).toEqual(okRun(5000n, EVENTS_SLICE_CAP).flatMap(e => (e.type === "ok" ? [e.id] : [])))
		expect(queryClient.getQueryState(EVENTS_QUERY_KEY)?.dataUpdatedAt).toBe(readAt)
		expect(persistQuery).toHaveBeenCalledTimes(1)
	})

	it("leaving without having paged writes nothing", async () => {
		const view = mountEvents()
		await drain()

		persistQuery.mockClear()
		view.unmount()
		releaseEventsSlice()

		expect(persistQuery).not.toHaveBeenCalled()
	})

	it("a restored slice past the cap is trimmed by its first read", async () => {
		queryClient.setQueryData(EVENTS_QUERY_KEY, [...FIRST, ...OLDER], { updatedAt: Date.now() })
		getUserEvents.mockResolvedValueOnce(FIRST)

		mountEvents()
		await drain()

		expect(cachedIds()).toHaveLength(EVENTS_SLICE_CAP)
	})

	it("an older page read from a cursor that is no longer the slice's end is dropped", async () => {
		getUserEvents.mockResolvedValueOnce(PAGE_ONE)
		mountEvents()
		await drain()

		const older = Promise.withResolvers<UserEventResult[]>()
		getUserEvents.mockImplementationOnce(() => older.promise).mockResolvedValueOnce([ok(40n), ok(39n)])

		let result: { newCount: number; terminate: boolean } | undefined
		const loading = loadOlderEvents(28n).then(r => {
			result = r
		})

		handleGeneralEvent(newEvent())
		await drain()
		older.resolve(PAGE_TWO)
		await act(async () => {
			await loading
		})

		expect(result).toEqual({ newCount: 0, terminate: false })
		expect(cachedIds()).toEqual([40n, 39n])
	})
})
