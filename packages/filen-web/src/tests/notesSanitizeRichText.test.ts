// @vitest-environment jsdom
//
// DOMPurify needs a real `window`/`document` to do anything (with none, `DOMPurify.isSupported` is
// false and `.sanitize` degrades to a passthrough — see node_modules/dompurify's own `getGlobal`), and
// DOMPurify's own test suite is written against jsdom specifically — so this ONE file opts into jsdom
// via the per-file pragma while the rest of the suite stays on vitest.config.ts's global "node"
// environment (no other unit test needs a DOM).

import { describe, expect, it } from "vitest"
import { sanitizeRichTextHtml, RICH_TEXT_ALLOWED_TAGS, RICH_TEXT_ALLOWED_ATTR } from "@/features/notes/lib/sanitizeRichText"

// Config pinning: the allowlist MUST match
// packages/filen-mobile/src/components/textEditor/richText/dom.tsx byte-for-byte — a reviewer diffs
// these two arrays directly, so any drift here is a real cross-client compat bug, not just a test
// nicety.
describe("sanitizeRichTextHtml — allowlist pinning", () => {
	it("pins the exact allowed tag list mobile's dom.tsx uses", () => {
		expect([...RICH_TEXT_ALLOWED_TAGS]).toEqual([
			"p",
			"strong",
			"em",
			"u",
			"a",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"code",
			"ol",
			"ul",
			"li",
			"blockquote",
			"pre",
			"br",
			"span",
			"div"
		])
	})

	it("pins the exact allowed attribute list mobile's dom.tsx uses", () => {
		expect([...RICH_TEXT_ALLOWED_ATTR]).toEqual(["href", "target", "rel", "src", "alt", "class", "style"])
	})
})

describe("sanitizeRichTextHtml — XSS fixture", () => {
	it("strips <script> tags entirely", () => {
		const out = sanitizeRichTextHtml('<p>hello</p><script>alert("xss")</script>')

		expect(out).not.toContain("<script")
		expect(out).not.toContain("alert")
		expect(out).toContain("<p>hello</p>")
	})

	it("strips an onerror attribute (and the disallowed img tag it rides on)", () => {
		const out = sanitizeRichTextHtml('<p>note</p><img src="x" onerror="alert(1)">')

		expect(out).not.toContain("onerror")
		expect(out).not.toContain("<img")
	})

	it("strips a javascript: href", () => {
		const out = sanitizeRichTextHtml('<a href="javascript:alert(1)">click</a>')

		expect(out).not.toContain("javascript:")
	})

	it("strips a disallowed tag (iframe) while preserving allowlisted structure around it", () => {
		const out = sanitizeRichTextHtml('<p>before</p><iframe src="https://evil.example"></iframe><p>after</p>')

		expect(out).not.toContain("<iframe")
		expect(out).toContain("<p>before</p>")
		expect(out).toContain("<p>after</p>")
	})

	it("strips an inline event-handler attribute (onclick) off an otherwise-allowed tag", () => {
		const out = sanitizeRichTextHtml('<p onclick="alert(1)">click me</p>')

		expect(out).not.toContain("onclick")
		expect(out).toContain("click me")
	})

	it("preserves allowlisted structure: headings, lists, formatting, blockquote", () => {
		const html =
			"<h1>Title</h1><p><strong>bold</strong> <em>em</em> <u>u</u></p>" +
			"<ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote><pre><code>code</code></pre>"
		const out = sanitizeRichTextHtml(html)

		expect(out).toContain("<h1>Title</h1>")
		expect(out).toContain("<strong>bold</strong>")
		expect(out).toContain("<em>em</em>")
		expect(out).toContain("<u>u</u>")
		expect(out).toContain("<li>one</li>")
		expect(out).toContain("<blockquote>quoted</blockquote>")
		expect(out).toContain("<code>code</code>")
	})
})

describe("sanitizeRichTextHtml — afterSanitizeAttributes link-hardening hook", () => {
	it("forces target=_blank and rel=noopener noreferrer onto a surviving <a href>", () => {
		const out = sanitizeRichTextHtml('<a href="https://example.com">link</a>')

		expect(out).toContain('href="https://example.com"')
		expect(out).toContain('target="_blank"')
		expect(out).toContain('rel="noopener noreferrer"')
	})

	it("does not add target/rel to an <a> with no href", () => {
		const out = sanitizeRichTextHtml("<a>no href</a>")

		expect(out).not.toContain("target=")
		expect(out).not.toContain("rel=")
	})
})
