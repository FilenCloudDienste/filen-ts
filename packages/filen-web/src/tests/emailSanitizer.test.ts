// @vitest-environment jsdom

import DOMPurify from "dompurify"
import { describe, expect, it } from "vitest"
import { EMAIL_MAX_LINKS } from "@filen/shared/dom"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"

// HTML from untrusted files on real DOMPurify: nothing that runs, submits or embeds survives, nothing remote loads
// (each removal counted), the message's own parts resolve, and the links it keeps are listed once each.

const NO_CID = (): string | null => null

function body(html: string): Document {
	return new DOMParser().parseFromString(sanitizeEmailHtml(html, NO_CID).html, "text/html")
}

describe("sanitizeEmailHtml", () => {
	it("keeps the document and its style element", () => {
		const result = sanitizeEmailHtml("<html><head><style>p{color:red}</style></head><body><p>Hi</p></body></html>", NO_CID)

		expect(result.html).toContain("<head><style>p{color:red}</style></head>")
		expect(result.html).toContain("<p>Hi</p>")
		expect(result.remoteBlocked).toBe(0)
	})

	it("drops what runs, submits, embeds or redirects", () => {
		const doc = body(
			'<meta http-equiv="refresh" content="0;url=https://x.y"><base href="https://x.y/"><link rel="stylesheet" href="https://x.y/a.css">' +
				'<script>1</script><iframe src="https://x.y"></iframe><object data="https://x.y"></object><embed src="https://x.y">' +
				'<form action="https://x.y"><input name="a"><button>go</button></form><svg><foreignObject><p>x</p></foreignObject></svg>' +
				'<p onclick="1" onmouseover="1">text</p>'
		)

		for (const tag of ["meta", "base", "link", "script", "iframe", "object", "embed", "form", "input", "button", "foreignObject"]) {
			expect(doc.getElementsByTagName(tag)).toHaveLength(0)
		}

		expect(doc.querySelector("p")?.getAttributeNames()).toEqual([])
	})

	it("removes and counts every remote load, keeps inline images and resolves the message's parts", () => {
		const result = sanitizeEmailHtml(
			'<body background="https://x.y/bg.png"><img src="https://cdn.filen.io/a.png" srcset="https://x.y/b.png 2x">' +
				'<img src="data:image/png;base64,AA=="><img src="cid:part1@x"><img src="cid:missing"><video poster="https://x.y/p.png"></video>' +
				'<svg><image xlink:href="https://x.y/s.png"></image></svg></body>',
			id => (id === "part1@x" ? "blob:local/1" : null)
		)
		const doc = new DOMParser().parseFromString(result.html, "text/html")
		const sources = [...doc.querySelectorAll("img")].map(img => img.getAttribute("src"))

		expect(sources).toEqual([null, "data:image/png;base64,AA==", "blob:local/1", null])
		expect(doc.body.hasAttribute("background")).toBe(false)
		expect(doc.querySelector("img")?.hasAttribute("srcset")).toBe(false)
		expect(doc.querySelector("video")?.hasAttribute("poster")).toBe(false)
		expect(result.html).not.toContain("https://")
		expect(result.remoteBlocked).toBe(6)
	})

	it("makes CSS that would load from outside inert, escapes included", () => {
		const result = sanitizeEmailHtml(
			"<html><head><style>@import url(https://x.y/a.css); @font-face{font-family:F;src:url(https://x.y/f.woff)} " +
				"body{background:url('https://x.y/a.png')} p{background:\\75rl(https://x.y/b.png)} " +
				'i{background:image-set("https://x.y/c.png" 1x)} b{background:url(data:image/png;base64,AA==)}</style></head>' +
				'<body><p style="background-image:url(&quot;https://x.y/d.png&quot;)">x</p><i style="background:url(cid:p2)">y</i></body></html>',
			id => (id === "p2" ? "blob:local/2" : null)
		)

		// An image-set the parser does not know: the declaration is dropped, its string never loads.
		expect(result.html).toContain('blocked-image-set("https://x.y/c.png" 1x)')
		expect(result.html.replace(/blocked-image-set\([^)]*\)/g, "")).not.toContain("https://")
		expect(result.html).not.toMatch(/@import|@font-face|[^-]image-set\(/)
		expect(result.html).toContain("url(data:image/png;base64,AA==)")
		expect(result.html).toContain("url('blob:local/2')")
		expect(result.remoteBlocked).toBe(6)
	})

	it("lists http(s) and mailto links once each, up to the cap, and drops other schemes", () => {
		const many = Array.from({ length: EMAIL_MAX_LINKS + 5 }, (_, index) => `<a href="https://x.y/${String(index)}">n</a>`).join("")
		const result = sanitizeEmailHtml(
			'<a href="https://example.com/a" target="_blank">  Read   more </a><a href="https://example.com/a">again</a>' +
				'<a href="mailto:a@b.c"></a><a href="javascript:alert(1)">bad</a><a href="ftp://x.y/f">ftp</a><span href="https://x.y">no</span>' +
				many,
			NO_CID
		)
		const doc = new DOMParser().parseFromString(result.html, "text/html")

		expect(result.links.slice(0, 2)).toEqual([
			{ href: "https://example.com/a", text: "Read more" },
			{ href: "mailto:a@b.c", text: "mailto:a@b.c" }
		])
		expect(result.links).toHaveLength(EMAIL_MAX_LINKS)
		expect(doc.querySelector("a")?.hasAttribute("target")).toBe(false)
		expect([...doc.querySelectorAll("a")].slice(3, 5).map(a => a.getAttribute("href"))).toEqual([null, null])
		expect(doc.querySelector("span")?.hasAttribute("href")).toBe(false)
	})

	// Each sanitizer has its own DOMPurify instance: running one changes nothing in another's output.
	it("leaves notes and the default instance as they were", () => {
		const NOTE = '<p class="ql-align-center">Hi <a href="https://example.com">there</a></p>'
		const before = sanitizeRichTextHtml(NOTE)
		const defaultBefore = DOMPurify.sanitize('<img src="https://x.y/a.png">')

		sanitizeEmailHtml('<img src="https://x.y/a.png"><a href="https://example.com" target="_blank">x</a>', NO_CID)

		expect(sanitizeRichTextHtml(NOTE)).toBe(before)
		expect(DOMPurify.sanitize('<img src="https://x.y/a.png">')).toBe(defaultBefore)
	})
})
