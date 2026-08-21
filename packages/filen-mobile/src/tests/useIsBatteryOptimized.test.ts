// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Mock dependencies ───────────────────────────────────────────────────────

const batteryOptimizationMock = vi.hoisted(() => ({
	isRestricted: vi.fn<() => Promise<boolean>>()
}))

vi.mock("@/lib/batteryOptimization", () => ({ default: batteryOptimizationMock }))

// Captured so a test can drive the AppState transition the hook re-reads on.
const appStateListeners = vi.hoisted(() => ({ handlers: [] as ((state: string) => void)[], removed: 0 }))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: (_event: string, handler: (state: string) => void) => {
			appStateListeners.handlers.push(handler)

			return {
				remove: () => {
					appStateListeners.removed++
					appStateListeners.handlers = appStateListeners.handlers.filter(h => h !== handler)
				}
			}
		}
	}
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act, waitFor } from "@testing-library/react"
import useIsBatteryOptimized from "@/hooks/useIsBatteryOptimized"

beforeEach(() => {
	appStateListeners.handlers = []
	appStateListeners.removed = 0

	batteryOptimizationMock.isRestricted.mockReset()
	batteryOptimizationMock.isRestricted.mockResolvedValue(false)
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useIsBatteryOptimized", () => {
	it("starts false so no warning flashes before the first read resolves", () => {
		batteryOptimizationMock.isRestricted.mockResolvedValue(true)

		const { result } = renderHook(() => useIsBatteryOptimized())

		expect(result.current).toBe(false)
	})

	it("reports true once the read resolves restricted", async () => {
		batteryOptimizationMock.isRestricted.mockResolvedValue(true)

		const { result } = renderHook(() => useIsBatteryOptimized())

		await waitFor(() => expect(result.current).toBe(true))
	})

	it("stays false when the app is already allowlisted", async () => {
		batteryOptimizationMock.isRestricted.mockResolvedValue(false)

		const { result } = renderHook(() => useIsBatteryOptimized())

		await waitFor(() => expect(batteryOptimizationMock.isRestricted).toHaveBeenCalled())

		expect(result.current).toBe(false)
	})

	it("re-reads on foreground so the row self-dismisses after the user grants the exemption", async () => {
		// The whole point of the AppState listener: the only way to change this is to leave for system
		// settings and come back. Without the re-read the hint would still be showing after the fix.
		batteryOptimizationMock.isRestricted.mockResolvedValue(true)

		const { result } = renderHook(() => useIsBatteryOptimized())

		await waitFor(() => expect(result.current).toBe(true))

		batteryOptimizationMock.isRestricted.mockResolvedValue(false)

		await act(async () => {
			appStateListeners.handlers.forEach(handler => handler("active"))
		})

		await waitFor(() => expect(result.current).toBe(false))
	})

	it("ignores non-active AppState transitions", async () => {
		const { result } = renderHook(() => useIsBatteryOptimized())

		await waitFor(() => expect(batteryOptimizationMock.isRestricted).toHaveBeenCalledTimes(1))

		await act(async () => {
			appStateListeners.handlers.forEach(handler => handler("background"))
		})

		expect(batteryOptimizationMock.isRestricted).toHaveBeenCalledTimes(1)
		expect(result.current).toBe(false)
	})

	it("removes its listener on unmount", async () => {
		const { unmount } = renderHook(() => useIsBatteryOptimized())

		await waitFor(() => expect(appStateListeners.handlers.length).toBe(1))

		unmount()

		expect(appStateListeners.removed).toBe(1)
		expect(appStateListeners.handlers.length).toBe(0)
	})

	it("tolerates a read that only resolves after unmount", async () => {
		// Deliberately NOT asserting on a React warning: React 19 no longer warns on setState after
		// unmount, so that assertion would pass with or without the `alive` guard. What is assertable is
		// that a late resolve settles quietly — the listener is already gone, and nothing throws.
		let resolveRead: ((value: boolean) => void) | undefined = undefined

		batteryOptimizationMock.isRestricted.mockReturnValue(
			new Promise<boolean>(resolve => {
				resolveRead = resolve
			})
		)

		const { unmount } = renderHook(() => useIsBatteryOptimized())

		unmount()

		expect(appStateListeners.handlers.length).toBe(0)

		await expect(
			act(async () => {
				resolveRead?.(true)
			})
		).resolves.toBeUndefined()
	})
})
