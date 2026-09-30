// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react"
import { AppState } from "react-native"
import useDeviceDiskSpace from "@/hooks/useDeviceDiskSpace"
import { Paths } from "@/tests/mocks/expoFileSystem"

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Override the availableDiskSpace getter for a single test.
function overrideAvailableDiskSpace(value: number) {
	const original = Object.getOwnPropertyDescriptor(Paths, "availableDiskSpace")

	Object.defineProperty(Paths, "availableDiskSpace", {
		get: () => value,
		configurable: true
	})

	return () => {
		if (original) {
			Object.defineProperty(Paths, "availableDiskSpace", original)
		}
	}
}

beforeEach(() => {
	// Restore Paths defaults by re-defining with original values
	Object.defineProperty(Paths, "availableDiskSpace", {
		get: () => 128 * 1024 * 1024 * 1024,
		configurable: true
	})
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useDeviceDiskSpace / readAvailableDiskSpace", () => {
	it("returns the default mock value: 128 GB available", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		expect(result.current).toBe(128 * 1024 * 1024 * 1024)
	})

	it("returns availableBytes=0 when availableDiskSpace is NaN", () => {
		const restore = overrideAvailableDiskSpace(NaN)

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			expect(result.current).toBe(0)
		} finally {
			restore()
		}
	})

	it("returns availableBytes=0 when availableDiskSpace is Infinity (not finite)", () => {
		const restore = overrideAvailableDiskSpace(Infinity)

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			expect(result.current).toBe(0)
		} finally {
			restore()
		}
	})

	it("returns availableBytes=0 when availableDiskSpace is -1 (negative but finite)", () => {
		const restore = overrideAvailableDiskSpace(-1)

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			// Math.max(0, -1) === 0
			expect(result.current).toBe(0)
		} finally {
			restore()
		}
	})
})

// ─── AppState reactive update (findings #19, #195) ───────────────────────────

describe("useDeviceDiskSpace / AppState reactive update", () => {
	// Capture the change-handler that the hook registers so we can fire fake events
	let capturedHandler: ((state: string) => void) | null = null
	let removeSpy: ReturnType<typeof vi.fn>
	let addEventListenerSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		capturedHandler = null
		removeSpy = vi.fn()

		addEventListenerSpy = vi.spyOn(AppState, "addEventListener").mockImplementation(((
			_type: string,
			handler: (state: string) => void
		) => {
			capturedHandler = handler

			return { remove: removeSpy }
		}) as unknown as typeof AppState.addEventListener)
	})

	afterEach(() => {
		addEventListenerSpy.mockRestore()
	})

	it("re-reads disk space when AppState transitions to 'active'", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		// Initial values
		expect(result.current).toBe(128 * 1024 * 1024 * 1024)

		// Change the underlying Paths values before simulating foreground resume
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => 64 * 1024 * 1024 * 1024,
			configurable: true
		})

		// Fire the 'active' event from AppState
		act(() => {
			capturedHandler?.("active")
		})

		expect(result.current).toBe(64 * 1024 * 1024 * 1024)
	})

	it("does NOT update disk space when AppState transitions to 'background'", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		const initialAvailable = result.current

		// Change underlying values
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => 10 * 1024 * 1024 * 1024,
			configurable: true
		})

		// Fire 'background' — should NOT trigger re-read
		act(() => {
			capturedHandler?.("background")
		})

		expect(result.current).toBe(initialAvailable)
	})

	it("does NOT update disk space when AppState transitions to 'inactive'", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		const initialAvailable = result.current

		// Change underlying values
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => 20 * 1024 * 1024 * 1024,
			configurable: true
		})

		// Fire 'inactive' — should NOT trigger re-read
		act(() => {
			capturedHandler?.("inactive")
		})

		expect(result.current).toBe(initialAvailable)
	})

	it("calls subscription.remove() when the hook unmounts (cleanup)", () => {
		const { unmount } = renderHook(() => useDeviceDiskSpace())

		expect(removeSpy).not.toHaveBeenCalled()

		unmount()

		expect(removeSpy).toHaveBeenCalledTimes(1)
	})

	it("registers the listener with event type 'change'", () => {
		renderHook(() => useDeviceDiskSpace())

		expect(addEventListenerSpy).toHaveBeenCalledWith("change", expect.any(Function))
	})
})
