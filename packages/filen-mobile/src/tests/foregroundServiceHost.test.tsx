// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => {
	const appStateListeners = new Set<(state: string) => void>()
	const requestListeners = new Set<() => void>()

	return {
		appState: {
			currentState: "active",
			addEventListener: (_type: string, handler: (state: string) => void) => {
				appStateListeners.add(handler)

				return { remove: () => appStateListeners.delete(handler) }
			}
		},
		appStateListeners,
		requestListeners,
		requested: { value: false },
		push: vi.fn(),
		fgs: {
			isRunning: vi.fn(() => false),
			start: vi.fn(async () => {}),
			update: vi.fn(async () => {}),
			stop: vi.fn(async () => {})
		}
	}
})

vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: h.appState }))
vi.mock("@/lib/secureStore", () => ({ useSecureStore: () => [false] }))
vi.mock("@/lib/router", () => ({ router: { push: h.push } }))
vi.mock("@/features/copy/copyRowText", () => ({ copyingItemCount: () => null }))
vi.mock("@/features/transfers/foregroundService", () => ({
	TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY: "k",
	DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED: true,
	default: {
		...h.fgs,
		consumeOpenTransfersRequest: () => {
			const requested = h.requested.value

			h.requested.value = false

			return requested
		},
		onOpenTransfersRequest: (listener: () => void) => {
			h.requestListeners.add(listener)

			return () => h.requestListeners.delete(listener)
		}
	}
}))

import { render, cleanup, act } from "@testing-library/react"
import ForegroundService from "@/features/transfers/components/foregroundService"
import useAppStore from "@/stores/useApp.store"

function tap(): void {
	h.requested.value = true

	for (const listener of h.requestListeners) {
		listener()
	}
}

function setAppState(state: string): void {
	h.appState.currentState = state

	for (const listener of h.appStateListeners) {
		listener(state)
	}
}

beforeEach(() => {
	h.push.mockReset()
	h.requested.value = false
	h.appState.currentState = "active"
	useAppStore.setState({ biometricUnlocked: true, pathname: "/tabs/drive" })
})

afterEach(() => {
	cleanup()
})

describe("a tap on the transfers notification", () => {
	it("opens Transfers when the app is unlocked and active", () => {
		render(<ForegroundService />)

		act(() => tap())

		expect(h.push).toHaveBeenCalledExactlyOnceWith("/transfers")
		expect(h.requested.value).toBe(false)
	})

	it("waits for the app to come forward", () => {
		h.appState.currentState = "background"

		render(<ForegroundService />)

		act(() => tap())

		expect(h.push).not.toHaveBeenCalled()

		act(() => setAppState("active"))

		expect(h.push).toHaveBeenCalledExactlyOnceWith("/transfers")
	})

	it("waits for the biometric lock to clear", () => {
		useAppStore.setState({ biometricUnlocked: false })

		render(<ForegroundService />)

		act(() => tap())

		expect(h.push).not.toHaveBeenCalled()

		act(() => useAppStore.setState({ biometricUnlocked: true }))

		expect(h.push).toHaveBeenCalledExactlyOnceWith("/transfers")
	})

	it("does not push a second Transfers screen", () => {
		useAppStore.setState({ pathname: "/transfers" })

		render(<ForegroundService />)

		act(() => tap())

		expect(h.push).not.toHaveBeenCalled()
		expect(h.requested.value).toBe(false)
	})

	it("a tap recorded before mount is honoured once ready", () => {
		h.requested.value = true

		render(<ForegroundService />)

		expect(h.push).toHaveBeenCalledExactlyOnceWith("/transfers")
	})
})
