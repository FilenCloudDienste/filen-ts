import { afterEach, describe, expect, it, vi } from "vitest"
import { EXTERNAL_LINK_KEY, getReactNativeWebView, parseExternalLinkMessage, postExternalLink, postToNativeWebView } from "@/lib/domExternalLink"

type RNWebViewGlobal = typeof globalThis & {
	ReactNativeWebView?: { postMessage?: unknown } | undefined
}

function envelope(url: unknown): unknown {
	return {
		[EXTERNAL_LINK_KEY]: {
			url
		}
	}
}

/**
 * The WebView is the untrusted side of this bridge. Everything here is about what the native side
 * refuses to act on, not about what the viewer intends to send.
 */
describe("parseExternalLinkMessage", () => {
	it("accepts an allowlisted external URL", () => {
		expect(parseExternalLinkMessage(envelope("https://filen.io/a?b=c"))).toBe("https://filen.io/a?b=c")
		expect(parseExternalLinkMessage(envelope("mailto:someone@example.com"))).toBe("mailto:someone@example.com")
	})

	it("rejects script and data schemes however they are spelled", () => {
		for (const url of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"  javascript:alert(1)  ",
			"java\tscript:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox(1)"
		]) {
			expect(parseExternalLinkMessage(envelope(url))).toBeNull()
		}
	})

	it("rejects ftp, which pdf.js itself permits and this app does not", () => {
		expect(parseExternalLinkMessage(envelope("ftp://example.com/x"))).toBeNull()
	})

	it("rejects local, protocol-relative, fragment and empty targets", () => {
		for (const url of [
			"file:///etc/passwd",
			"content://media/external/file/1",
			"intent://x#Intent;end",
			"blob:abc",
			"//example.com",
			"/etc/passwd",
			"#fragment",
			""
		]) {
			expect(parseExternalLinkMessage(envelope(url))).toBeNull()
		}
	})

	it("rejects a value that only starts with an allowlisted scheme", () => {
		// The allowlist is a prefix test, so a smuggled tail must be caught by the control-character
		// check rather than by the scheme test.
		expect(parseExternalLinkMessage(envelope("tel:+1\njavascript:alert(1)"))).toBeNull()
	})

	it("ignores anything that is not a link envelope", () => {
		expect(parseExternalLinkMessage(null)).toBeNull()
		expect(parseExternalLinkMessage(undefined)).toBeNull()
		expect(parseExternalLinkMessage("https://filen.io")).toBeNull()
		expect(parseExternalLinkMessage(42)).toBeNull()
		expect(parseExternalLinkMessage({})).toBeNull()
		expect(parseExternalLinkMessage({ __filenLog: { level: "warn", message: "x" } })).toBeNull()
	})

	it("ignores a malformed envelope payload", () => {
		expect(parseExternalLinkMessage({ [EXTERNAL_LINK_KEY]: null })).toBeNull()
		expect(parseExternalLinkMessage({ [EXTERNAL_LINK_KEY]: "https://filen.io" })).toBeNull()
		expect(parseExternalLinkMessage(envelope(undefined))).toBeNull()
		expect(parseExternalLinkMessage(envelope(42))).toBeNull()
	})
})

describe("WebView-side posting", () => {
	afterEach(() => {
		delete (globalThis as RNWebViewGlobal).ReactNativeWebView
		vi.restoreAllMocks()
	})

	it("reports no bridge when ReactNativeWebView or its postMessage is missing", () => {
		expect(getReactNativeWebView()).toBeNull()
		;(globalThis as RNWebViewGlobal).ReactNativeWebView = {}
		expect(getReactNativeWebView()).toBeNull()
		;(globalThis as RNWebViewGlobal).ReactNativeWebView = { postMessage: "not a function" }
		expect(getReactNativeWebView()).toBeNull()
	})

	it("is a silent no-op without a bridge", () => {
		expect(() => postToNativeWebView({ a: 1 })).not.toThrow()
		expect(() => postExternalLink("https://filen.io")).not.toThrow()
	})

	it("posts a link envelope the native parser accepts", () => {
		const postMessage = vi.fn()

		;(globalThis as RNWebViewGlobal).ReactNativeWebView = { postMessage }

		postExternalLink("https://filen.io")

		expect(postMessage).toHaveBeenCalledOnce()
		expect(parseExternalLinkMessage(JSON.parse(postMessage.mock.calls[0]?.[0] as string))).toBe("https://filen.io")
	})

	it("swallows a throwing bridge or serialiser", () => {
		;(globalThis as RNWebViewGlobal).ReactNativeWebView = {
			postMessage: () => {
				throw new Error("bridge gone")
			}
		}

		expect(() => postToNativeWebView({ a: 1 })).not.toThrow()

		const circular: Record<string, unknown> = {}

		circular["self"] = circular

		expect(() => postToNativeWebView(circular)).not.toThrow()
	})
})
