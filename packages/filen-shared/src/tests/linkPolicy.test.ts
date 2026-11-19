import { describe, expect, it } from "vitest"
import { classifyLink, isWebLinkScheme, LINK_SCHEMES } from "@filen/shared"

describe("classifyLink", () => {
	it("allows the eight user-navigable schemes, keeping the url's casing", () => {
		expect(classifyLink("https://example.com/Reset?Token=AbC")).toEqual({
			kind: "external",
			url: "https://example.com/Reset?Token=AbC",
			scheme: "https:"
		})
		expect(classifyLink("http://example.com")).toMatchObject({ kind: "external", scheme: "http:" })
		expect(classifyLink("mailto:a@example.com")).toMatchObject({ kind: "external", scheme: "mailto:" })
		expect(classifyLink("tel:+15551234")).toMatchObject({ kind: "external", scheme: "tel:" })
		expect(classifyLink("sms:+15551234")).toMatchObject({ kind: "external", scheme: "sms:" })
		expect(classifyLink("whatsapp://send?text=hi")).toMatchObject({ kind: "external", scheme: "whatsapp:" })
		expect(classifyLink("geo:37.78,-122.41")).toMatchObject({ kind: "external", scheme: "geo:" })
		expect(classifyLink("maps:?q=Berlin")).toMatchObject({ kind: "external", scheme: "maps:" })
		expect(LINK_SCHEMES.map(([, scheme]) => scheme)).toEqual([
			"http:",
			"https:",
			"mailto:",
			"tel:",
			"sms:",
			"whatsapp:",
			"geo:",
			"maps:"
		])
	})

	it("matches the scheme case-insensitively and trims surrounding whitespace", () => {
		expect(classifyLink("  HTTPS://Example.com/A  ")).toEqual({ kind: "external", url: "HTTPS://Example.com/A", scheme: "https:" })
		expect(classifyLink("MailTo:a@b.com")).toMatchObject({ kind: "external", scheme: "mailto:" })
	})

	it("classifies a pure fragment as internal, whatever follows the #", () => {
		expect(classifyLink("#section-2")).toEqual({ kind: "internal", fragment: "section-2" })
		expect(classifyLink("#javascript:alert(1)")).toEqual({ kind: "internal", fragment: "javascript:alert(1)" })
		expect(classifyLink("#")).toEqual({ kind: "internal", fragment: "" })
	})

	it("blocks script, data, file and every other unlisted scheme", () => {
		for (const href of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"vbscript:msgbox(1)",
			"data:text/html,<script>alert(1)</script>",
			"file:///etc/passwd",
			"blob:https://example.com/uuid",
			"content://x",
			"intent://x#Intent;end",
			"ftp://host/file",
			"chrome://settings"
		]) {
			expect(classifyLink(href)).toEqual({ kind: "blocked" })
		}
	})

	it("blocks obfuscated schemes and any interior whitespace or control character", () => {
		for (const href of [
			"java\tscript:alert(1)",
			"   Java\tScript:alert(1)",
			"\x01javascript:alert(1)",
			"\x01https://example.com",
			"tel:+1\njavascript:alert(1)",
			"https://exa\nmple.com",
			"https://example.com/a b",
			"https://example.com/\u0085",
			"https://example.com/\x7f"
		]) {
			expect(classifyLink(href)).toEqual({ kind: "blocked" })
		}
	})

	it("blocks relative, protocol-relative and slash-less http(s) references", () => {
		for (const href of [
			"docs/setup.md",
			"/abs",
			"//example.com/x",
			"https:/reset/x",
			"https:d/uuid#key",
			"http:example.com",
			"http:\\\\example.com"
		]) {
			expect(classifyLink(href)).toEqual({ kind: "blocked" })
		}
	})

	it("blocks http(s) urls without a host", () => {
		for (const href of ["http://", "https://", "https://user:pw@", "https://:443/x", "https:///", "https://?q", "https://[::1"]) {
			expect(classifyLink(href)).toEqual({ kind: "blocked" })
		}

		expect(classifyLink("https://user@example.com:8443/x")).toMatchObject({ kind: "external" })
		expect(classifyLink("https://[::1]:8080/")).toMatchObject({ kind: "external" })
	})

	it("blocks empty and non-string input", () => {
		expect(classifyLink("")).toEqual({ kind: "blocked" })
		expect(classifyLink("   ")).toEqual({ kind: "blocked" })
		expect(classifyLink(null)).toEqual({ kind: "blocked" })
		expect(classifyLink(undefined)).toEqual({ kind: "blocked" })
	})
})

describe("isWebLinkScheme", () => {
	it("is true for http(s) only", () => {
		expect(LINK_SCHEMES.filter(([, scheme]) => isWebLinkScheme(scheme)).map(([, scheme]) => scheme)).toEqual(["http:", "https:"])
	})
})
