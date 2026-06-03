// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
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
