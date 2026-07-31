import { describe, expect, test } from "vitest"
import { PDF_EVENT_KEY, PDF_EXTERNAL_LINK_KEY, parsePdfExternalLink, parsePdfViewerEvent } from "@/components/pdfPreview/protocol"

function linkEnvelope(url: unknown): unknown {
	return {
		[PDF_EXTERNAL_LINK_KEY]: {
			url
		}
	}
}

function eventEnvelope(event: unknown): unknown {
	return {
		[PDF_EVENT_KEY]: event
	}
}

/**
 * The WebView is the untrusted side of this bridge. Everything here is about what the native side
 * refuses to act on, not about what the viewer intends to send.
 */
describe("parsePdfExternalLink", () => {
	test("accepts an allowlisted external URL", () => {
		expect(parsePdfExternalLink(linkEnvelope("https://filen.io/a?b=c"))).toBe("https://filen.io/a?b=c")
		expect(parsePdfExternalLink(linkEnvelope("mailto:someone@example.com"))).toBe("mailto:someone@example.com")
	})

	test("rejects script and data schemes however they are spelled", () => {
		for (const url of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"  javascript:alert(1)  ",
			"java\tscript:alert(1)",
			"javascript:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox(1)"
		]) {
			expect(parsePdfExternalLink(linkEnvelope(url))).toBeNull()
		}
	})

	test("rejects ftp, which pdf.js itself permits and this app does not", () => {
		expect(parsePdfExternalLink(linkEnvelope("ftp://example.com/x"))).toBeNull()
	})

	test("rejects local and protocol-relative targets", () => {
		for (const url of ["file:///etc/passwd", "content://media/external/file/1", "intent://x#Intent;end", "blob:abc", "//example.com", "/etc/passwd"]) {
			expect(parsePdfExternalLink(linkEnvelope(url))).toBeNull()
		}
	})

	test("rejects a value that only starts with an allowlisted scheme", () => {
		// The allowlist is a prefix test, so a smuggled tail must be caught by the control-character
		// check rather than by the scheme test.
		expect(parsePdfExternalLink(linkEnvelope("tel:+1\njavascript:alert(1)"))).toBeNull()
	})

	test("ignores anything that is not a link envelope", () => {
		expect(parsePdfExternalLink(null)).toBeNull()
		expect(parsePdfExternalLink("https://filen.io")).toBeNull()
		expect(parsePdfExternalLink({})).toBeNull()
		expect(parsePdfExternalLink(linkEnvelope(42))).toBeNull()
		expect(parsePdfExternalLink({ [PDF_EXTERNAL_LINK_KEY]: "https://filen.io" })).toBeNull()
	})
})

describe("parsePdfViewerEvent", () => {
	test("accepts every member of the closed set", () => {
		expect(parsePdfViewerEvent(eventEnvelope({ event: "ready" }))).toStrictEqual({ event: "ready" })
		expect(parsePdfViewerEvent(eventEnvelope({ event: "firstPagePainted" }))).toStrictEqual({ event: "firstPagePainted" })
		expect(parsePdfViewerEvent(eventEnvelope({ event: "unsupported", reason: "structuredClone" }))).toStrictEqual({
			event: "unsupported",
			reason: "structuredClone"
		})
		expect(parsePdfViewerEvent(eventEnvelope({ event: "documentOpened", pageCount: 12 }))).toStrictEqual({
			event: "documentOpened",
			pageCount: 12
		})
		expect(parsePdfViewerEvent(eventEnvelope({ event: "passwordRequired", requestId: "r1", reason: "incorrect" }))).toStrictEqual({
			event: "passwordRequired",
			requestId: "r1",
			reason: "incorrect"
		})
		expect(parsePdfViewerEvent(eventEnvelope({ event: "error", kind: "invalidDocument" }))).toStrictEqual({
			event: "error",
			kind: "invalidDocument"
		})
	})

	test("ready and unsupported are part of the contract", () => {
		// Their absence is what previously left a degraded WebView showing a spinner forever, because
		// the capability gate had no way to report itself.
		expect(parsePdfViewerEvent(eventEnvelope({ event: "ready" }))).not.toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "unsupported", reason: "canvas" }))).not.toBeNull()
	})

	test("accepts the edit and save events", () => {
		expect(parsePdfViewerEvent(eventEnvelope({ event: "edited" }))).toStrictEqual({ event: "edited" })
		expect(parsePdfViewerEvent(eventEnvelope({ event: "saved", requestId: "s1", byteLength: 4096 }))).toStrictEqual({
			event: "saved",
			requestId: "s1",
			byteLength: 4096
		})
		expect(parsePdfViewerEvent(eventEnvelope({ event: "saveFailed", requestId: "s1" }))).toStrictEqual({
			event: "saveFailed",
			requestId: "s1"
		})
	})

	test("rejects a save report that claims nothing was written", () => {
		// A zero or negative length would otherwise be handed on as a file to upload over the user's
		// document.
		expect(parsePdfViewerEvent(eventEnvelope({ event: "saved", requestId: "s1", byteLength: 0 }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "saved", requestId: "s1", byteLength: -1 }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "saved", requestId: "", byteLength: 10 }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "saved", requestId: "s1" }))).toBeNull()
	})

	test("rejects values outside each closed set", () => {
		expect(parsePdfViewerEvent(eventEnvelope({ event: "unsupported", reason: "vibes" }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "error", kind: "TypeError: cannot read x of undefined" }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "passwordRequired", requestId: "r1", reason: "maybe" }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "somethingNew" }))).toBeNull()
	})

	test("rejects malformed payloads", () => {
		expect(parsePdfViewerEvent(eventEnvelope({ event: "documentOpened", pageCount: 0 }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "documentOpened", pageCount: 1.5 }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "documentOpened", pageCount: "12" }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "passwordRequired", requestId: "", reason: "required" }))).toBeNull()
		expect(parsePdfViewerEvent(eventEnvelope({ event: "passwordRequired", requestId: "x".repeat(65), reason: "required" }))).toBeNull()
		expect(parsePdfViewerEvent(null)).toBeNull()
		expect(parsePdfViewerEvent({})).toBeNull()
	})

	test("carries no free-text detail out of the WebView", () => {
		// A document controls parts of pdf.js's messages, and these reach both the UI and the persisted
		// log. Anything extra on the envelope is dropped rather than forwarded.
		const parsed = parsePdfViewerEvent(eventEnvelope({ event: "error", kind: "unknown", message: "attacker-controlled text" }))

		expect(parsed).toStrictEqual({ event: "error", kind: "unknown" })
		expect(JSON.stringify(parsed)).not.toContain("attacker-controlled")
	})
})
