import { describe, expect, test } from "vitest"
import { PDF_EVENT_KEY, parsePdfViewerEvent } from "@/components/pdfPreview/protocol"

function eventEnvelope(event: unknown): unknown {
	return {
		[PDF_EVENT_KEY]: event
	}
}

describe("parsePdfViewerEvent", () => {
	test("accepts every member of the closed set", () => {
		expect(parsePdfViewerEvent(eventEnvelope({ event: "ready" }))).toStrictEqual({ event: "ready" })
		expect(parsePdfViewerEvent(eventEnvelope({ event: "firstPagePainted" }))).toStrictEqual({ event: "firstPagePainted" })
		expect(parsePdfViewerEvent(eventEnvelope({ event: "unsupported", reason: "structuredClone" }))).toStrictEqual({
			event: "unsupported",
			reason: "structuredClone"
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
