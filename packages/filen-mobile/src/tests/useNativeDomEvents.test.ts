import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ─── Imports ─────────────────────────────────────────────────────────────────

import { useNativeDomEvents, type DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRef(impl?: Partial<DOMRef>): { current: DOMRef | null } {
	return { current: impl ? ({ postMessage: vi.fn(), ...impl } as DOMRef) : null }
}

function makeWebViewMessageEvent(data: unknown): { nativeEvent: { data: string } } {
	return { nativeEvent: { data: JSON.stringify(data) } }
}

function makeRawWebViewMessageEvent(raw: string): { nativeEvent: { data: string } } {
	return { nativeEvent: { data: raw } }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useNativeDomEvents", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	// ── postMessage — ref immediately available (happy path) ─────────────────

	it("postMessage calls ref.current.postMessage immediately when ref.current is already set", async () => {
		const mockPostMsg = vi.fn()
		const ref = makeRef({ postMessage: mockPostMsg })

		const { postMessage } = useNativeDomEvents<{ value: number }>({ ref })

		postMessage({ value: 42 })

		// Flush the async IIFE: it resolves on the first iteration because ref.current is non-null
		await vi.runAllTimersAsync()

		expect(mockPostMsg).toHaveBeenCalledOnce()
		expect(mockPostMsg).toHaveBeenCalledWith({ value: 42 })
		expect(console.error).not.toHaveBeenCalled()
	})

	// ── postMessage — ref becomes available after a few polls ─────────────────

	it("postMessage calls ref.current.postMessage after ref is populated mid-poll", async () => {
		const mockPostMsg = vi.fn()
		const ref: { current: DOMRef | null } = { current: null }

		const { postMessage } = useNativeDomEvents<{ id: string }>({ ref })

		postMessage({ id: "late" })

		// Advance 2 poll intervals (ref still null)
		await vi.advanceTimersByTimeAsync(200)

		expect(mockPostMsg).not.toHaveBeenCalled()

		// Now populate the ref
		ref.current = { postMessage: mockPostMsg } as DOMRef

		// Advance one more poll interval so the loop picks up the ref
		await vi.advanceTimersByTimeAsync(100)

		expect(mockPostMsg).toHaveBeenCalledOnce()
		expect(mockPostMsg).toHaveBeenCalledWith({ id: "late" })
	})

	// ── postMessage — poll exhaustion (ref never set → silent return) ─────────

	it("postMessage resolves silently without calling ref.current.postMessage when ref stays null for 100+ iterations", async () => {
		const ref: { current: DOMRef | null } = { current: null }

		const { postMessage } = useNativeDomEvents<{ x: number }>({ ref })

		postMessage({ x: 1 })

		// Run all 100 poll timeouts (100 × 100ms = 10 000ms)
		await vi.advanceTimersByTimeAsync(100 * 100 + 1)

		// ref.current was never set so postMessage on the DOMRef should never fire
		// and no error should be thrown
		expect(console.error).not.toHaveBeenCalled()
	})

	// ── postMessage — error thrown by ref.current.postMessage is caught ────────

	it("postMessage catches errors thrown by ref.current.postMessage and logs them via console.error", async () => {
		const throwingPost = vi.fn(() => {
			throw new Error("dom post failed")
		})

		const ref = makeRef({ postMessage: throwingPost })

		const { postMessage } = useNativeDomEvents<{ n: number }>({ ref })

		postMessage({ n: 7 })

		await vi.runAllTimersAsync()

		expect(console.error).toHaveBeenCalledOnce()
		expect(vi.mocked(console.error).mock.calls[0]?.[0]).toBeInstanceOf(Error)
	})

	// ── onDomMessage — onMessage is undefined (early-return guard) ────────────

	it("onDomMessage does not throw when params.onMessage is undefined", () => {
		const ref = makeRef()

		const { onDomMessage } = useNativeDomEvents<{ y: number }>({ ref })

		expect(() => onDomMessage(makeWebViewMessageEvent({ y: 5 }) as never)).not.toThrow()
	})

	// ── onDomMessage — malformed JSON (catch path) ────────────────────────────

	it("onDomMessage catches JSON.parse errors and does not call onMessage", () => {
		const onMessage = vi.fn()
		const ref = makeRef()

		const { onDomMessage } = useNativeDomEvents<{ z: number }>({ ref, onMessage })

		expect(() => onDomMessage(makeRawWebViewMessageEvent("NOT JSON {{{") as never)).not.toThrow()

		expect(onMessage).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledOnce()
	})

	// ── onDomMessage — happy path ─────────────────────────────────────────────

	it("onDomMessage calls onMessage with the parsed message and the postMessage function", () => {
		const onMessage = vi.fn()
		const ref = makeRef()

		const { onDomMessage, postMessage } = useNativeDomEvents<{ key: string }>({ ref, onMessage })

		onDomMessage(makeWebViewMessageEvent({ key: "hello" }) as never)

		expect(onMessage).toHaveBeenCalledOnce()
		expect(onMessage).toHaveBeenCalledWith({ key: "hello" }, postMessage)
	})

	// ── onDomMessage — postMessage passed to callback is the live postMessage fn

	it("the postMessage passed to the onMessage callback is the same function returned by useNativeDomEvents", () => {
		let capturedPm: ((msg: { v: number }) => void) | undefined

		const onMessage = vi.fn((_msg: { v: number }, pm: (msg: { v: number }) => void) => {
			capturedPm = pm
		})

		const ref = makeRef()
		const { onDomMessage, postMessage } = useNativeDomEvents<{ v: number }>({ ref, onMessage })

		onDomMessage(makeWebViewMessageEvent({ v: 99 }) as never)

		expect(capturedPm).toBe(postMessage)
	})
})
