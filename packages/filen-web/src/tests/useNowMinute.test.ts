// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest"
import { renderHook, act, cleanup } from "@testing-library/react"
import { minuteStamp, useNowMinute } from "@/lib/useNowMinute"

const MINUTE_MS = 60_000
// A minute-aligned instant, so every expectation below reads as a plain offset from it.
const BASE = 1_700_000_040_000

afterEach(() => {
	// Explicit (this suite runs without vitest globals, so RTL registers no auto-cleanup): the hook's
	// timer is shared module state, and it must be torn down while the fake clock is still installed.
	cleanup()
	vi.useRealTimers()
})

describe("minuteStamp", () => {
	it("truncates to the minute", () => {
		expect(minuteStamp(BASE + 2_123)).toBe(BASE)
	})

	it("leaves an exact minute boundary untouched", () => {
		expect(minuteStamp(BASE)).toBe(BASE)
	})

	it("is stable for every instant within the same minute", () => {
		const boundary = minuteStamp(Date.now())

		expect(minuteStamp(boundary + 1)).toBe(boundary)
		expect(minuteStamp(boundary + MINUTE_MS - 1)).toBe(boundary)
		expect(minuteStamp(boundary + MINUTE_MS)).not.toBe(boundary)
	})
})

describe("useNowMinute", () => {
	it("returns the current time truncated to the minute", () => {
		vi.useFakeTimers()
		vi.setSystemTime(BASE + 2_123)

		const { result } = renderHook(() => useNowMinute())

		expect(result.current).toBe(BASE)
	})

	// The whole point of the hook: the value a render reads must not move until the minute does, or a
	// memoized derivation keyed on it either never hits or freezes at whatever it first captured.
	it("does not change within the same minute", () => {
		vi.useFakeTimers()
		vi.setSystemTime(BASE)

		const { result } = renderHook(() => useNowMinute())
		const first = result.current

		act(() => {
			vi.advanceTimersByTime(MINUTE_MS - 1)
		})

		expect(result.current).toBe(first)
	})

	it("advances once the wall clock crosses the next minute boundary", () => {
		vi.useFakeTimers()
		vi.setSystemTime(BASE + 2_123)

		const { result } = renderHook(() => useNowMinute())

		expect(result.current).toBe(BASE)

		act(() => {
			vi.advanceTimersByTime(MINUTE_MS)
		})

		expect(result.current).toBe(BASE + MINUTE_MS)
	})

	// One minute at a time: a single scheduled timeout would satisfy a single 3-minute jump (the snapshot
	// is re-read after the whole jump), so each minute is asserted on its own tick.
	it("keeps ticking every minute while subscribed, and schedules nothing once unsubscribed", () => {
		vi.useFakeTimers()
		vi.setSystemTime(BASE)

		const { result, unmount } = renderHook(() => useNowMinute())

		for (const minute of [1, 2, 3]) {
			act(() => {
				vi.advanceTimersByTime(MINUTE_MS)
			})

			expect(result.current).toBe(BASE + minute * MINUTE_MS)
		}

		expect(vi.getTimerCount()).toBe(1)

		unmount()

		expect(vi.getTimerCount()).toBe(0)
	})
})
