// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const h = vi.hoisted(() => {
	const listeners = new Set<(state: string) => void>()

	return {
		platform: { OS: "android" as "ios" | "android" },
		appState: {
			currentState: "active",
			addEventListener: (_type: string, handler: (state: string) => void) => {
				listeners.add(handler)

				return { remove: () => listeners.delete(handler) }
			}
		},
		listeners,
		cancelForegroundTransfers: vi.fn(),
		fgsRunning: { value: false }
	}
})

vi.mock("react-native", () => ({ Platform: h.platform, AppState: h.appState }))
vi.mock("@/features/transfers/transfers", () => ({ default: { cancelForegroundTransfers: h.cancelForegroundTransfers } }))
vi.mock("@/features/transfers/foregroundService", () => ({ default: { isRunning: () => h.fgsRunning.value } }))

import { render, cleanup, act } from "@testing-library/react"
import TransferLifecycle from "@/features/transfers/components/transferLifecycle"
import { RELOCK_SUPPRESSION_GRACE_MS, systemPresentation, useSystemPresentationStore } from "@/lib/systemPresentation"

function setAppState(state: string): void {
	h.appState.currentState = state

	for (const listener of h.listeners) {
		listener(state)
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	h.cancelForegroundTransfers.mockReset()
	h.platform.OS = "android"
	h.appState.currentState = "active"
	h.fgsRunning.value = false
	useSystemPresentationStore.setState({ activeCount: 0, lastEndedAt: 0 })
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("TransferLifecycle", () => {
	it("the notification-permission prompt does not cancel the first manual transfer on Android", () => {
		render(<TransferLifecycle />)

		act(() => {
			systemPresentation.begin()
			setAppState("background")
		})

		// The result lands before the app reports active again.
		act(() => systemPresentation.end())
		act(() => setAppState("active"))
		act(() => vi.advanceTimersByTime(RELOCK_SUPPRESSION_GRACE_MS))

		expect(h.cancelForegroundTransfers).not.toHaveBeenCalled()
	})

	it("a real background on Android still cancels", () => {
		render(<TransferLifecycle />)

		act(() => setAppState("background"))

		expect(h.cancelForegroundTransfers).toHaveBeenCalledOnce()
	})

	it("Android: still backgrounded once the presentation ends and its grace passes, the transfers are cancelled", () => {
		render(<TransferLifecycle />)

		act(() => {
			systemPresentation.begin()
			setAppState("background")
			systemPresentation.end()
		})

		act(() => vi.advanceTimersByTime(RELOCK_SUPPRESSION_GRACE_MS - 1))

		expect(h.cancelForegroundTransfers).not.toHaveBeenCalled()

		act(() => vi.advanceTimersByTime(1))

		expect(h.cancelForegroundTransfers).toHaveBeenCalledOnce()
	})

	it("Android: a presentation ending with no ignored background schedules nothing", () => {
		render(<TransferLifecycle />)

		act(() => {
			systemPresentation.begin()
			systemPresentation.end()
		})

		act(() => vi.advanceTimersByTime(RELOCK_SUPPRESSION_GRACE_MS))

		expect(h.cancelForegroundTransfers).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("iOS: a background during a presentation is real and cancels at once", () => {
		h.platform.OS = "ios"

		render(<TransferLifecycle />)

		act(() => {
			systemPresentation.begin()
			setAppState("background")
		})

		expect(h.cancelForegroundTransfers).toHaveBeenCalledOnce()

		act(() => systemPresentation.end())
		act(() => vi.advanceTimersByTime(RELOCK_SUPPRESSION_GRACE_MS))

		expect(h.cancelForegroundTransfers).toHaveBeenCalledOnce()
	})

	it("Android with the foreground service running never cancels", () => {
		h.fgsRunning.value = true

		render(<TransferLifecycle />)

		act(() => setAppState("background"))

		expect(h.cancelForegroundTransfers).not.toHaveBeenCalled()
	})
})
