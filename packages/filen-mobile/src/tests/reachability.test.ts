import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { REACHABILITY_PROBE } from "@/constants"
import { resolveConnectionSlotStatus } from "@/components/floatingBar/offlineSlotStatus"
import type { ProbeOutcome } from "@/lib/reachability"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { appState } = vi.hoisted(() => {
	const handlers: ((nextState: string) => void)[] = []

	return {
		appState: {
			currentState: "active",
			handlers,
			addEventListener: (type: string, handler: (nextState: string) => void) => {
				if (type === "change") {
					handlers.push(handler)
				}

				return { remove: () => {} }
			},
			emit(nextState: string) {
				this.currentState = nextState

				for (const handler of handlers) {
					handler(nextState)
				}
			}
		}
	}
})

vi.mock("react-native", () => ({
	AppState: appState,
	Platform: {
		OS: "ios",
		select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
			return specifics["ios"] ?? specifics["default"]
		}
	}
}))

// Fresh singletons per test: reachability subscribes to the socket store and connectionTrust at start().
async function setup(options: { active?: boolean } = {}) {
	vi.resetModules()

	appState.handlers.length = 0
	appState.currentState = options.active === false ? "background" : "active"

	const { Reachability } = await import("@/lib/reachability")
	const { default: connectionTrust } = await import("@/lib/connectionTrust")
	const { default: useSocketStore } = await import("@/stores/useSocket.store")
	const reachability = new Reachability()
	const flips: boolean[] = []
	const outcomes: ProbeOutcome[] = []
	const probe = vi.fn(async (_signal: AbortSignal): Promise<ProbeOutcome> => outcomes.shift() ?? "reachable")

	reachability.subscribe(online => flips.push(online))

	return { reachability, connectionTrust, useSocketStore, flips, outcomes, probe }
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("reachability: startup", () => {
	it("holds the foreground probe until one is registered, then sends exactly one", async () => {
		const { reachability, probe } = await setup()

		reachability.start()
		await settle()

		reachability.setProbe(probe)
		await settle()

		expect(probe).toHaveBeenCalledTimes(1)
		expect(reachability.isOnline()).toBe(true)
		expect(reachability.getReachable()).toBe(true)
	})

	it("reads as online while nothing is known (no interface event, no probe settled)", async () => {
		const { reachability } = await setup()

		expect(reachability.getReachable()).toBeNull()
		expect(reachability.isOnline()).toBe(true)
	})

	it("sends nothing at start in the background (a headless launch); the foreground does", async () => {
		const { reachability, probe } = await setup({ active: false })

		reachability.setProbe(probe)
		reachability.start()
		await settle()

		expect(probe).not.toHaveBeenCalled()

		appState.emit("active")
		await settle()

		expect(probe).toHaveBeenCalledTimes(1)
	})
})

describe("reachability: probe outcomes", () => {
	it("goes offline on no answer and retries on the short interval until Filen answers", async () => {
		const { reachability, probe, outcomes, flips, connectionTrust } = await setup()

		outcomes.push("unreachable", "unreachable", "reachable")
		reachability.setProbe(probe)
		reachability.start()
		await settle()

		expect(reachability.isOnline()).toBe(false)
		expect(connectionTrust.isUnverified()).toBe(false)
		expect(flips).toEqual([false])

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.unreachableIntervalMs)

		expect(probe).toHaveBeenCalledTimes(2)
		expect(flips).toEqual([false])

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.unreachableIntervalMs)

		expect(probe).toHaveBeenCalledTimes(3)
		expect(flips).toEqual([false, true])
	})

	it("a rejected certificate pauses the app as offline but keeps the unverified state, which the indicator shows", async () => {
		const { reachability, probe, outcomes, connectionTrust } = await setup()

		outcomes.push("unverified")
		reachability.setProbe(probe)
		reachability.start()
		await settle()

		expect(reachability.isOnline()).toBe(false)
		expect(connectionTrust.isUnverified()).toBe(true)
		// The probe's own mark does not ask for a second probe.
		expect(probe).toHaveBeenCalledTimes(1)
		// What the floating bar / banner shows for an offline status with the certificate failing.
		expect(resolveConnectionSlotStatus("offline", connectionTrust.isUnverified())).toBe("unverified")
	})

	it("clears the unverified state once Filen answers over a verified connection", async () => {
		const { reachability, probe, outcomes, connectionTrust, flips } = await setup()

		outcomes.push("unverified", "reachable")
		reachability.setProbe(probe)
		reachability.start()
		await settle()

		expect(connectionTrust.isUnverified()).toBe(true)

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.unreachableIntervalMs)

		expect(connectionTrust.isUnverified()).toBe(false)
		expect(flips).toEqual([false, true])
	})

	it("clears the unverified state when the probe then gets no answer (the indicator says offline)", async () => {
		const { reachability, probe, outcomes, connectionTrust } = await setup()

		outcomes.push("unverified", "unreachable")
		reachability.setProbe(probe)
		reachability.start()
		await settle()
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.unreachableIntervalMs)

		expect(connectionTrust.isUnverified()).toBe(false)
		expect(reachability.isOnline()).toBe(false)
	})

	it("leaves the state alone on an inconclusive probe and tries again", async () => {
		const { reachability, probe, outcomes, flips } = await setup()

		outcomes.push("unreachable", "inconclusive")
		reachability.setProbe(probe)
		reachability.start()
		await settle()
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.unreachableIntervalMs)

		expect(probe).toHaveBeenCalledTimes(2)
		expect(reachability.getReachable()).toBe(false)
		expect(flips).toEqual([false])
	})

	it("counts a probe the timeout cut off as unreachable", async () => {
		const { reachability } = await setup()
		const probe = vi.fn(
			(signal: AbortSignal) =>
				new Promise<ProbeOutcome>(resolve => {
					signal.addEventListener("abort", () => resolve("inconclusive"))
				})
		)

		reachability.setProbe(probe)
		reachability.start()
		await settle()

		expect(reachability.getReachable()).toBeNull()

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.timeoutMs)

		expect(reachability.getReachable()).toBe(false)
		expect(reachability.isOnline()).toBe(false)
	})

	it("a probe that throws is inconclusive", async () => {
		const { reachability } = await setup()

		reachability.setProbe(vi.fn(async () => Promise.reject(new Error("boom"))))
		reachability.start()
		await settle()

		expect(reachability.getReachable()).toBeNull()
		expect(reachability.isOnline()).toBe(true)
	})
})

