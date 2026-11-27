import { afterEach, describe, expect, it, vi } from "vitest"

// The real module (setup.ts mocks it away), with the SDK worker it spins up at import faked out: only
// its pool sizing is under test here.
const { workers } = vi.hoisted(() => ({ workers: [] as EventTarget[] }))

vi.mock("@/workers/sdk.worker.ts?worker", () => ({
	default: class extends EventTarget {
		constructor() {
			super()
			workers.push(this)
		}

		postMessage(): void {
			// Never reached: nothing calls the remote.
		}
	}
}))
vi.mock("comlink", () => ({ wrap: () => ({ setLockSink: () => Promise.resolve() }), proxy: (value: unknown) => value }))
vi.mock("@/lib/sdk/owedLocks", () => ({ installOwedLocksHandoff: vi.fn(), onLockEvent: vi.fn() }))
vi.mock("@/e2e-hooks/sdkCalls", () => ({ trackSdkCalls: (remote: unknown) => remote }))

const { log } = await import("@/lib/log")
const { threadCount } = await vi.importActual<typeof import("@/lib/sdk/client")>("@/lib/sdk/client")

function withCores(cores: number): number {
	vi.stubGlobal("navigator", { hardwareConcurrency: cores })

	return threadCount()
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("threadCount", () => {
	it("leaves two cores free", () => {
		expect(withCores(8)).toBe(6)
		expect(withCores(10)).toBe(8)
	})

	it("never drops below two threads", () => {
		expect(withCores(1)).toBe(2)
		expect(withCores(2)).toBe(2)
		expect(withCores(4)).toBe(2)
	})

	it("caps at twelve threads", () => {
		expect(withCores(14)).toBe(12)
		expect(withCores(64)).toBe(12)
	})

	it("falls back to the minimum pool where the browser reports no core count", () => {
		vi.stubGlobal("navigator", {})

		expect(threadCount()).toBe(2)
		expect(withCores(0)).toBe(2)
	})
})

// A failed worker leaves every Comlink call unsettled: its errors are logged.
describe("SDK worker errors", () => {
	it("logs a worker error and a message that cannot be deserialized", () => {
		const error = vi.spyOn(log, "error").mockImplementation(() => undefined)
		const worker = workers[0]

		expect(worker).toBeDefined()

		// Node has no ErrorEvent: an Event carrying its fields.
		worker?.dispatchEvent(Object.assign(new Event("error"), { message: "boom", filename: "sdk.worker.js", lineno: 7 }))
		worker?.dispatchEvent(new Event("messageerror"))

		expect(error.mock.calls).toEqual([
			["sdk-worker", "worker error", "boom", "sdk.worker.js:7"],
			["sdk-worker", "worker message could not be deserialized"]
		])
		error.mockRestore()
	})
})
