import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { isNarrowViewport, LAYOUT_BREAKPOINT_QUERY, subscribeToLayoutBreakpoint } from "@/features/shell/lib/breakpoints"

// One mutable fake for the whole file, stubbed before any import-time consumer runs: the module caches
// its MediaQueryList on first use ON PURPOSE (one query object app-wide), so a per-test stub would only
// ever be seen by whichever test happened to run first.
const listeners = new Map<string, Set<() => void>>()
const fakeMediaQuery = {
	matches: true,
	addEventListener: (type: string, listener: () => void) => {
		const set = listeners.get(type) ?? new Set<() => void>()

		set.add(listener)
		listeners.set(type, set)
	},
	removeEventListener: (type: string, listener: () => void) => {
		listeners.get(type)?.delete(listener)
	}
}

const matchMedia = vi.fn(() => fakeMediaQuery)

beforeAll(() => {
	vi.stubGlobal("window", { matchMedia })
})

afterAll(() => {
	vi.unstubAllGlobals()
})

describe("isNarrowViewport", () => {
	it("is false at or above the breakpoint and true below it", () => {
		fakeMediaQuery.matches = true

		expect(isNarrowViewport()).toBe(false)

		fakeMediaQuery.matches = false

		expect(isNarrowViewport()).toBe(true)
	})
})

describe("subscribeToLayoutBreakpoint", () => {
	it("registers a change listener and removes it on unsubscribe", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeToLayoutBreakpoint(listener)

		expect(listeners.get("change")?.has(listener)).toBe(true)

		unsubscribe()

		expect(listeners.get("change")?.has(listener)).toBe(false)
	})

	it("shares one MediaQueryList with every other consumer", () => {
		subscribeToLayoutBreakpoint(() => undefined)()
		isNarrowViewport()

		expect(matchMedia).toHaveBeenCalledTimes(1)
		expect(matchMedia).toHaveBeenCalledWith(LAYOUT_BREAKPOINT_QUERY)
	})
})
