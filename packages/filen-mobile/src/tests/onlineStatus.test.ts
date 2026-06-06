import { vi, describe, it, expect, beforeEach } from "vitest"

// onlineStatus.ts does not export computeOnline directly.
// We test the logic by:
//   1. Mocking NetInfo.addEventListener to capture the state-change callback.
//   2. Importing the module (which registers the callback at module init time).
//   3. Calling the captured callback with various NetInfoState shapes.
//   4. Asserting what value onlineManager.setOnline receives.
//
// This exercises every branch of computeOnline without requiring the function to be exported.
//
// Additionally, the AppState 'change' -> NetInfo.refresh() branch is exercised by
// capturing the AppState handler via the hoisted mock and simulating transitions.

const { mockSetOnline, mockSetEventListener, capturedListeners, mockAppState, mockNetInfoRefresh } = vi.hoisted(() => {
	const mockSetOnline = vi.fn()
	const capturedListeners: ((state: object) => void)[] = []
	const mockNetInfoRefresh = vi.fn().mockResolvedValue(undefined)

	const mockSetEventListener = vi.fn((factory: (setOnline: (online: boolean) => void) => () => void) => {
		factory(mockSetOnline)
	})

	// AppState mock that captures all 'change' handlers registered at module init time
	const capturedChangeHandlers: ((nextState: string) => void)[] = []
	const mockAppState = {
		addEventListener: vi.fn((type: string, handler: (nextState: string) => void) => {
			if (type === "change") {
				capturedChangeHandlers.push(handler)
			}

			return { remove: () => {} }
		}),
		emit: (nextState: string) => {
			for (const h of capturedChangeHandlers) {
				h(nextState)
			}
		},
		_capturedChangeHandlers: capturedChangeHandlers
	}

	return { mockSetOnline, mockSetEventListener, capturedListeners, mockAppState, mockNetInfoRefresh }
})

vi.mock("@react-native-community/netinfo", () => ({
	default: {
		addEventListener: vi.fn(listener => {
			capturedListeners.push(listener as (state: object) => void)

			return () => {}
		}),
		refresh: mockNetInfoRefresh
	}
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		setOnline: mockSetOnline,
		setEventListener: mockSetEventListener
	}
}))

vi.mock("react-native", () => ({
	AppState: mockAppState,
	Platform: {
		OS: "ios",
		select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
			return specifics["ios"] ?? specifics["default"]
		}
	}
}))

// Import the module — this triggers two top-level side-effects:
//   1. onlineManager.setEventListener(factory) — our mock calls factory(mockSetOnline),
//      which internally calls NetInfo.addEventListener. The registered callback
//      calls mockSetOnline(computeOnline(state)).
//   2. A direct NetInfo.addEventListener that also calls onlineManager.setOnline.
import "@/queries/onlineStatus"

// ─── helpers ─────────────────────────────────────────────────────────────────

type PartialNetInfoState = {
	isConnected: boolean | null
	isInternetReachable: boolean | null
}

function simulateNetInfo(state: PartialNetInfoState): void {
	// We use the listener registered by onlineManager.setEventListener factory,
	// which is the first listener added by the module (from the factory call
	// inside setEventListener). Both registered listeners call the same
	// computeOnline logic, so we use the last one registered (direct call).
	const listener = capturedListeners[capturedListeners.length - 1]

	if (!listener) {
		throw new Error("NetInfo listener was not registered by onlineStatus module")
	}

	mockSetOnline.mockClear()
	listener(state)
}

// ─── computeOnline branch tests ───────────────────────────────────────────────

describe("onlineStatus computeOnline (via NetInfo listener)", () => {
	it("returns true when isConnected=true, isInternetReachable=true", () => {
		simulateNetInfo({ isConnected: true, isInternetReachable: true })

		expect(mockSetOnline).toHaveBeenCalledWith(true)
	})

	it("returns false when isConnected=false, isInternetReachable=true (short-circuit on isConnected)", () => {
		simulateNetInfo({ isConnected: false, isInternetReachable: true })

		expect(mockSetOnline).toHaveBeenCalledWith(false)
	})

	it("returns false when isConnected=true, isInternetReachable=false", () => {
		simulateNetInfo({ isConnected: true, isInternetReachable: false })

		expect(mockSetOnline).toHaveBeenCalledWith(false)
	})

	it("returns true when isConnected=null, isInternetReachable=true (null treated as unknown/connected)", () => {
		simulateNetInfo({ isConnected: null, isInternetReachable: true })

		expect(mockSetOnline).toHaveBeenCalledWith(true)
	})

	it("returns true when isConnected=true, isInternetReachable=null (null treated as reachable)", () => {
		simulateNetInfo({ isConnected: true, isInternetReachable: null })

		expect(mockSetOnline).toHaveBeenCalledWith(true)
	})

	it("returns false when isConnected=false, isInternetReachable=false", () => {
		simulateNetInfo({ isConnected: false, isInternetReachable: false })

		expect(mockSetOnline).toHaveBeenCalledWith(false)
	})

	it("returns true when isConnected=null, isInternetReachable=null (both null → both pass !== false check)", () => {
		simulateNetInfo({ isConnected: null, isInternetReachable: null })

		expect(mockSetOnline).toHaveBeenCalledWith(true)
	})
})

// ─── AppState 'change' -> NetInfo.refresh() branch tests (#169) ───────────────
//
// onlineStatus.ts registers AppState.addEventListener('change', handler) that
// calls NetInfo.refresh() only when nextAppState === 'active'.
// The handler was registered at module-import time; we emit via mockAppState.emit().

describe("onlineStatus AppState 'change' handler", () => {
	beforeEach(() => {
		mockNetInfoRefresh.mockClear()
	})

	it("calls NetInfo.refresh() when nextAppState transitions to 'active'", async () => {
		mockAppState.emit("active")

		// refresh() is async — allow the microtask queue to drain so the
		// .catch(console.error) handler runs without leaving an unhandled rejection
		await Promise.resolve()

		expect(mockNetInfoRefresh).toHaveBeenCalledTimes(1)
	})

	it("does NOT call NetInfo.refresh() when nextAppState is 'background'", async () => {
		mockAppState.emit("background")

		await Promise.resolve()

		expect(mockNetInfoRefresh).not.toHaveBeenCalled()
	})

	it("does NOT call NetInfo.refresh() when nextAppState is 'inactive'", async () => {
		mockAppState.emit("inactive")

		await Promise.resolve()

		expect(mockNetInfoRefresh).not.toHaveBeenCalled()
	})

	it("calls NetInfo.refresh() once per 'active' event — each transition triggers exactly one refresh", async () => {
		mockAppState.emit("active")
		mockAppState.emit("active")

		await Promise.resolve()

		expect(mockNetInfoRefresh).toHaveBeenCalledTimes(2)
	})

	it("AppState.addEventListener was called with 'change' during module init", () => {
		// The module registers exactly one AppState 'change' listener at init time
		expect(mockAppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function))
		expect(mockAppState._capturedChangeHandlers).toHaveLength(1)
	})
})
