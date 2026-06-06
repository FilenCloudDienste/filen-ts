import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ─── Imports ─────────────────────────────────────────────────────────────────

import useDomDomEvents from "@/hooks/useDomEvents/useDomDomEvents"

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RNWebViewGlobal = typeof globalThis & {
	ReactNativeWebView?:
		| {
				postMessage?: ((message: unknown) => void) | undefined
		  }
		| undefined
}

function setRNWebView(postMessageFn: ((message: unknown) => void) | undefined): void {
	;(globalThis as RNWebViewGlobal).ReactNativeWebView = { postMessage: postMessageFn }
}

function removeRNWebView(): void {
	delete (globalThis as RNWebViewGlobal).ReactNativeWebView
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useDomDomEvents", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		removeRNWebView()
		vi.restoreAllMocks()
	})

	// ── postMessage — missing ReactNativeWebView ──────────────────────────────

	it("postMessage logs console.error and returns early when globalThis.ReactNativeWebView is undefined", () => {
		removeRNWebView()

		const { postMessage } = useDomDomEvents<{ text: string }>()

		expect(() => postMessage({ text: "hello" })).not.toThrow()
		expect(console.error).toHaveBeenCalledOnce()
		expect(vi.mocked(console.error).mock.calls[0]?.[0]).toBe("RNWebView is not available")
	})

	// ── postMessage — ReactNativeWebView exists but .postMessage is undefined ─

	it("postMessage logs console.error and returns early when ReactNativeWebView.postMessage is undefined", () => {
		setRNWebView(undefined)

		const { postMessage } = useDomDomEvents<{ text: string }>()

		expect(() => postMessage({ text: "hello" })).not.toThrow()
		expect(console.error).toHaveBeenCalledOnce()
		expect(vi.mocked(console.error).mock.calls[0]?.[0]).toBe("RNWebView is not available")
	})

	// ── postMessage — JSON.stringify throws (circular reference) ─────────────

	it("postMessage catches JSON.stringify errors and logs them via console.error", () => {
		const mockPostMsg = vi.fn()
		setRNWebView(mockPostMsg)

		const jsonStringifySpy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
			throw new Error("circular")
		})

		const { postMessage } = useDomDomEvents<object>()
		const circular: Record<string, unknown> = {}
		circular["self"] = circular

		expect(() => postMessage(circular)).not.toThrow()
		expect(console.error).toHaveBeenCalledOnce()
		expect(vi.mocked(console.error).mock.calls[0]?.[0]).toBeInstanceOf(Error)
		expect(mockPostMsg).not.toHaveBeenCalled()

		jsonStringifySpy.mockRestore()
	})

	// ── postMessage — happy path ──────────────────────────────────────────────

	it("postMessage calls ReactNativeWebView.postMessage with JSON.stringify(message) on the happy path", () => {
		const mockPostMsg = vi.fn()
		setRNWebView(mockPostMsg)

		const { postMessage } = useDomDomEvents<{ value: number }>()

		postMessage({ value: 42 })

		expect(mockPostMsg).toHaveBeenCalledOnce()
		expect(mockPostMsg).toHaveBeenCalledWith(JSON.stringify({ value: 42 }))
		expect(console.error).not.toHaveBeenCalled()
	})

	// ── onNativeMessage — onMessage is undefined (optional chaining guard) ────

	it("onNativeMessage does not throw when onMessage is undefined", () => {
		const { onNativeMessage } = useDomDomEvents<{ x: number }>()

		expect(() => onNativeMessage({ x: 1 })).not.toThrow()
	})

	// ── onNativeMessage — forwards message and postMessage to callback ────────

	it("onNativeMessage calls onMessage with the raw message value and the postMessage function", () => {
		const mockPostMsg = vi.fn()
		setRNWebView(mockPostMsg)

		const onMessage = vi.fn()
		const { onNativeMessage, postMessage } = useDomDomEvents<{ id: string }>(onMessage)

		const msg = { id: "abc" }
		onNativeMessage(msg)

		expect(onMessage).toHaveBeenCalledOnce()
		expect(onMessage).toHaveBeenCalledWith(msg, postMessage)
	})

	// ── onNativeMessage — the postMessage passed to the callback is functional ─

	it("the postMessage passed to the onMessage callback actually sends messages", () => {
		const mockPostMsg = vi.fn()
		setRNWebView(mockPostMsg)

		let capturedPostMessage: ((msg: { id: string }) => void) | undefined

		const onMessage = vi.fn((_msg: { id: string }, pm: (msg: { id: string }) => void) => {
			capturedPostMessage = pm
		})

		const { onNativeMessage } = useDomDomEvents<{ id: string }>(onMessage)

		onNativeMessage({ id: "x" })

		expect(capturedPostMessage).toBeDefined()

		capturedPostMessage?.({ id: "reply" })

		expect(mockPostMsg).toHaveBeenCalledOnce()
		expect(mockPostMsg).toHaveBeenCalledWith(JSON.stringify({ id: "reply" }))
	})
})
