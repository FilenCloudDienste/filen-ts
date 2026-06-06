// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react"
import { AppState } from "react-native"
import useDeviceDiskSpace from "@/hooks/useDeviceDiskSpace"
import { Paths } from "@/tests/mocks/expoFileSystem"

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Override Paths getters for a single test by replacing them on the mock object.
function overridePaths(overrides: { availableDiskSpace?: number; totalDiskSpace?: number }) {
	const original = {
		availableDiskSpace: Object.getOwnPropertyDescriptor(Paths, "availableDiskSpace"),
		totalDiskSpace: Object.getOwnPropertyDescriptor(Paths, "totalDiskSpace")
	}

	if (overrides.availableDiskSpace !== undefined) {
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => overrides.availableDiskSpace,
			configurable: true
		})
	}

	if (overrides.totalDiskSpace !== undefined) {
		Object.defineProperty(Paths, "totalDiskSpace", {
			get: () => overrides.totalDiskSpace,
			configurable: true
		})
	}

	return () => {
		if (original.availableDiskSpace) {
			Object.defineProperty(Paths, "availableDiskSpace", original.availableDiskSpace)
		}

		if (original.totalDiskSpace) {
			Object.defineProperty(Paths, "totalDiskSpace", original.totalDiskSpace)
		}
	}
}

beforeEach(() => {
	// Restore Paths defaults by re-defining with original values
	Object.defineProperty(Paths, "availableDiskSpace", {
		get: () => 128 * 1024 * 1024 * 1024,
		configurable: true
	})

	Object.defineProperty(Paths, "totalDiskSpace", {
		get: () => 256 * 1024 * 1024 * 1024,
		configurable: true
	})
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useDeviceDiskSpace / readDiskSpace", () => {
	it("returns default mock values: 128 GB available and 256 GB total", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		expect(result.current.availableBytes).toBe(128 * 1024 * 1024 * 1024)
		expect(result.current.totalBytes).toBe(256 * 1024 * 1024 * 1024)
	})

	it("returns availableBytes=0 when availableDiskSpace is NaN", () => {
		const restore = overridePaths({ availableDiskSpace: NaN })

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			expect(result.current.availableBytes).toBe(0)
		} finally {
			restore()
		}
	})

	it("returns availableBytes=0 when availableDiskSpace is Infinity (not finite)", () => {
		const restore = overridePaths({ availableDiskSpace: Infinity })

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			expect(result.current.availableBytes).toBe(0)
		} finally {
			restore()
		}
	})

	it("returns availableBytes=0 when availableDiskSpace is -1 (negative but finite)", () => {
		const restore = overridePaths({ availableDiskSpace: -1 })

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			// Math.max(0, -1) === 0
			expect(result.current.availableBytes).toBe(0)
		} finally {
			restore()
		}
	})

	it("returns totalBytes=0 when totalDiskSpace is NaN", () => {
		const restore = overridePaths({ totalDiskSpace: NaN })

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			expect(result.current.totalBytes).toBe(0)
		} finally {
			restore()
		}
	})

	it("returns totalBytes=0 when totalDiskSpace is 0", () => {
		const restore = overridePaths({ totalDiskSpace: 0 })

		try {
			const { result } = renderHook(() => useDeviceDiskSpace())

			// Math.max(0, 0) === 0, and Number.isFinite(0) is true so branch takes the Math.max path
			expect(result.current.totalBytes).toBe(0)
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
		expect(result.current.availableBytes).toBe(128 * 1024 * 1024 * 1024)
		expect(result.current.totalBytes).toBe(256 * 1024 * 1024 * 1024)

		// Change the underlying Paths values before simulating foreground resume
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => 64 * 1024 * 1024 * 1024,
			configurable: true
		})

		Object.defineProperty(Paths, "totalDiskSpace", {
			get: () => 512 * 1024 * 1024 * 1024,
			configurable: true
		})

		// Fire the 'active' event from AppState
		act(() => {
			capturedHandler?.("active")
		})

		expect(result.current.availableBytes).toBe(64 * 1024 * 1024 * 1024)
		expect(result.current.totalBytes).toBe(512 * 1024 * 1024 * 1024)
	})

	it("does NOT update disk space when AppState transitions to 'background'", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		const initialAvailable = result.current.availableBytes
		const initialTotal = result.current.totalBytes

		// Change underlying values
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => 10 * 1024 * 1024 * 1024,
			configurable: true
		})

		// Fire 'background' — should NOT trigger re-read
		act(() => {
			capturedHandler?.("background")
		})

		expect(result.current.availableBytes).toBe(initialAvailable)
		expect(result.current.totalBytes).toBe(initialTotal)
	})

	it("does NOT update disk space when AppState transitions to 'inactive'", () => {
		const { result } = renderHook(() => useDeviceDiskSpace())

		const initialAvailable = result.current.availableBytes
		const initialTotal = result.current.totalBytes

		// Change underlying values
		Object.defineProperty(Paths, "availableDiskSpace", {
			get: () => 20 * 1024 * 1024 * 1024,
			configurable: true
		})

		// Fire 'inactive' — should NOT trigger re-read
		act(() => {
			capturedHandler?.("inactive")
		})

		expect(result.current.availableBytes).toBe(initialAvailable)
		expect(result.current.totalBytes).toBe(initialTotal)
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
