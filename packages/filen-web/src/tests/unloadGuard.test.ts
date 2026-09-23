import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { allowNextUnload, blockUnloadUnlessAllowed, consumeUnloadAllowance } from "@/lib/unloadGuard"

function fakeEvent() {
	return { preventDefault: vi.fn() }
}

beforeEach(() => {
	vi.useFakeTimers()
	consumeUnloadAllowance()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("unload allowance", () => {
	it("is off by default", () => {
		expect(consumeUnloadAllowance()).toBe(false)
	})

	it("excuses exactly one unload", () => {
		allowNextUnload()

		expect(consumeUnloadAllowance()).toBe(true)
		expect(consumeUnloadAllowance()).toBe(false)
	})

	it("expires, so it can't excuse a later close of the tab", () => {
		allowNextUnload()
		vi.advanceTimersByTime(2_001)

		expect(consumeUnloadAllowance()).toBe(false)
	})
})

describe("blockUnloadUnlessAllowed", () => {
	it("asks the browser to confirm leaving", () => {
		const event = fakeEvent()

		blockUnloadUnlessAllowed(event)

		expect(event.preventDefault).toHaveBeenCalledTimes(1)
	})

	it("lets an allowed navigation through once, then blocks again", () => {
		const allowed = fakeEvent()
		const next = fakeEvent()

		allowNextUnload()
		blockUnloadUnlessAllowed(allowed)
		blockUnloadUnlessAllowed(next)

		expect(allowed.preventDefault).not.toHaveBeenCalled()
		expect(next.preventDefault).toHaveBeenCalledTimes(1)
	})
})
