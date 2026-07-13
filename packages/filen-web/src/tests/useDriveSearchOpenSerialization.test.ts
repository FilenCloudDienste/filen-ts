// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

// Deferred-promise engine fakes: searchOpen resolves only when the test releases it, which is the
// whole point — the regression under pin lives in what happens to keystrokes typed while the FIRST
// open's round-trip is still in flight.
const { searchOpen, searchSetName, searchClose } = vi.hoisted(() => ({
	searchOpen: vi.fn<(params: { rootUuid: string | null; name: string }, onPush: unknown) => Promise<unknown>>(),
	searchSetName: vi.fn<(name: string) => Promise<boolean>>(),
	searchClose: vi.fn<() => Promise<void>>(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { searchOpen, searchSetName, searchClose } }))

import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"

const EMPTY_SNAPSHOT = { hits: [], total: 0n, live: true }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

beforeEach(() => {
	vi.useFakeTimers()
	searchOpen.mockReset()
	searchSetName.mockReset()
	searchClose.mockReset()
	searchClose.mockImplementation(() => Promise.resolve())
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("useDriveSearch — one serialized engine open per engagement", () => {
	it("keystrokes typed while the first open is in flight park and retune, never a second open", async () => {
		const firstOpen = deferred<typeof EMPTY_SNAPSHOT>()

		searchOpen.mockImplementation(() => firstOpen.promise)
		searchSetName.mockImplementation(() => Promise.resolve(true))

		const { result } = renderHook(() => useDriveSearch(null, true))

		// A human types a query one keystroke at a time; the engine's first open (which may be running
		// a whole convergence resync) is still in flight for all of them. Before the serialization fix,
		// every one of these fired a fresh searchOpen — each superseding the previous one inside the
		// worker and killing the resync its just-created search handle had started.
		act(() => {
			result.current.setInput(".")
		})
		act(() => {
			result.current.setInput(".f")
		})
		act(() => {
			result.current.setInput(".fi")
		})
		act(() => {
			result.current.setInput(".filen")
		})

		expect(searchOpen).toHaveBeenCalledTimes(1)
		expect(searchOpen.mock.calls[0]?.[0]).toMatchObject({ name: "." })

		// The open settles; the parked (latest) query drains as a debounced retune of the installed
		// handle — the cheap refilter path, never a reopen.
		await act(async () => {
			firstOpen.resolve(EMPTY_SNAPSHOT)
			await firstOpen.promise
		})

		expect(searchOpen).toHaveBeenCalledTimes(1)

		await act(async () => {
			await vi.runAllTimersAsync()
		})

		expect(searchSetName).toHaveBeenCalledWith(".filen")
		expect(searchOpen).toHaveBeenCalledTimes(1)
	})

	it("a query blanked mid-open drops the parked keystrokes instead of resurrecting them", async () => {
		const firstOpen = deferred<typeof EMPTY_SNAPSHOT>()

		searchOpen.mockImplementation(() => firstOpen.promise)
		searchSetName.mockImplementation(() => Promise.resolve(true))

		const { result } = renderHook(() => useDriveSearch(null, true))

		act(() => {
			result.current.setInput("report")
		})
		act(() => {
			result.current.setInput("")
		})

		await act(async () => {
			firstOpen.resolve(EMPTY_SNAPSHOT)
			await firstOpen.promise
			await vi.runAllTimersAsync()
		})

		// Nothing drains: the engine stays warm on its opened (now-idle) state, no retune fires for
		// the deleted query, and no second open ever happened.
		expect(searchOpen).toHaveBeenCalledTimes(1)
		expect(searchSetName).not.toHaveBeenCalled()
	})

	it("the no-live-handle retune fallback reopens once, not concurrently with an in-flight open", async () => {
		// First open resolves immediately (engaged), then the engine loses its handle (setName -> false)
		// while a SECOND open (from the fallback) is deliberately held in flight.
		searchOpen.mockImplementation(() => Promise.resolve(EMPTY_SNAPSHOT))
		searchSetName.mockImplementation(() => Promise.resolve(false))

		const { result } = renderHook(() => useDriveSearch(null, true))

		await act(async () => {
			result.current.setInput("a")
			await Promise.resolve()
		})

		expect(searchOpen).toHaveBeenCalledTimes(1)

		const secondOpen = deferred<typeof EMPTY_SNAPSHOT>()

		searchOpen.mockImplementation(() => secondOpen.promise)

		// Retune path: engaged now, so this schedules setName; the fake returns false (handle lost),
		// which routes into the reopen fallback.
		act(() => {
			result.current.setInput("ab")
		})

		await act(async () => {
			await vi.runAllTimersAsync()
		})

		expect(searchOpen).toHaveBeenCalledTimes(2)

		// More typing while the fallback's reopen is in flight: parked, no third open.
		act(() => {
			result.current.setInput("abc")
		})

		expect(searchOpen).toHaveBeenCalledTimes(2)

		// The reopened handle is live again from here on, so the drained retune sticks.
		searchSetName.mockImplementation(() => Promise.resolve(true))

		await act(async () => {
			secondOpen.resolve(EMPTY_SNAPSHOT)
			await secondOpen.promise
			await vi.runAllTimersAsync()
		})

		// The parked query drained as a retune against the reopened handle.
		expect(searchSetName).toHaveBeenLastCalledWith("abc")
		expect(searchOpen).toHaveBeenCalledTimes(2)
	})
})
