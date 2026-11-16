import { afterEach, describe, expect, test, vi } from "vitest"
import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"

afterEach(() => {
	vi.useRealTimers()
})

describe("scheduleIdle", () => {
	test("runs through requestIdleCallback with the timeout, and cancels it", () => {
		const request = vi.fn((_run: IdleRequestCallback, _options?: IdleRequestOptions) => 7)
		const cancel = vi.fn()

		vi.stubGlobal("requestIdleCallback", request)
		vi.stubGlobal("cancelIdleCallback", cancel)

		const run = vi.fn()
		const stop = scheduleIdle(run, { timeout: 200, fallbackMs: 16 })

		expect(request).toHaveBeenCalledWith(run, { timeout: 200 })

		stop()

		expect(cancel).toHaveBeenCalledWith(7)
	})

	test("passes no options when no timeout is asked", () => {
		const request = vi.fn((_run: IdleRequestCallback, _options?: IdleRequestOptions) => 1)

		vi.stubGlobal("requestIdleCallback", request)
		vi.stubGlobal("cancelIdleCallback", vi.fn())

		scheduleIdle(() => undefined)

		expect(request).toHaveBeenCalledWith(expect.any(Function), undefined)
	})

	test("falls back to a timer of fallbackMs, and cancels it", () => {
		vi.useFakeTimers()
		vi.stubGlobal("requestIdleCallback", undefined)

		const run = vi.fn()

		scheduleIdle(run, { fallbackMs: 2000 })
		vi.advanceTimersByTime(1999)

		expect(run).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)

		expect(run).toHaveBeenCalledOnce()

		const cancelled = vi.fn()
		const stop = scheduleIdle(cancelled, { fallbackMs: 10 })

		stop()
		vi.advanceTimersByTime(10)

		expect(cancelled).not.toHaveBeenCalled()
	})
})
