// @vitest-environment jsdom

import DOMPurify from "dompurify"
import { describe, expect, it } from "vitest"
import { EMAIL_MAX_HTML_CHARS, EMAIL_MAX_LINKS } from "@filen/shared/dom"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"

// HTML from untrusted files on real DOMPurify: nothing that runs, submits or embeds survives, nothing remote loads
// (each removal counted, CSS judged on its escapes decoded and never rewritten), the message's own parts resolve, and
// links never stay links: their address moves to data-filen-href and they are listed once each by their visible text.

const NO_CID = (): string | null => null

function sanitized(html: string): { doc: Document; remoteBlocked: number; html: string } {
	const result = sanitizeEmailHtml(html, NO_CID)

	return { doc: new DOMParser().parseFromString(result.html, "text/html"), remoteBlocked: result.remoteBlocked, html: result.html }
}

describe("sanitizeEmailHtml", () => {
	it("makes an SVG link a listed link on real DOMPurify, never a resolved part the frame could navigate to", () => {
		const result = sanitizeEmailHtml(
			'<svg><a xlink:href="cid:img"><rect width="9" height="9"></rect></a><a xlink:href="https://example.com/s"><text>S</text></a></svg>',
			() => "blob:https://app.example/part"
		)

		expect(result.html).not.toContain("blob:")
		expect(result.html).not.toContain("xlink:href")
		expect(result.links).toEqual([{ href: "https://example.com/s", text: "S" }])
	})

	it("keeps the document and its style element", () => {
		const result = sanitizeEmailHtml("<html><head><style>p{color:red}</style></head><body><p>Hi</p></body></html>", NO_CID)

		expect(result.html).toContain("<head><style>p{color:red}</style></head>")
		expect(result.html).toContain("<p>Hi</p>")
		expect(result.remoteBlocked).toBe(0)
	})

	it("drops what runs, submits, embeds or redirects", () => {
		const { doc } = sanitized(
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

		expect([...doc.querySelectorAll("img")].map(img => img.getAttribute("src"))).toEqual([
			null,
			"data:image/png;base64,AA==",
			"blob:local/1",
			null
		])
		expect(doc.body.hasAttribute("background")).toBe(false)
		expect(doc.querySelector("video")?.hasAttribute("poster")).toBe(false)
		expect(result.html).not.toContain("https://")
		expect(result.remoteBlocked).toBe(6)
	})

	it("drops every CSS rule and declaration that could load, never rewriting what it keeps", () => {
		const result = sanitizeEmailHtml(
			"<html><head><style>@import url(https://x.y/a.css); @font-face{font-family:F;src:url(https://x.y/f.woff)} " +
				"body{background:url('https://x.y/a.png')} i{background:image-set(\"https://x.y/c.png\" 1x)} " +
				"b{color:blue;background:url(data:image/png;base64,AA==)} u{color:\\72 ed}</style></head>" +
				'<body><p style="color:green;background-image:url(&quot;https://x.y/d.png&quot;)">x</p>' +
				'<i style="background:url(cid:p2)">y</i></body></html>',
			id => (id === "p2" ? "blob:local/2" : null)
		)

		expect(result.html).not.toContain("x.y")
		expect(result.html).toContain("b{color:blue;background:url(data:image/png;base64,AA==)}")
		// Kept as written: its escape is the browser's to decode.
		expect(result.html).toContain("u{color:\\72 ed}")
		expect(result.html).toContain('<p style="color:green">x</p>')
		expect(result.html).toContain("url('blob:local/2')")
		expect(result.remoteBlocked).toBe(5)
	})

	// Payloads that got past a single decode, a url() regex or a comment stripper that knew no strings, urls or newlines.
	it.each([
		["an escaped image-set", '<style>p{background:\\69mage-set("https://e.vil/c.png" 1x)}</style>'],
		["an escaped url(", "<style>p{background:\\75 rl(https://e.vil/px.gif)}</style>"],
		["an escaped @font-face", "<style>@\\66ont-face{font-family:F;src:url(https://e.vil/f.woff)}</style>"],
		[
			"a data: URL swallowing a later one",
			'<style>p{background:url("data:image/png,x"/**/)} q{background:url("https://e.vil/y")}</style>'
		],
		["an unquoted url() with a space", "<style>p{background:url( https://e.vil/a b)}</style>"],
		["an @media block hiding a load", "<style>@media all{p{background:url(https://e.vil/m.png)}}</style>"],
		["an escape that only looks like a comment", "<style>p{background:x\\2f*;background-image:url(https://e.vil/a)}</style>"],
		["CRLF after a hex escape in a style attribute", '<p style="background-image:\\75&#13;&#10;rl(https://e.vil/x)">x</p>'],
		["CRLF after a hex escape in an SVG fill", '<svg><rect fill="\\75&#13;&#10;rl(https://e.vil/x#g)"></rect></svg>'],
		["CRLF after a hex escape in an SVG style", "<svg><style>rect{fill:\\75&#13;&#10;rl(https://e.vil/s#g)}</style></svg>"],
		[
			"a comment opener inside an unquoted url",
			"<style>p{background:url(data:image/png,a/*)}q{background-image:url(https://e.vil/c)}r{x:y*/)}</style>"
		],
		["a comment opener inside a string", '<style>q{content:"/*";background-image:url(https://e.vil/b)}</style>'],
		["a string ended by a newline", '<style>p{x:"/*\n}q{background-image:url(https://e.vil/z)}r{y:*/"}</style>'],
		[
			"a string ended by a newline in a style attribute",
			'<p style="x:&quot;/*&#10;;background-image:url(https://e.vil/q);y:*/&quot;">x</p>'
		],
		["an SVG filter and cursor", '<svg><rect filter="url(https://e.vil/f.svg#f)" cursor="url(https://e.vil/c.png),auto"></rect></svg>'],
		[
			"an SVG fill, mask, clip-path and marker",
			'<svg><path fill="url(https://e.vil/a#g)" mask="url(https://e.vil/m#m)" clip-path="url(https://e.vil/c#c)" marker-end="url(https://e.vil/k#k)"></path></svg>'
		],
		["an escaped SVG url", '<svg><rect fill="\\75 rl(https://e.vil/a#g)"></rect></svg>'],
		["an image() function", '<style>p{background:image("https://e.vil/i.png")}</style>'],
		// A dot no digit follows ends the number: a url token comes next, and the comment opener is inside it.
		["a url after a number's dot", "<style>p{x:1.url(/*)}q{background-image:url(https://e.vil/c)}r{y:*/}</style>"],
		["a url after a leading-dot number", "<style>p{x:.5.url(/*)}q{background-image:url(https://e.vil/c)}r{y:*/}</style>"],
		["an escaped url after a number's dot", "<style>p{x:1.\\75 rl(/*)}q{background-image:url(https://e.vil/c)}r{y:*/}</style>"],
		["a url after a number's dot in a style attribute", '<q style="x:1.url(/*);background-image:url(https://e.vil/q);y:*/)">x</q>'],
		["a url after a number's dot in an SVG style", "<svg><style>a{x:1.url(/*)}rect{fill:url(https://e.vil/s#g)}b{y:*/}</style></svg>"],
		// "<!--" is a token of its own: the url after it is a url token, the comment opener inside it.
		["a url after <!--", "<style>p{x:<!--url(/*)}q{background-image:url(https://e.vil/c)}r{y:*/}</style>"],
		["a url after <!-- in a style attribute", '<q style="x:&lt;!--url(/*);background-image:url(https://e.vil/q);y:*/)">x</q>']
	])("refuses %s", (_, html) => {
		const result = sanitized(html)

		expect(result.html).not.toContain("e.vil")
		expect(result.remoteBlocked).toBeGreaterThan(0)
	})

	// A double escape reads as a plain name, which loads nothing: kept exactly as written (never decoded and rewritten).
	it.each([
		["a double escape of url(", "p{background:\\\\75 rl(https://e.vil/px.gif)}"],
		["an escaped backslash before url(", "p{background:\\5c 75 rl(https://e.vil/px.gif)}"],
		["an escaped @import", '@\\5c 69mport "https://e.vil/a.css";']
	])("keeps %s as written, inert", (_, css) => {
		const result = sanitized(`<style>${css}</style>`)

		expect(result.html).toContain(`<style>${css}</style>`)
		expect(result.remoteBlocked).toBe(0)
	})

	// Only the sanitizer marks links: a forged mark is removed, so no element becomes a link nobody wrote.
	it("drops a link mark the document carries itself", () => {
		const result = sanitizeEmailHtml(
			'<div data-filen-href="whatsapp://send?text=hi" style="position:fixed;inset:0">Read more</div><span data-filen-href="https:/evil.com">x</span>',
			NO_CID
		)

		expect(result.html).not.toContain("data-filen-href")
		expect(result.links).toEqual([])
	})

	it("keeps an SVG's local paint and fill", () => {
		const { doc, remoteBlocked } = sanitized('<svg><rect fill="url(#g)" stroke="red"></rect></svg>')

		// A url() to the document's own fragment does not load, but is not one clean data: token either: dropped, counted.
		expect(doc.querySelector("rect")?.getAttribute("stroke")).toBe("red")
		expect(remoteBlocked).toBe(1)
	})

	it("turns links into addresses the frame cannot follow, listed once each by their visible text", () => {
		const many = Array.from({ length: EMAIL_MAX_LINKS + 5 }, (_, index) => `<a href="https://x.y/${String(index)}">n</a>`).join("")
		const result = sanitizeEmailHtml(
			'<a href="https://example.com/a" target="_blank">  Read <span hidden>Filen support</span><span style="display:none">x</span> more ‮ </a>' +
				'<a href="https://example.com/a">again</a><a href="mailto:a@b.c"></a><a href="javascript:alert(1)">bad</a>' +
				'<a href="ftp://x.y/f">ftp</a><a href="https:/evil.com">repaired</a><a href="https:\\\\evil.com">repaired</a>' +
				'<a href=" https://evil.com">nbsp</a><span href="https://x.y">no</span>' +
				many,
			NO_CID
		)
		const doc = new DOMParser().parseFromString(result.html, "text/html")
		const anchors = [...doc.querySelectorAll("a")]

		expect(result.links.slice(0, 2)).toEqual([
			{ href: "https://example.com/a", text: "Read more" },
			{ href: "mailto:a@b.c", text: "mailto:a@b.c" }
		])
		expect(result.links).toHaveLength(EMAIL_MAX_LINKS)
		expect(anchors.some(anchor => anchor.hasAttribute("href") || anchor.hasAttribute("target"))).toBe(false)
		expect(anchors[0]?.getAttribute("data-filen-href")).toBe("https://example.com/a")
		expect(anchors[0]?.getAttribute("role")).toBe("link")
		// Schemes the policy refuses and addresses the URL parser had to repair are no links; a value DOMPurify trimmed (a
		// leading no-break space) is the address both the frame and the list hold.
		expect(anchors.slice(3, 8).map(anchor => anchor.getAttribute("data-filen-href"))).toEqual([
			null,
			null,
			null,
			null,
			"https://evil.com/"
		])
		expect(doc.querySelector("span[href]")).toBeNull()
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

describe("the email sanitizer's input cap", () => {
	it("refuses a document past the cap before parsing it, and reads one just under it", () => {
		const over = sanitizeEmailHtml(`<p>${"x".repeat(EMAIL_MAX_HTML_CHARS)}</p>`, NO_CID)

		expect(over).toEqual({ html: "", remoteBlocked: 0, links: [], tooLarge: true })

		const at = sanitizeEmailHtml(`<p>${"x".repeat(EMAIL_MAX_HTML_CHARS - 100)}</p>`, NO_CID)

		expect(at.tooLarge).toBe(false)
		expect(at.html).toContain("xxxx")
	})

	// Every short cid url becomes a long local one: the input fits, the output does not.
	it("refuses a document that grows past the cap as it is sanitized", () => {
		const css = "a{b:url(cid:p)}".repeat(400_000)
		const result = sanitizeEmailHtml(`<style>${css}</style>`, id => (id === "p" ? `blob:https://app.example/${"0".repeat(48)}` : null))

		expect(css.length).toBeLessThan(EMAIL_MAX_HTML_CHARS)
		expect(result).toEqual({ html: "", remoteBlocked: 0, links: [], tooLarge: true })
	})
})
