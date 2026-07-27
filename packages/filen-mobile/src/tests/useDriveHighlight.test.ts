// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, act, cleanup } from "@testing-library/react"

// The only reactive input the hook takes that isn't a prop. Held in a box so a rerender()
// re-reads it, mirroring a real navigation landing on the screen with the param set.
const { params } = vi.hoisted(() => ({
	params: { current: {} as { highlight?: string | string[] } }
}))

vi.mock("expo-router", () => ({
	useLocalSearchParams: () => params.current
}))

import { useDriveHighlight } from "@/features/drive/hooks/useDriveHighlight"
import { HIGHLIGHT_VISIBLE_MS } from "@/features/drive/driveHighlight"
import type { DriveItem } from "@/types"
import type { ListRef } from "@/components/ui/virtualList"

function item(uuid: string): DriveItem {
	return {
		type: "file",
		data: { uuid }
	} as DriveItem
}

// FlashList's scrollToIndex resolves only once the scroll has settled, and the hook times the
// tint's window from that — so the fake has to be a promise, and tests have to flush it.
function makeListRef(live = true): { ref: React.RefObject<ListRef<DriveItem> | null>; scrollToIndex: ReturnType<typeof vi.fn> } {
	const scrollToIndex = vi.fn(async () => {})

	return {
		ref: { current: live ? { scrollToIndex } : null } as unknown as React.RefObject<ListRef<DriveItem> | null>,
		scrollToIndex
	}
}

// Lets the scrollToIndex promise settle so the hook arms its clear timer.
async function settleScroll(): Promise<void> {
	await act(async () => {})
}

beforeEach(() => {
	vi.useFakeTimers()

	params.current = {}
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	vi.clearAllMocks()
})

describe("useDriveHighlight", () => {
	it("returns null and never scrolls when no highlight param is present", () => {
		const { ref, scrollToIndex } = makeListRef()

		const { result } = renderHook(() => useDriveHighlight({ items: [item("a"), item("b")], listRef: ref, ready: true, settled: true }))

		expect(result.current).toBeNull()
		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("ignores a repeated param (expo-router hands back an array) rather than treating it as a uuid", () => {
		params.current = { highlight: ["a", "b"] }

		const { ref, scrollToIndex } = makeListRef()

		const { result } = renderHook(() => useDriveHighlight({ items: [item("a")], listRef: ref, ready: true, settled: true }))

		expect(result.current).toBeNull()
		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("scrolls to the target's index, centered, and reports it as highlighted", () => {
		params.current = { highlight: "b" }

		const { ref, scrollToIndex } = makeListRef()

		const { result } = renderHook(() =>
			useDriveHighlight({ items: [item("a"), item("b"), item("c")], listRef: ref, ready: true, settled: true })
		)

		expect(result.current).toBe("b")
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.5 })
	})

	it("does not latch until the list is mounted in its final form", async () => {
		params.current = { highlight: "a" }

		const { ref, scrollToIndex } = makeListRef()

		const { result, rerender } = renderHook(
			(props: { ready: boolean }) => useDriveHighlight({ items: [item("a")], listRef: ref, settled: true, ...props }),
			{ initialProps: { ready: false } }
		)

		expect(result.current).toBeNull()
		expect(scrollToIndex).not.toHaveBeenCalled()

		rerender({ ready: true })

		expect(result.current).toBe("a")
		expect(scrollToIndex).toHaveBeenCalledTimes(1)

		await settleScroll()
	})

	it("clears the highlight once the tint has played out, timed from the settled scroll", async () => {
		params.current = { highlight: "a" }

		const { ref } = makeListRef()

		const { result } = renderHook(() => useDriveHighlight({ items: [item("a")], listRef: ref, ready: true, settled: true }))

		expect(result.current).toBe("a")

		// The window has not started yet — the scroll is still in flight.
		act(() => {
			vi.advanceTimersByTime(HIGHLIGHT_VISIBLE_MS * 2)
		})

		expect(result.current).toBe("a")

		await settleScroll()

		act(() => {
			vi.advanceTimersByTime(HIGHLIGHT_VISIBLE_MS - 1)
		})

		expect(result.current).toBe("a")

		act(() => {
			vi.advanceTimersByTime(1)
		})

		expect(result.current).toBeNull()
	})

	it("still expires the tint when there is no list to scroll", async () => {
		params.current = { highlight: "a" }

		const { ref } = makeListRef(false)

		const { result } = renderHook(() => useDriveHighlight({ items: [item("a")], listRef: ref, ready: true, settled: true }))

		expect(result.current).toBe("a")

		await settleScroll()

		act(() => {
			vi.advanceTimersByTime(HIGHLIGHT_VISIBLE_MS)
		})

		expect(result.current).toBeNull()
	})

	it("re-scrolls when the listing re-sorts the target out from under the scroll", async () => {
		params.current = { highlight: "b" }

		const { ref, scrollToIndex } = makeListRef()

		const { rerender } = renderHook(
			(props: { items: DriveItem[] }) => useDriveHighlight({ ...props, listRef: ref, ready: true, settled: true }),
			{ initialProps: { items: [item("a"), item("b"), item("c")] } }
		)

		expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, animated: true, viewPosition: 0.5 })

		// A size sort rebuilds the order as directory sizes land; the target moves.
		rerender({ items: [item("c"), item("a"), item("b")] })

		expect(scrollToIndex).toHaveBeenCalledTimes(2)
		expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 2, animated: true, viewPosition: 0.5 })

		await settleScroll()
	})

	it("waits for a still-loading listing and lands the scroll once the item arrives", async () => {
		params.current = { highlight: "b" }

		const { ref, scrollToIndex } = makeListRef()

		const { result, rerender } = renderHook(
			(props: { items: DriveItem[]; settled: boolean }) => useDriveHighlight({ ...props, listRef: ref, ready: true }),
			{ initialProps: { items: [] as DriveItem[], settled: false } }
		)

		expect(result.current).toBeNull()
		expect(scrollToIndex).not.toHaveBeenCalled()

		rerender({ items: [item("a"), item("b")], settled: true })

		expect(result.current).toBe("b")
		expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.5 })

		await settleScroll()
	})

	it("gives up on a target the settled listing does not contain, and stays given up", () => {
		params.current = { highlight: "gone" }

		const { ref, scrollToIndex } = makeListRef()

		const { result, rerender } = renderHook(
			(props: { items: DriveItem[] }) => useDriveHighlight({ ...props, listRef: ref, ready: true, settled: true }),
			{ initialProps: { items: [item("a")] } }
		)

		expect(result.current).toBeNull()

		// The item reappearing later (a socket update, a refetch) must NOT resurrect a highlight
		// the user has long since navigated past.
		rerender({ items: [item("a"), item("gone")] })

		expect(result.current).toBeNull()
		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("fires once — a later refetch of the same listing does not re-scroll or re-tint", async () => {
		params.current = { highlight: "a" }

		const { ref, scrollToIndex } = makeListRef()

		const { result, rerender } = renderHook(
			(props: { items: DriveItem[] }) => useDriveHighlight({ ...props, listRef: ref, ready: true, settled: true }),
			{ initialProps: { items: [item("a"), item("b")] } }
		)

		expect(result.current).toBe("a")

		await settleScroll()

		act(() => {
			vi.advanceTimersByTime(HIGHLIGHT_VISIBLE_MS)
		})

		expect(result.current).toBeNull()

		// Fresh array identity, same contents — what every refetch and socket patch produces.
		rerender({ items: [item("a"), item("b")] })

		expect(result.current).toBeNull()
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
	})
})
