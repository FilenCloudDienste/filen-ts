import { describe, expect, it } from "vitest"
import { markdownUrlTransform } from "@/components/preview/markdown-viewer.logic"

// Mirrors docx-viewer.logic.test.ts's own isSafeLinkHref cases — markdownUrlTransform delegates to
// that exact function, so the safe/unsafe scheme verdicts must match it one for one.
describe("markdownUrlTransform", () => {
	it("keeps an https URL", () => {
		expect(markdownUrlTransform("https://example.com")).toBe("https://example.com")
	})

	it("keeps an http URL", () => {
		expect(markdownUrlTransform("http://example.com")).toBe("http://example.com")
	})

	it("keeps a mailto URL", () => {
		expect(markdownUrlTransform("mailto:a@example.com")).toBe("mailto:a@example.com")
	})

	it("drops a javascript: URL", () => {
		expect(markdownUrlTransform("javascript:alert(1)")).toBeUndefined()
	})

	it("drops a javascript: URL disguised with case and embedded whitespace", () => {
		expect(markdownUrlTransform("   Java\tScript:alert(1)")).toBeUndefined()
	})

	it("drops a data: URL", () => {
		expect(markdownUrlTransform("data:text/html,<script>alert(1)</script>")).toBeUndefined()
	})

	it("drops a vbscript: URL", () => {
		expect(markdownUrlTransform("vbscript:msgbox(1)")).toBeUndefined()
	})

	it("drops a file: URL", () => {
		expect(markdownUrlTransform("file:///etc/passwd")).toBeUndefined()
	})

	it("keeps an anchor-only href", () => {
		expect(markdownUrlTransform("#section")).toBe("#section")
	})

	it("keeps an empty href", () => {
		expect(markdownUrlTransform("")).toBe("")
	})

	it("drops a string the URL parser can't resolve even against a base", () => {
		expect(markdownUrlTransform("http://")).toBeUndefined()
	})
})
