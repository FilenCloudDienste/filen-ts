import { afterEach, describe, expect, it, vi } from "vitest"

// The real module (setup.ts mocks it away), with the SDK worker it spins up at import faked out: only
// its pool sizing is under test here.
vi.mock("@/workers/sdk.worker.ts?worker", () => ({
	default: class {
		postMessage(): void {
			// Never reached: nothing calls the remote.
		}
	}
}))
vi.mock("comlink", () => ({ wrap: () => ({}) }))
vi.mock("@/e2e-hooks/sdkCalls", () => ({ trackSdkCalls: (remote: unknown) => remote }))

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

	it("assumes four cores where the browser reports none", () => {
		expect(withCores(0)).toBe(2)
	})
})
