import { describe, expect, it } from "vitest"
import { isSafeLinkHref } from "@/features/preview/components/docxViewer.logic"

describe("isSafeLinkHref", () => {
	it("allows https", () => {
		expect(isSafeLinkHref("https://example.com")).toBe(true)
	})

	it("allows http", () => {
		expect(isSafeLinkHref("http://example.com")).toBe(true)
	})

	it("allows mailto", () => {
		expect(isSafeLinkHref("mailto:a@example.com")).toBe(true)
	})

	it("rejects javascript:", () => {
		expect(isSafeLinkHref("javascript:alert(1)")).toBe(false)
	})

	it("rejects a javascript: scheme disguised with case and embedded whitespace", () => {
		expect(isSafeLinkHref("   Java\tScript:alert(1)")).toBe(false)
	})

	it("rejects data:", () => {
		expect(isSafeLinkHref("data:text/html,<script>alert(1)</script>")).toBe(false)
	})

	it("rejects vbscript:", () => {
		expect(isSafeLinkHref("vbscript:msgbox(1)")).toBe(false)
	})

	it("rejects file:", () => {
		expect(isSafeLinkHref("file:///etc/passwd")).toBe(false)
	})

	it("treats an empty relationship target as safe (resolves to the inert placeholder base)", () => {
		expect(isSafeLinkHref("")).toBe(true)
	})

	it("treats an anchor-only href as safe", () => {
		expect(isSafeLinkHref("#section")).toBe(true)
	})

	it("fails closed on a string the URL parser can't resolve even against a base", () => {
		expect(isSafeLinkHref("http://")).toBe(false)
	})
})
