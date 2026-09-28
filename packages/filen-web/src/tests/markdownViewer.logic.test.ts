import { describe, expect, it } from "vitest"
import { markdownUrlTransform } from "@/features/preview/components/markdownViewer.logic"

// Mirrors docxViewer.logic.test.ts's own isSafeLinkHref scheme cases — markdownUrlTransform delegates
// to that exact function — plus its own rule that only an absolute URL survives.
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

	it("drops an anchor-only href, which has no heading to target", () => {
		expect(markdownUrlTransform("#section")).toBeUndefined()
	})

	it("drops a relative href, which would resolve against the app's own route", () => {
		expect(markdownUrlTransform("docs/setup.md")).toBeUndefined()
		expect(markdownUrlTransform("/docs/setup.md")).toBeUndefined()
		expect(markdownUrlTransform("./image.png")).toBeUndefined()
	})

	it("drops a protocol-relative href", () => {
		expect(markdownUrlTransform("//example.com/x")).toBeUndefined()
	})

	it("drops an empty href", () => {
		expect(markdownUrlTransform("")).toBeUndefined()
	})

	it("drops a string the URL parser can't resolve even against a base", () => {
		expect(markdownUrlTransform("http://")).toBeUndefined()
	})
})
