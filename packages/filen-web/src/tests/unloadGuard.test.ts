// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { allowNextUnload, blockUnloadUnlessAllowed, consumeUnloadAllowance, hasUnloadHold, holdUnload } from "@/lib/unloadGuard"

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

// Whether a beforeunload dispatched now would make the browser ask before leaving.
function unloadIsBlocked(): boolean {
	const event = new Event("beforeunload", { cancelable: true })

	window.dispatchEvent(event)

	return event.defaultPrevented
}

describe("holdUnload", () => {
	it("blocks while held and stops once every hold is released", () => {
		const first = holdUnload()
		const second = holdUnload()

		expect(unloadIsBlocked()).toBe(true)

		first()

		expect(unloadIsBlocked()).toBe(true)

		second()

		expect(unloadIsBlocked()).toBe(false)
	})

	// A download started while an editor is dirty and a transfer runs: both hold, and neither may ask.
	it("lets one allowed navigation through every hold at once", () => {
		const release = [holdUnload(), holdUnload()]

		allowNextUnload()

		expect(unloadIsBlocked()).toBe(false)
		expect(unloadIsBlocked()).toBe(true)

		for (const releaseHold of release) {
			releaseHold()
		}
	})

	it("counts a released hold only once", () => {
		const first = holdUnload()
		const second = holdUnload()

		first()
		first()

		expect(unloadIsBlocked()).toBe(true)

		second()
	})
})

describe("hasUnloadHold", () => {
	it("tracks whether any hold is outstanding", () => {
		expect(hasUnloadHold()).toBe(false)

		const first = holdUnload()
		const second = holdUnload()

		expect(hasUnloadHold()).toBe(true)
		first()
		expect(hasUnloadHold()).toBe(true)
		second()
		expect(hasUnloadHold()).toBe(false)
	})
})
