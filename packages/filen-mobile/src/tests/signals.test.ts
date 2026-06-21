import { vi, describe, it, expect, beforeEach } from "vitest"

// Fakes live in vi.hoisted so they exist before the hoisted vi.mock factory references them. They
// track every uniffiDestroy + abort against the fake SDK handles so the tests can assert that
// disposeSdkAbortSignal frees BOTH the controller (the handle TC-01 leaked) and the signal, and that
// the abort listener is removed before the controller is destroyed (no use-after-free on a late abort).
const { FakeManagedAbortController, FakeManagedAbortSignal, FakePauseSignal, destroyed } = vi.hoisted(() => {
	const destroyed: string[] = []

	class FakeManagedAbortSignal {
		public destroyedFlag = false

		uniffiDestroy(): void {
			this.destroyedFlag = true

			destroyed.push("signal")
		}
	}

	class FakeManagedAbortController {
		public aborted = false
		public destroyedFlag = false
		public readonly signalInstance = new FakeManagedAbortSignal()

		abort(): void {
			if (this.destroyedFlag) {
				// Mirror the real binding: calling abort() after uniffiDestroy clonePointers a freed
				// handle and throws. The test asserts this never happens.
				throw new Error("abort() called on a destroyed ManagedAbortController (use-after-free)")
			}

			this.aborted = true
		}

		signal(): FakeManagedAbortSignal {
			return this.signalInstance
		}

		uniffiDestroy(): void {
			this.destroyedFlag = true

			destroyed.push("controller")
		}
	}

	class FakePauseSignal {
		pause(): void {}
		resume(): void {}
		isPaused(): boolean {
			return false
		}
		uniffiDestroy(): void {}
	}

	return { FakeManagedAbortController, FakeManagedAbortSignal, FakePauseSignal, destroyed }
})

vi.mock("@filen/sdk-rs", () => ({
	ManagedAbortController: FakeManagedAbortController,
	PauseSignal: FakePauseSignal
}))

import { wrapAbortSignalForSdk, disposeSdkAbortSignal } from "@/lib/signals"

beforeEach(() => {
	destroyed.length = 0
})

describe("wrapAbortSignalForSdk + disposeSdkAbortSignal", () => {
	it("returns the controller's signal handle", () => {
		const source = new AbortController()
		const wrapped = wrapAbortSignalForSdk(source.signal)

		expect(wrapped).toBeInstanceOf(FakeManagedAbortSignal)
	})

	it("disposeSdkAbortSignal frees BOTH the signal and the controller (the handle TC-01 leaked)", () => {
		const source = new AbortController()
		const wrapped = wrapAbortSignalForSdk(source.signal)

		disposeSdkAbortSignal(wrapped)

		expect(destroyed).toContain("signal")
		expect(destroyed).toContain("controller")
	})

	it("removes the source abort listener on dispose so a LATER abort cannot hit the freed controller", () => {
		const source = new AbortController()
		const wrapped = wrapAbortSignalForSdk(source.signal)

		disposeSdkAbortSignal(wrapped)

		// The controller is now destroyed; if the listener were still attached, this abort would call
		// controller.abort() on a freed handle and the fake throws. It must NOT throw.
		expect(() => source.abort()).not.toThrow()
	})

	it("a pre-dispose abort still propagates to the controller (listener wired correctly)", () => {
		const source = new AbortController()
		const wrapped = wrapAbortSignalForSdk(source.signal)

		// Abort before dispose: the controller is still alive, so this is the normal cancel path.
		expect(() => source.abort()).not.toThrow()

		disposeSdkAbortSignal(wrapped)

		expect(destroyed).toEqual(["signal", "controller"])
	})

	it("is safe on an undefined signal (callers pass `signal ? wrap : undefined`)", () => {
		expect(() => disposeSdkAbortSignal(undefined)).not.toThrow()
	})

	it("a second dispose of the same signal does not double-free the controller", () => {
		const source = new AbortController()
		const wrapped = wrapAbortSignalForSdk(source.signal)

		disposeSdkAbortSignal(wrapped)

		destroyed.length = 0

		disposeSdkAbortSignal(wrapped)

		expect(destroyed).not.toContain("controller")
	})
})
