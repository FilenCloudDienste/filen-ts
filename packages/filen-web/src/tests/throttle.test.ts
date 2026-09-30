import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { throttle } from "@/lib/throttle"

describe("throttle", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("invokes immediately on the first call (leading edge)", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)

		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith(1)
	})

	it("buffers calls inside the window instead of invoking immediately", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		throttled(2)

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("delivers only the FINAL buffered value at the trailing edge", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		throttled(2)
		throttled(3)
		vi.advanceTimersByTime(100)

		expect(fn).toHaveBeenCalledTimes(2)
		expect(fn).toHaveBeenNthCalledWith(2, 3)
	})

	it("does not fire a trailing call when nothing happened after the leading edge", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		vi.advanceTimersByTime(100)

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("starts a fresh leading cycle once the window fully elapses with no pending call", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		vi.advanceTimersByTime(100)
		throttled(2)

		expect(fn).toHaveBeenCalledTimes(2)
		expect(fn).toHaveBeenNthCalledWith(2, 2)
	})

	it("keeps throttling across repeated windows (leading+trailing pair per window)", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1) // t=0, leading, fires with 1
		throttled(2) // t=0, buffered
		vi.advanceTimersByTime(100) // t=100, trailing fires with 2

		vi.advanceTimersByTime(100) // t=200, window fully elapsed, nothing pending

		throttled(3) // t=200, fresh leading, fires immediately with 3
		throttled(4) // t=200, buffered
		vi.advanceTimersByTime(100) // t=300, trailing fires with 4

		expect(fn.mock.calls).toEqual([[1], [2], [3], [4]])
	})

	it("flush delivers the pending value now and cancels the trailing call", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		throttled(2)
		throttled(3)
		throttled.flush()

		expect(fn.mock.calls).toEqual([[1], [3]])

		vi.advanceTimersByTime(100)

		expect(fn).toHaveBeenCalledTimes(2)
	})

	it("flush is a no-op when nothing is pending", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled.flush()
		throttled(1)
		throttled.flush()

		expect(fn.mock.calls).toEqual([[1]])
	})

	it("keeps throttling from the flushed call", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		vi.advanceTimersByTime(50)
		throttled(2)
		throttled.flush() // t=50, fires with 2
		throttled(3) // inside the window restarted by the flush
		vi.advanceTimersByTime(99)

		expect(fn.mock.calls).toEqual([[1], [2]])

		vi.advanceTimersByTime(1)

		expect(fn.mock.calls).toEqual([[1], [2], [3]])
	})

	it("works with bigint args (the real onProgress shape)", () => {
		const fn = vi.fn<(bytes: bigint) => void>()
		const throttled = throttle(fn, 100)

		throttled(10n)
		throttled(20n)
		vi.advanceTimersByTime(100)

		expect(fn.mock.calls).toEqual([[10n], [20n]])
	})
})