describe("reachability: request volume", () => {
	it("re-checks on the long interval while online in the foreground without a socket", async () => {
		const { reachability, probe } = await setup()

		reachability.setProbe(probe)
		reachability.start()
		await settle()
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.reachableIntervalMs - 1)

		expect(probe).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)

		expect(probe).toHaveBeenCalledTimes(2)
	})

	it("sends nothing while the socket is connected; the socket is the proof", async () => {
		const { reachability, probe, useSocketStore, outcomes } = await setup()

		outcomes.push("unreachable")
		reachability.setProbe(probe)
		reachability.start()
		await settle()

		expect(reachability.isOnline()).toBe(false)

		useSocketStore.getState().setState("connected")

		expect(reachability.isOnline()).toBe(true)

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.reachableIntervalMs * 10)

		expect(probe).toHaveBeenCalledTimes(1)
	})

	it("probes when the socket drops in the foreground, not when it is torn down for the background", async () => {
		const { reachability, probe, useSocketStore } = await setup()

		reachability.setProbe(probe)
		reachability.start()
		await settle()
		useSocketStore.getState().setState("connected")

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.minGapMs)

		useSocketStore.getState().setState("reconnecting")
		await settle()

		expect(probe).toHaveBeenCalledTimes(2)

		useSocketStore.getState().setState("connected")
		appState.emit("background")
		useSocketStore.getState().setState("disconnected")
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.reachableIntervalMs * 10)

		expect(probe).toHaveBeenCalledTimes(2)
	})

	it("sends nothing in the background while reachable, and probes again on the foreground", async () => {
		const { reachability, probe } = await setup()

		reachability.setProbe(probe)
		reachability.start()
		await settle()

		appState.emit("background")
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.reachableIntervalMs * 10)

		expect(probe).toHaveBeenCalledTimes(1)

		appState.emit("active")
		await settle()

		expect(probe).toHaveBeenCalledTimes(2)
	})

	it("keeps one probe in flight and spaces probes asked for by evidence", async () => {
		const { reachability } = await setup()
		const pending: { resolve?: (outcome: ProbeOutcome) => void } = {}
		const probe = vi.fn(
			() =>
				new Promise<ProbeOutcome>(resolve => {
					pending.resolve = resolve
				})
		)

		reachability.setProbe(probe)
		reachability.start()
		reachability.requestProbe()
		reachability.requestProbe()

		expect(probe).toHaveBeenCalledTimes(1)

		pending.resolve?.("reachable")
		await settle()

		reachability.requestProbe()

		expect(probe).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.minGapMs)

		expect(probe).toHaveBeenCalledTimes(2)
	})
})

