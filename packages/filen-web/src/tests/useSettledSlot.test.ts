// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useSettledSlot } from "@/features/preview/hooks/useSettledSlot"

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("useSettledSlot", () => {
	it("mounts the first slot and an isolated step at once", () => {
		const { result, rerender } = renderHook(({ slot }: { slot: string }) => useSettledSlot(slot), { initialProps: { slot: "a" } })

		expect(result.current).toBe(true)

		vi.advanceTimersByTime(1_000)
		rerender({ slot: "b" })

		expect(result.current).toBe(true)
	})

	// A held arrow key: only the slot it stops on ever mounts.
	it("holds back slots stepped through in a run until one stays current", () => {
		const { result, rerender } = renderHook(({ slot }: { slot: string }) => useSettledSlot(slot), { initialProps: { slot: "a" } })

		vi.advanceTimersByTime(1_000)
		rerender({ slot: "b" })
		vi.advanceTimersByTime(30)
		rerender({ slot: "c" })

		expect(result.current).toBe(false)

		vi.advanceTimersByTime(30)
		rerender({ slot: "d" })

		expect(result.current).toBe(false)

		act(() => {
			vi.advanceTimersByTime(150)
		})

		expect(result.current).toBe(true)
	})
})
