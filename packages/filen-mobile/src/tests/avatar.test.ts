// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

// ─── Hoisted cn spy ───────────────────────────────────────────────────────────
//
// We intercept cn() to capture the computed class strings without needing to
// inspect DOM output (all native View components are mocked to return null).

const { cnSpy } = vi.hoisted(() => ({
	cnSpy: vi.fn((...args: (string | false | null | undefined)[]) => args.filter(Boolean).join(" "))
}))

// ─── Module boundary mocks ────────────────────────────────────────────────────

vi.mock("@filen/utils", () => ({
	cn: cnSpy
}))

vi.mock("@/components/ui/view", () => ({
	default: () => null
}))

vi.mock("@/components/ui/image", () => ({
	default: () => null
}))

vi.mock("@expo/vector-icons/Ionicons", () => ({
	default: () => null
}))

// useRecyclingState from flash-list — returns [initialValue, setter]
vi.mock("@shopify/flash-list", () => ({
	useRecyclingState: (init: unknown) => [init, vi.fn()]
}))

// useResolveClassNames — returns a resolved color token (used for icon tint)
vi.mock("uniwind", () => ({
	useResolveClassNames: () => ({ color: "#000000" })
}))

// ─── Import component under test (after mocks) ───────────────────────────────

import Avatar from "@/components/ui/avatar"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIVE_MINUTES_MS = 300_000

/**
 * Renders Avatar with the given lastActive value.
 * cn() calls are recorded by cnSpy; we inspect them afterwards.
 */
function renderAvatar(lastActive: number | undefined) {
	render(createElement(Avatar, { lastActive }))
}

/**
 * Returns the argument list from the cn() call for the presence dot View.
 * The dot View uniquely passes "size-3 absolute rounded-full z-100 bottom-0 right-0"
 * as its first positional class string.  The inner View (avatar circle) uses a
 * different class that does NOT start with "size-3".
 */
function dotCnCall(): (string | false | null | undefined)[] | undefined {
	for (const call of cnSpy.mock.calls) {
		if (typeof call[0] === "string" && call[0].startsWith("size-3")) {
			return call
		}
	}

	return undefined
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(BASE_TIME)
	cnSpy.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("Avatar presence dot — lastActive threshold logic", () => {
	it("renders no presence dot when lastActive is undefined (falsy guard)", () => {
		renderAvatar(undefined)

		// The dot View (which calls cn with 'rounded-full') must NOT have been rendered
		expect(dotCnCall()).toBeUndefined()
	})

	it("renders no presence dot when lastActive is 0 (falsy guard)", () => {
		renderAvatar(0)

		expect(dotCnCall()).toBeUndefined()
	})

	it("applies bg-green-500 when lastActive is 4 minutes ago (within 5-minute threshold)", () => {
		const fourMinutesAgo = BASE_TIME - 4 * 60 * 1000 // 240 000 ms ago

		renderAvatar(fourMinutesAgo)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-green-500")
		expect(callArgs).not.toContain("bg-gray-500")
	})

	it("applies bg-gray-500 when lastActive is 6 minutes ago (outside 5-minute threshold)", () => {
		const sixMinutesAgo = BASE_TIME - 6 * 60 * 1000 // 360 000 ms ago

		renderAvatar(sixMinutesAgo)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-gray-500")
		expect(callArgs).not.toContain("bg-green-500")
	})

	it("applies bg-green-500 when lastActive is exactly at threshold minus 1 ms (just inside)", () => {
		// lastActive = now - 299_999 → still within 5 minutes → green
		const justInside = BASE_TIME - (FIVE_MINUTES_MS - 1)

		renderAvatar(justInside)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-green-500")
	})

	it("applies bg-gray-500 when lastActive is exactly at threshold (not strictly greater)", () => {
		// lastActive = now - 300_000 → condition is lastActive > now - 300_000 → false → gray
		const exactlyAtThreshold = BASE_TIME - FIVE_MINUTES_MS

		renderAvatar(exactlyAtThreshold)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-gray-500")
	})

	it("dead inner guard: inner !lastActive check is unreachable but does not affect output (green for recent)", () => {
		// The source has: !props.lastActive ? false : props.lastActive > ... ? 'bg-green-500' : 'bg-gray-500'
		// Since the outer {props.lastActive && (...)} already gates, the inner !lastActive branch is dead.
		// A recent truthy lastActive must produce bg-green-500, not false.
		const oneSecondAgo = BASE_TIME - 1000

		renderAvatar(oneSecondAgo)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-green-500")
		// The dead inner guard must NOT have short-circuited to false
		expect(callArgs).not.toContain(false)
	})

	it("applies bg-green-500 for a very recent lastActive (just now)", () => {
		renderAvatar(BASE_TIME)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-green-500")
	})

	it("applies bg-gray-500 for a very old lastActive (1 hour ago)", () => {
		const oneHourAgo = BASE_TIME - 60 * 60 * 1000

		renderAvatar(oneHourAgo)

		const callArgs = dotCnCall()

		expect(callArgs).toBeDefined()
		expect(callArgs).toContain("bg-gray-500")
	})
})
