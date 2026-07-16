import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// The guarded router wraps expo-router's `router`; capture the underlying push so we can assert how many
// times a burst of taps actually reaches expo-router after dedupe.
const { mockPush } = vi.hoisted(() => ({
	mockPush: vi.fn()
}))

vi.mock("expo-router", () => ({
	router: {
		push: mockPush
	}
}))

// router.ts keys its dedupe window off performance.now(); drive it deterministically.
let fakeNow = 0

describe("router dedupe window (stateful makeGuardedMethod)", () => {
	beforeEach(() => {
		vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
		mockPush.mockClear()
		fakeNow = 0
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("collapses a sustained identical triple-tap into ONE navigation even when it outlasts the window", async () => {
		// Fresh module so lastNavigation starts null.
		vi.resetModules()
		const { router } = await import("@/lib/router")

		// Triple-tap the same target at 300ms cadence — total span 600ms > NAV_DEDUPE_WINDOW_MS (500).
		fakeNow = 0
		router.push("/drive/x")
		fakeNow = 300
		router.push("/drive/x")
		fakeNow = 600
		router.push("/drive/x")

		// The window must slide to each tap, so the whole burst is a single navigation. Before the fix the
		// 3rd tap (600ms from the first ACCEPTED nav, window frozen at t=0) escaped the window and pushed a
		// duplicate → 2 calls.
		expect(mockPush).toHaveBeenCalledTimes(1)
		expect(mockPush).toHaveBeenCalledWith("/drive/x")
	})

	it("still navigates again once the user pauses longer than the window", async () => {
		vi.resetModules()
		const { router } = await import("@/lib/router")

		fakeNow = 0
		router.push("/drive/x")
		fakeNow = 300
		router.push("/drive/x")

		// 500ms+ of silence since the last tap → a genuine new navigation is allowed.
		fakeNow = 300 + 500
		router.push("/drive/x")

		expect(mockPush).toHaveBeenCalledTimes(2)
	})

	it("does not dedupe distinct rapid targets (push A then push B)", async () => {
		vi.resetModules()
		const { router } = await import("@/lib/router")

		fakeNow = 0
		router.push("/a")
		fakeNow = 100
		router.push("/b")

		expect(mockPush).toHaveBeenCalledTimes(2)
	})
})
