import { describe, it, expect } from "vitest"
import { shouldDedupeNavigation, navigationKey, NAV_DEDUPE_WINDOW_MS } from "@/lib/navigationGuard"

describe("navigationKey", () => {
	it("is empty for a no-arg call (back / dismissAll)", () => {
		expect(navigationKey([])).toBe("")
	})

	it("is the href string for a string target", () => {
		expect(navigationKey(["/chat/abc"])).toBe("/chat/abc")
	})

	it("serializes an object target and ignores trailing args (e.g. navigation options)", () => {
		expect(navigationKey([{ pathname: "/note/[uuid]", params: { uuid: "x" } }, { animation: "none" }])).toBe(
			JSON.stringify({ pathname: "/note/[uuid]", params: { uuid: "x" } })
		)
	})
})

describe("shouldDedupeNavigation", () => {
	it("never dedupes when there is no previous call", () => {
		expect(shouldDedupeNavigation(null, { method: "push", key: "/a" }, 1000, NAV_DEDUPE_WINDOW_MS)).toBe(false)
	})

	it("dedupes an identical call within the window (double-tap / double-back)", () => {
		expect(
			shouldDedupeNavigation({ method: "push", key: "/a", atMs: 1000 }, { method: "push", key: "/a" }, 1100, NAV_DEDUPE_WINDOW_MS)
		).toBe(true)
	})

	it("does not dedupe once the window has elapsed", () => {
		expect(
			shouldDedupeNavigation(
				{ method: "push", key: "/a", atMs: 1000 },
				{ method: "push", key: "/a" },
				1000 + NAV_DEDUPE_WINDOW_MS,
				NAV_DEDUPE_WINDOW_MS
			)
		).toBe(false)
	})

	it("does not dedupe a different target (push A then push B)", () => {
		expect(
			shouldDedupeNavigation({ method: "push", key: "/a", atMs: 1000 }, { method: "push", key: "/b" }, 1100, NAV_DEDUPE_WINDOW_MS)
		).toBe(false)
	})

	it("does not dedupe a different method (push then back)", () => {
		expect(
			shouldDedupeNavigation({ method: "push", key: "/a", atMs: 1000 }, { method: "back", key: "" }, 1100, NAV_DEDUPE_WINDOW_MS)
		).toBe(false)
	})
})
