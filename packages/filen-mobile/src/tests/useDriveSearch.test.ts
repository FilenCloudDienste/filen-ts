// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// ------------------------------------------------------------------
// Hoisted spies / mocks (must be defined before the imports they back)
// ------------------------------------------------------------------

const { debounceSpy, mockFindItemMatchesForName, mockIsOnline, mockAlertError } = vi.hoisted(() => ({
	debounceSpy: vi.fn(),
	mockFindItemMatchesForName: vi.fn(),
	mockIsOnline: vi.fn(() => true),
	mockAlertError: vi.fn()
}))

// Real debounce, wrapped so we can COUNT how many debounced functions get created.
// The whole point of the fix is that the searcher is created exactly once for the
// lifetime of the hook — not rebuilt on every render (the original IIFE bug).
vi.mock("es-toolkit/function", async () => {
	const actual = await vi.importActual<typeof import("es-toolkit/function")>("es-toolkit/function")

	return {
		...actual,
		debounce: (...args: Parameters<typeof actual.debounce>) => {
			debounceSpy()

			return actual.debounce(...args)
		}
	}
})

vi.mock("@/features/drive/drive", () => ({
	default: {
		findItemMatchesForName: mockFindItemMatchesForName
	}
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: mockAlertError
	}
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		isOnline: mockIsOnline
	}
}))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import type { DrivePath } from "@/hooks/useDrivePath"

function drivePath(over?: Partial<DrivePath>): DrivePath {
	return {
		type: "drive",
		uuid: null,
		...over
	} as DrivePath
}

beforeEach(() => {
	debounceSpy.mockClear()
	mockFindItemMatchesForName.mockReset()
	mockFindItemMatchesForName.mockResolvedValue([])
	mockIsOnline.mockReturnValue(true)
	mockAlertError.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("useDriveSearch", () => {
	it("creates the debounced searcher exactly once across many re-renders (stable identity)", () => {
		const { rerender } = renderHook(({ path }: { path: DrivePath }) => useDriveSearch({ drivePath: path }), {
			initialProps: { path: drivePath() }
		})

		// A fresh drivePath object every render (as useDrivePath produces) used to
		// rebuild the debounced fn each time. With the lazy useState init it must not.
		rerender({ path: drivePath() })
		rerender({ path: drivePath() })
		rerender({ path: drivePath() })

		expect(debounceSpy).toHaveBeenCalledTimes(1)
	})

	it("exposes a stable result-shape and updates searchQuery via setSearchQuery", () => {
		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath() }))

		expect(result.current.searchQuery).toBe("")
		expect(result.current.globalSearchResult).toEqual([])
		expect(result.current.queryingGlobalSearch).toBe(false)

		act(() => {
			result.current.setSearchQuery("hello")
		})

		expect(result.current.searchQuery).toBe("hello")
	})

	it("debounces: rapid query changes collapse into a single SDK search with the latest term", async () => {
		vi.useFakeTimers()

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath() }))

		// Three rapid changes within the 1s window → only the last should fire.
		act(() => {
			result.current.setSearchQuery("a")
		})
		act(() => {
			result.current.setSearchQuery("ab")
		})
		act(() => {
			result.current.setSearchQuery("abc")
		})

		expect(mockFindItemMatchesForName).not.toHaveBeenCalled()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		expect(mockFindItemMatchesForName).toHaveBeenCalledTimes(1)
		expect(mockFindItemMatchesForName.mock.calls[0]?.[0]).toMatchObject({ name: "abc" })
	})

	it("does not run the global SDK search while offline", async () => {
		vi.useFakeTimers()
		mockIsOnline.mockReturnValue(false)

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath() }))

		act(() => {
			result.current.setSearchQuery("anything")
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		expect(mockFindItemMatchesForName).not.toHaveBeenCalled()
	})

	it("does not run the global search on a non-drive variant", async () => {
		vi.useFakeTimers()

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath({ type: "trash" }) }))

		act(() => {
			result.current.setSearchQuery("anything")
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		expect(mockFindItemMatchesForName).not.toHaveBeenCalled()
	})

	it("an empty/whitespace query clears results without an SDK call", async () => {
		vi.useFakeTimers()

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath() }))

		act(() => {
			result.current.setSearchQuery("   ")
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		expect(mockFindItemMatchesForName).not.toHaveBeenCalled()
		expect(result.current.globalSearchResult).toEqual([])
	})

	it("populates globalSearchResult from the SDK matches", async () => {
		vi.useFakeTimers()

		mockFindItemMatchesForName.mockResolvedValue([
			{ item: { type: "file", data: { uuid: "u1" } } },
			{ item: { type: "file", data: { uuid: "u2" } } }
		])

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath() }))

		act(() => {
			result.current.setSearchQuery("photo")
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		expect(result.current.globalSearchResult.map(i => i.data.uuid)).toEqual(["u1", "u2"])
		expect(result.current.queryingGlobalSearch).toBe(false)
	})

	// #212 — type='drive' WITH selectOptions (select-mode) suppresses global search
	it("does not run the global search when type='drive' but selectOptions is defined (select-mode)", async () => {
		vi.useFakeTimers()

		const selectOptions = {
			type: "single" as const,
			files: true,
			directories: false,
			intention: "select" as const,
			items: [],
			id: "sel-1"
		}

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath({ type: "drive", selectOptions }) }))

		act(() => {
			result.current.setSearchQuery("anything")
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		// The effect guard (line 138 of useDriveSearch.ts) returns early when
		// selectOptions is defined, so the debounced searcher is never invoked.
		expect(mockFindItemMatchesForName).not.toHaveBeenCalled()
		// State should remain at initial defaults.
		expect(result.current.globalSearchResult).toEqual([])
		expect(result.current.queryingGlobalSearch).toBe(false)
	})

	// #213 — SDK-error path: alerts.error called + globalSearchResult cleared + queryingGlobalSearch false
	it("calls alerts.error and clears globalSearchResult when findItemMatchesForName rejects", async () => {
		vi.useFakeTimers()

		const sdkError = new Error("SDK network failure")

		mockFindItemMatchesForName.mockRejectedValue(sdkError)

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath() }))

		act(() => {
			result.current.setSearchQuery("query")
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})

		// run() caught the rejection and returned { success: false, error }.
		// The source (lines 115-122) must call alerts.error with the error and clear results.
		expect(mockAlertError).toHaveBeenCalledTimes(1)
		expect(mockAlertError).toHaveBeenCalledWith(sdkError)
		expect(result.current.globalSearchResult).toEqual([])
		// The defer in run() calls setQueryingGlobalSearch(false) on cleanup, so it must be false.
		expect(result.current.queryingGlobalSearch).toBe(false)
	})
})