describe("reachability: network interface", () => {
	it("goes offline with no interface without a request, clears the certificate state, and probes when it returns", async () => {
		const { reachability, probe, connectionTrust, flips } = await setup()

		reachability.setProbe(probe)
		reachability.setInterface(true, "wifi")
		reachability.start()
		await settle()

		expect(probe).toHaveBeenCalledTimes(1)

		connectionTrust.markUnverified()
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.minGapMs)
		probe.mockClear()

		reachability.setInterface(false, "none")

		expect(reachability.isOnline()).toBe(false)
		expect(connectionTrust.isUnverified()).toBe(false)

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.reachableIntervalMs * 10)

		expect(probe).not.toHaveBeenCalled()

		reachability.setInterface(true, "cellular")
		await settle()

		expect(probe).toHaveBeenCalledTimes(1)
		expect(flips).toEqual([false, true])
	})

	it("ignores repeated interface events that change nothing", async () => {
		const { reachability, probe } = await setup()

		reachability.setProbe(probe)
		reachability.setInterface(true, "wifi")
		await settle()
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.minGapMs)

		reachability.setInterface(true, "wifi")
		await settle()

		expect(probe).toHaveBeenCalledTimes(1)
	})

	it("drops a probe answer that arrives after the interface went down", async () => {
		const { reachability } = await setup()
		const pending: { resolve?: (outcome: ProbeOutcome) => void } = {}
		const probe = vi.fn(
			() =>
				new Promise<ProbeOutcome>(resolve => {
					pending.resolve = resolve
				})
		)

		reachability.setProbe(probe)
		reachability.setInterface(true, "wifi")
		reachability.setInterface(false, "none")
		pending.resolve?.("unverified")
		await settle()

		expect(reachability.getReachable()).toBeNull()
	})
})

describe("reachability: evidence from real traffic", () => {
	it("a certificate failure seen by a request while reachable asks for a confirming probe", async () => {
		const { reachability, probe, outcomes, connectionTrust } = await setup()

		outcomes.push("reachable", "unverified")
		reachability.setProbe(probe)
		reachability.start()
		await settle()
		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.minGapMs)

		connectionTrust.markUnverified()
		await settle()

		expect(probe).toHaveBeenCalledTimes(2)
		expect(reachability.isOnline()).toBe(false)
		expect(connectionTrust.isUnverified()).toBe(true)
	})

	it("an authenticated socket proves reachability and clears the certificate state", async () => {
		const { reachability, probe, outcomes, connectionTrust, useSocketStore } = await setup()

		outcomes.push("unverified")
		reachability.setProbe(probe)
		reachability.start()
		await settle()

		useSocketStore.getState().setState("connected")

		expect(reachability.isOnline()).toBe(true)
		expect(connectionTrust.isUnverified()).toBe(false)
	})
})

describe("reachability: socket reconnect", () => {
	it("asks for a reconnect when an interface comes up or changes, never when it goes down", async () => {
		const { reachability, probe } = await setup()
		const reconnect = vi.fn()

		reachability.setProbe(probe)
		reachability.setSocketReconnect(reconnect)

		reachability.setInterface(true, "wifi")
		reachability.setInterface(true, "wifi")
		expect(reconnect).toHaveBeenCalledTimes(1)

		reachability.setInterface(false, "none")
		expect(reconnect).toHaveBeenCalledTimes(1)

		reachability.setInterface(true, "cellular")
		expect(reconnect).toHaveBeenCalledTimes(2)
	})

	it("asks on every return to the foreground", async () => {
		const { reachability, probe } = await setup()
		const reconnect = vi.fn()

		reachability.setProbe(probe)
		reachability.setSocketReconnect(reconnect)
		reachability.start()
		await settle()
		reconnect.mockClear()

		appState.emit("background")
		expect(reconnect).not.toHaveBeenCalled()

		appState.emit("active")
		appState.emit("background")
		appState.emit("active")
		expect(reconnect).toHaveBeenCalledTimes(2)
	})

	it("asks when Filen answers again after the probe found it unreachable", async () => {
		const { reachability, probe, outcomes } = await setup()
		const reconnect = vi.fn()

		outcomes.push("unreachable", "reachable")
		reachability.setProbe(probe)
		reachability.setSocketReconnect(reconnect)
		reachability.start()
		await settle()
		expect(reconnect).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE.unreachableIntervalMs)
		expect(reachability.getReachable()).toBe(true)
		expect(reconnect).toHaveBeenCalledTimes(1)
	})

	it("asks nothing while the socket is connected", async () => {
		const { reachability, probe, useSocketStore } = await setup()
		const reconnect = vi.fn()

		reachability.setProbe(probe)
		reachability.setSocketReconnect(reconnect)
		reachability.start()
		await settle()
		useSocketStore.getState().setState("connected")
		reconnect.mockClear()

		reachability.setInterface(true, "wifi")
		appState.emit("background")
		appState.emit("active")
		expect(reconnect).not.toHaveBeenCalled()
	})

	it("asks nothing before a reconnect is registered (auth not loaded)", async () => {
		const { reachability } = await setup()

		expect(() => reachability.setInterface(true, "wifi")).not.toThrow()
	})
})
