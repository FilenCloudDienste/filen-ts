import { beforeEach, describe, expect, it, vi } from "vitest"
import { isNarrowViewport, LAYOUT_BREAKPOINT_QUERY, subscribeToLayoutBreakpoint } from "@/features/shell/lib/breakpoints"

// One mutable fake for the whole file. The module caches its MediaQueryList on first use ON PURPOSE
// (one query object app-wide), so the cache — not the stub — is what outlives a test here: whichever
// test runs first pays the single real matchMedia call and the rest read the cached object.
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

// Per test, not once for the file: vitest.config.ts sets `unstubGlobals`, so every stub is torn down
// after each test. Re-stubbing here is what makes that isolation free rather than something this file
// has to opt out of.
beforeEach(() => {
	vi.stubGlobal("window", { matchMedia })
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

	// Against a FRESH module graph, so the count belongs to this test. The cached MediaQueryList means
	// the only real matchMedia call in this file otherwise belongs to whichever test ran first — so an
	// absolute `toHaveBeenCalledTimes(1)` here pinned file order rather than the sharing invariant, and
	// read as zero the moment mock state was cleared per test.
	it("shares one MediaQueryList with every other consumer", async () => {
		vi.resetModules()

		const fresh = await import("@/features/shell/lib/breakpoints")
		const before = matchMedia.mock.calls.length

		fresh.subscribeToLayoutBreakpoint(() => undefined)()
		fresh.isNarrowViewport()

		// Two consumers, one construction: that IS the invariant.
		expect(matchMedia.mock.calls.length).toBe(before + 1)
		expect(matchMedia).toHaveBeenLastCalledWith(LAYOUT_BREAKPOINT_QUERY)
	})
})
