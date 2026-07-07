import { afterEach, describe, expect, it, vi } from "vitest"
import { getReferral } from "@/lib/auth/referral"

// document.cookie is the only ambient global this module touches — replaced wholesale per test,
// mirroring src/lib/sw/register.test.ts's vi.stubGlobal idiom (no DOM lib in this project).
function stubCookie(cookie: string): void {
	vi.stubGlobal("document", { cookie })
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("getReferral (fake document.cookie)", () => {
	it("returns an empty object when there are no cookies at all", () => {
		stubCookie("")

		expect(getReferral()).toEqual({})
	})

	it("reads a valid refId/affId pair", () => {
		stubCookie("refId=abc123; affId=def456")

		expect(getReferral()).toEqual({ refId: "abc123", affId: "def456" })
	})

	it("reads refId alone when affId is absent", () => {
		stubCookie("refId=abc123")

		expect(getReferral()).toEqual({ refId: "abc123" })
	})

	it("accepts a value at the 127-char boundary", () => {
		stubCookie(`refId=${"a".repeat(127)}`)

		expect(getReferral()).toEqual({ refId: "a".repeat(127) })
	})

	it("rejects a value at the 128-char boundary", () => {
		stubCookie(`refId=${"a".repeat(128)}`)

		expect(getReferral()).toEqual({})
	})

	it("rejects an empty value but keeps a valid sibling", () => {
		stubCookie("refId=; affId=def456")

		expect(getReferral()).toEqual({ affId: "def456" })
	})

	it("ignores unrelated cookies", () => {
		stubCookie("theme=dark; session=xyz789")

		expect(getReferral()).toEqual({})
	})

	it("does not match a cookie whose name only ends with the target name", () => {
		stubCookie("xrefId=should-not-match; refId=abc123")

		expect(getReferral()).toEqual({ refId: "abc123" })
	})

	it("percent-decodes a URI-encoded value", () => {
		stubCookie("refId=abc%20123")

		expect(getReferral()).toEqual({ refId: "abc 123" })
	})

	it("falls back to the raw value on a malformed percent-sequence", () => {
		stubCookie("refId=abc%zzdef")

		expect(getReferral()).toEqual({ refId: "abc%zzdef" })
	})
})
