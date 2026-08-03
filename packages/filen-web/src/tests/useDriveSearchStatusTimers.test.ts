// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { Dir, UuidStr } from "@filen/sdk-rs"

// deriveSearchStatus is exhaustively table-tested (searchStatus.test.ts) and the open serialization has
// its own file; what neither covers is the half that ARMS the machine's two inputs — the grace and
// watchdog timers the hook (re-)schedules on every push. A status that never leaves "warming", or a
// watchdog armed with the wrong ceiling, is invisible to a pure table test.

const { searchOpen, searchSetName, searchClose } = vi.hoisted(() => ({
	searchOpen: vi.fn<(params: { rootUuid: string | null; name: string }, onPush: (push: SearchPush) => void) => Promise<SnapshotDTO>>(),
	searchSetName: vi.fn<(name: string) => Promise<boolean>>(() => Promise.resolve(true)),
	searchClose: vi.fn<() => Promise<void>>(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { searchOpen, searchSetName, searchClose } }))

import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import { GRACE_MS, WATCHDOG_MS, STALL_CEILING_MS } from "@/features/drive/lib/searchStatus.logic"
import type { SearchPush, SearchHitDTO, SearchSnapshotDTO as SnapshotDTO } from "@/workers/searchEngine"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function hit(label: string): SearchHitDTO {
	const dir: Dir = {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}

	return { parentPath: "/", item: dir }
}

const EMPTY_SNAPSHOT: SnapshotDTO = { hits: [], total: 0n, live: true }

// The push callback the hook handed the engine for the CURRENT open.
function pushFn(): (push: SearchPush) => void {
	const call = searchOpen.mock.calls.at(-1)

	if (call === undefined) {
		throw new Error("searchOpen was never called")
	}

	return call[1]
}

async function typeQuery(setInput: (value: string) => void, query = "report"): Promise<void> {
	await act(async () => {
		setInput(query)
		await Promise.resolve()
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	searchOpen.mockReset()
	searchOpen.mockImplementation(() => Promise.resolve(EMPTY_SNAPSHOT))
	searchSetName.mockClear()
	searchClose.mockClear()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("useDriveSearch — grace window", () => {
	it("holds an empty result set at warming until the grace window passes with nothing happening", async () => {
		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		expect(result.current.status).toBe("warming")

		await act(async () => {
			await vi.advanceTimersByTimeAsync(GRACE_MS - 1)
		})

		expect(result.current.status).toBe("warming")

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1)
		})

		expect(result.current.status).toBe("settled")
	})

	it("shows a non-empty result set immediately — grace only ever gates the empty case", async () => {
		searchOpen.mockImplementation(() => Promise.resolve({ hits: [hit("a")], total: 1n, live: true }))

		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		expect(result.current.status).toBe("settled")
		expect(result.current.results.length).toBe(1)
	})

	it("a resync that starts after grace elapsed re-arms it, and an empty in-flight resync reads as still searching", async () => {
		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(GRACE_MS)
		})

		expect(result.current.status).toBe("settled")

		const push = pushFn()

		act(() => {
			push({ type: "resync", resyncing: true })
		})

		// The resync re-armed grace, so the empty set is back to warming until it clears again.
		expect(result.current.status).toBe("warming")

		await act(async () => {
			await vi.advanceTimersByTimeAsync(GRACE_MS)
		})

		expect(result.current.status).toBe("searching-empty")
	})
})

describe("useDriveSearch — watchdog ceilings", () => {
	// One flag, two durations: fatal while nothing has landed, a soft finalize once results exist.
	it("collapses to terminal only after the full pre-result ceiling", async () => {
		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1)
		})

		expect(result.current.status).toBe("settled")

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1)
		})

		expect(result.current.status).toBe("terminal")
	})

	it("uses the shorter stall backstop once results are on screen, and finalizes instead of failing", async () => {
		searchOpen.mockImplementation(() => Promise.resolve({ hits: [hit("a")], total: 1n, live: true }))

		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		const push = pushFn()

		act(() => {
			push({ type: "resync", resyncing: true })
		})

		expect(result.current.status).toBe("background")

		await act(async () => {
			await vi.advanceTimersByTimeAsync(STALL_CEILING_MS)
		})

		// Results already landed, so the ceiling is a soft finalize — never the terminal error state.
		expect(result.current.status).toBe("settled")
		expect(result.current.results.length).toBe(1)
	})

	// A first index over a large account can legitimately take minutes and the engine's pushes are lossy,
	// so a live heartbeat must re-arm the ceiling rather than let a slow search collapse to terminal.
	it("a heartbeat pushes the ceiling out — a slow but live search is never misreported as dead", async () => {
		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		const push = pushFn()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1_000)
			push({ type: "heartbeat" })
			await vi.advanceTimersByTimeAsync(2_000)
		})

		expect(result.current.status).not.toBe("terminal")

		// Only the re-armed remainder of the ceiling is left; the search still collapses eventually.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(WATCHDOG_MS)
		})

		expect(result.current.status).toBe("terminal")
	})

	it("a deleted search root is terminal regardless of any timer", async () => {
		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		const push = pushFn()

		act(() => {
			push({ type: "rootDeleted" })
		})

		expect(result.current.status).toBe("terminal")
	})
})

describe("useDriveSearch — teardown", () => {
	it("clearing the box leaves the engine warm and the status idle", async () => {
		const { result } = renderHook(() => useDriveSearch(null, true))

		await typeQuery(result.current.setInput)

		act(() => {
			result.current.clear()
		})

		expect(result.current.status).toBe("idle")
		expect(result.current.active).toBe(false)
		expect(searchClose).not.toHaveBeenCalled()
	})

	it("a root change tears the engine down and blanks the box", async () => {
		const { result, rerender } = renderHook(({ root }: { root: string | null }) => useDriveSearch(root, true), {
			initialProps: { root: null as string | null }
		})

		await typeQuery(result.current.setInput)

		rerender({ root: testUuid("other") })

		expect(searchClose).toHaveBeenCalledTimes(1)
		expect(result.current.input).toBe("")
		expect(result.current.status).toBe("idle")
	})
})
