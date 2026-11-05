import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// onlineStatus.ts wires three things at module init: NetInfo (interface state only) into
// lib/reachability, reachability into TanStack's onlineManager, and a foreground NetInfo refresh.
// Reachability itself is mocked here; its state machine is covered by reachability.test.ts.

const { mocks, callOrder, capturedNetInfoListeners, capturedChangeHandlers } = vi.hoisted(() => {
	const callOrder: string[] = []
	const capturedNetInfoListeners: ((state: object) => void)[] = []
	const capturedChangeHandlers: ((nextState: string) => void)[] = []
	const unsubscribe = () => {}

	return {
		callOrder,
		capturedNetInfoListeners,
		capturedChangeHandlers,
		mocks: {
			configure: vi.fn(() => {
				callOrder.push("configure")
			}),
			refresh: vi.fn(async () => ({ isConnected: true, type: "wifi" }) as object),
			setEventListener: vi.fn(),
			setOnline: vi.fn(),
			unsubscribe,
			reachability: {
				setInterface: vi.fn(),
				isOnline: vi.fn(() => true),
				subscribe: vi.fn(() => unsubscribe),
				start: vi.fn()
			}
		}
	}
})

vi.mock("@react-native-community/netinfo", () => ({
	default: {
		configure: mocks.configure,
		addEventListener: vi.fn((listener: (state: object) => void) => {
			callOrder.push("addEventListener")
			capturedNetInfoListeners.push(listener)

			return () => {}
		}),
		refresh: mocks.refresh
	}
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		setEventListener: mocks.setEventListener
	}
}))

vi.mock("react-native", () => ({
	AppState: {
		currentState: "active",
		addEventListener: vi.fn((type: string, handler: (nextState: string) => void) => {
			if (type === "change") {
				capturedChangeHandlers.push(handler)
			}

			return { remove: () => {} }
		})
	},
	Platform: {
		OS: "ios",
		select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
			return specifics["ios"] ?? specifics["default"]
		}
	}
}))

vi.mock("@/lib/reachability", () => ({ default: mocks.reachability }))

import "@/queries/onlineStatus"

// Vitest clears mock call history before every test, so snapshot the module-init calls here.
const initCalls = {
	configure: [...mocks.configure.mock.calls] as unknown[][],
	setEventListener: [...mocks.setEventListener.mock.calls] as unknown[][],
	start: mocks.reachability.start.mock.calls.length
}

function emitAppState(nextState: string): void {
	for (const handler of capturedChangeHandlers) {
		handler(nextState)
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("onlineStatus NetInfo configuration", () => {
	it("configures NetInfo once, with its HTTP reachability probe off", () => {
		expect(initCalls.configure).toHaveLength(1)

		const config = initCalls.configure[0]?.[0] as { reachabilityShouldRun: () => boolean; reachabilityUrl?: string }

		expect(config.reachabilityShouldRun()).toBe(false)
		expect(config.reachabilityUrl).toBeUndefined()
	})

	it("REGRESSION: configure runs BEFORE the first addEventListener (configure severs existing subscriptions)", () => {
		const configureIndex = callOrder.indexOf("configure")
		const subscribeIndex = callOrder.indexOf("addEventListener")

		expect(configureIndex).not.toBe(-1)
		expect(subscribeIndex).not.toBe(-1)
		expect(configureIndex).toBeLessThan(subscribeIndex)
	})
})

describe("onlineStatus NetInfo → reachability", () => {
	it("forwards the interface state and type, never isInternetReachable", () => {
		const listener = capturedNetInfoListeners[0]

		expect(listener).toBeTypeOf("function")

		listener?.({ isConnected: true, isInternetReachable: false, type: "cellular" })

		expect(mocks.reachability.setInterface).toHaveBeenCalledWith(true, "cellular")

		listener?.({ isConnected: null, isInternetReachable: null, type: "unknown" })

		expect(mocks.reachability.setInterface).toHaveBeenLastCalledWith(null, "unknown")
	})

	it("starts reachability once at module init", () => {
		expect(initCalls.start).toBe(1)
	})
})

describe("onlineStatus reachability → onlineManager", () => {
	it("seeds onlineManager with the current answer and subscribes it to every flip", () => {
		expect(initCalls.setEventListener).toHaveLength(1)

		const factory = initCalls.setEventListener[0]?.[0] as (setOnline: (online: boolean) => void) => () => void

		mocks.reachability.isOnline.mockReturnValueOnce(false)

		const cleanup = factory(mocks.setOnline)

		expect(mocks.setOnline).toHaveBeenCalledWith(false)
		expect(mocks.reachability.subscribe).toHaveBeenCalledWith(mocks.setOnline)
		expect(cleanup).toBe(mocks.unsubscribe)
	})
})

describe("onlineStatus foreground refresh", () => {
	it("re-reads the interface on foreground and pushes it into reachability directly", async () => {
		mocks.refresh.mockResolvedValueOnce({ isConnected: false, type: "none" })

		emitAppState("active")

		await vi.waitFor(() => {
			expect(mocks.reachability.setInterface).toHaveBeenCalledWith(false, "none")
		})
		expect(mocks.refresh).toHaveBeenCalledTimes(1)
	})

	it("does nothing when the app leaves the foreground", async () => {
		emitAppState("background")
		emitAppState("inactive")

		await Promise.resolve()

		expect(mocks.refresh).not.toHaveBeenCalled()
		expect(mocks.reachability.setInterface).not.toHaveBeenCalled()
	})
})
