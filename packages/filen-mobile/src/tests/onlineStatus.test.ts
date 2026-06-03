import { vi, describe, it, expect } from "vitest"

// onlineStatus.ts does not export computeOnline directly.
// We test the logic by:
//   1. Mocking NetInfo.addEventListener to capture the state-change callback.
//   2. Importing the module (which registers the callback at module init time).
//   3. Calling the captured callback with various NetInfoState shapes.
//   4. Asserting what value onlineManager.setOnline receives.
//
// This exercises every branch of computeOnline without requiring the function to be exported.

const { mockSetOnline, mockSetEventListener, capturedListeners } = vi.hoisted(() => {
	const mockSetOnline = vi.fn()
	const capturedListeners: ((state: object) => void)[] = []

	const mockSetEventListener = vi.fn((factory: (setOnline: (online: boolean) => void) => () => void) => {
		factory(mockSetOnline)
	})

	return { mockSetOnline, mockSetEventListener, capturedListeners }
})

vi.mock("@react-native-community/netinfo", () => ({
	default: {
		addEventListener: vi.fn(listener => {
			capturedListeners.push(listener as (state: object) => void)

			return () => {}
		}),
		refresh: vi.fn().mockResolvedValue(undefined)
	}
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		setOnline: mockSetOnline,
		setEventListener: mockSetEventListener
	}
}))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

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
