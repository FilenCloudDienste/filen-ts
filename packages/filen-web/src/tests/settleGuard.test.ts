import { describe, expect, it, vi } from "vitest"
import { settleGuard } from "@/lib/workers/settleGuard"

describe("settleGuard", () => {
	it("passes calls on, with their arguments, until settled", () => {
		const fn = vi.fn<(at: number, count: number, first: number) => void>()
		const guard = settleGuard(fn)

		guard.callback(1, 2, 3)
		guard.callback(4, 5, 6)

		expect(fn).toHaveBeenCalledTimes(2)
		expect(fn).toHaveBeenLastCalledWith(4, 5, 6)
	})

	it("drops a call that arrives after the settle", () => {
		const fn = vi.fn<(progress: number) => void>()
		const guard = settleGuard(fn)

		guard.callback(1)
		guard.settle()
		guard.callback(2)

		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn.mock.calls[0]?.[0]).toBe(1)
	})

	it("settles idempotently, and a callback taking nothing is dropped too", () => {
		const fn = vi.fn<() => void>()
		const guard = settleGuard(fn)

		guard.settle()
		guard.settle()
		guard.callback()

		expect(fn).not.toHaveBeenCalled()
	})
})
