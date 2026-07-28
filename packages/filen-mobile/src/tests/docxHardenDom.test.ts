// @vitest-environment happy-dom

import { describe, it, expect } from "vitest"

import {
	hardenDocxDom,
	hardenDocxStyles,
	hardenDocxInlineStyles,
	DOCX_EXTERNAL_URL_ATTRIBUTE
} from "@/components/docxPreview/linkSafety"

function render(html: string): HTMLElement {
	const root = document.createElement("div")

	root.innerHTML = html

	return root
}

describe("hardenDocxDom — anchors", () => {
	it("strips the href of a javascript: link so nothing is left to activate", () => {
		const root = render(`<a href="javascript:alert(1)">Open full report</a>`)

		hardenDocxDom(root)

		const anchor = root.querySelector("a")

		expect(anchor?.hasAttribute("href")).toBe(false)
		expect(anchor?.hasAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)).toBe(false)
		// The text survives — only the link affordance is removed.
		expect(anchor?.textContent).toBe("Open full report")
	})

	it("routes an allowlisted external link through the data attribute with an inert href", () => {
		const root = render(`<a href="https://example.com/doc">Report</a>`)

		hardenDocxDom(root)

		const anchor = root.querySelector("a")

		expect(anchor?.getAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)).toBe("https://example.com/doc")
		expect(anchor?.getAttribute("href")).toBe("#")
	})

	it("leaves an in-document fragment untouched so bookmarks still work", () => {
		const root = render(`<a href="#section-2">Jump</a>`)

		hardenDocxDom(root)

		const anchor = root.querySelector("a")

		expect(anchor?.getAttribute("href")).toBe("#section-2")
		expect(anchor?.hasAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)).toBe(false)
	})

	it("clears a document-supplied data-external-url on EVERY anchor, including fragments", () => {
		// The click handler reads this attribute before it re-checks the href, so a value that
		// survived the sweep would be handed to the OS. Fragment anchors take an early `continue`,
		// which is exactly where the clear used to be skipped.
		const root = render(
			`<a href="#bookmark" ${DOCX_EXTERNAL_URL_ATTRIBUTE}="javascript:alert(1)">frag</a>` +
				`<a href="javascript:alert(1)" ${DOCX_EXTERNAL_URL_ATTRIBUTE}="https://evil.example">blocked</a>`
		)

		hardenDocxDom(root)

		const [fragment, blocked] = Array.from(root.querySelectorAll("a"))

		expect(fragment?.hasAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)).toBe(false)
		expect(blocked?.hasAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)).toBe(false)
	})

	it("blocks an href carrying an allowlisted scheme plus a smuggled second scheme", () => {
		const root = render(`<a href="tel:+1&#10;javascript:alert(1)">call</a>`)

		hardenDocxDom(root)

		expect(root.querySelector("a")?.hasAttribute("href")).toBe(false)
	})

	it("sweeps anchors anywhere in the tree, not just direct children", () => {
		const root = render(`<div><section><p><a href="javascript:alert(1)">deep</a></p></section></div>`)

		hardenDocxDom(root)

		expect(root.querySelector("a")?.hasAttribute("href")).toBe(false)
	})

	it("handles a document with no anchors at all", () => {
		const root = render(`<p>Just text</p>`)

		expect(() => hardenDocxDom(root)).not.toThrow()
	})
})

describe("hardenDocxStyles — injected CSS cannot beacon out", () => {
	it("neutralises a remote url() injected through a broken-out CSS rule", () => {
		// docx-preview builds <style> content by raw string concatenation with no escaping, so a
		// document-controlled colour value can close its rule and add one of its own. Without this,
		// opening the document fires a request to the attacker's host with no interaction at all.
		const root = render(`<style>.docx span { color: red } * { background-image: url(https://evil.example/beacon) }</style>`)

		hardenDocxStyles(root)

		const css = root.querySelector("style")?.textContent ?? ""

		expect(css).not.toContain("evil.example")
		expect(css).toContain("none")
		// The document's own rule is preserved.
		expect(css).toContain("color: red")
	})

	it("neutralises quoted and whitespace-padded remote urls", () => {
		const root = render(
			`<style>a { background: url( "https://evil.example/a" ) } b { background: url('http://evil.example/b') }</style>`
		)

		hardenDocxStyles(root)

		expect(root.querySelector("style")?.textContent).not.toContain("evil.example")
	})

	it("neutralises a protocol-relative url", () => {
		const root = render(`<style>a { background: url(//evil.example/c) }</style>`)

		hardenDocxStyles(root)

		expect(root.querySelector("style")?.textContent).not.toContain("evil.example")
	})

	it("keeps data: and blob: urls, which is how the library inlines real images and fonts", () => {
		const root = render(
			`<style>@font-face { src: url(data:font/woff2;base64,AAAA) } .i { background: url("blob:abc-123") }</style>`
		)

		hardenDocxStyles(root)

		const css = root.querySelector("style")?.textContent ?? ""

		expect(css).toContain("data:font/woff2;base64,AAAA")
		expect(css).toContain("blob:abc-123")
	})

	it("leaves a stylesheet with no url() completely untouched", () => {
		const original = `.docx p { margin: 0; color: #000 }`
		const root = render(`<style>${original}</style>`)

		hardenDocxStyles(root)

		expect(root.querySelector("style")?.textContent).toBe(original)
	})

	it("is case-insensitive about the url token and the scheme", () => {
		const root = render(`<style>a { background: URL(HTTPS://EVIL.example/d) }</style>`)

		hardenDocxStyles(root)

		expect(root.querySelector("style")?.textContent?.toLowerCase()).not.toContain("evil.example")
	})

	it("sanitises every style element, not only the first", () => {
		const root = render(`<style>a { background: url(https://evil.example/1) }</style><style>b { background: url(https://evil.example/2) }</style>`)

		hardenDocxStyles(root)

		for (const style of Array.from(root.querySelectorAll("style"))) {
			expect(style.textContent).not.toContain("evil.example")
		}
	})

	it("neutralises a url whose quoted target contains the other quote character", () => {
		// `url("https://x/?q='")` is legal CSS. A single character class covering both quotes plus `)`
		// stops at the apostrophe and leaves the real URL in place.
		const root = render(`<style>a { background: url("https://evil.example/?q='") }</style>`)

		hardenDocxStyles(root)

		expect(root.querySelector("style")?.textContent).not.toContain("evil.example")
	})

	it("removes @import in both the url() and bare-string forms", () => {
		const root = render(`<style>@import url(https://evil.example/a); @import "https://evil.example/b"; p { color: red }</style>`)

		hardenDocxStyles(root)

		const css = root.querySelector("style")?.textContent ?? ""

		expect(css).not.toContain("evil.example")
		expect(css).not.toContain("@import")
		expect(css).toContain("color: red")
	})

	it("neutralises a bare-string url in image-set(), which never goes through url()", () => {
		const root = render(`<style>a { background-image: image-set("https://evil.example/x.png" 1x) }</style>`)

		hardenDocxStyles(root)

		expect(root.querySelector("style")?.textContent).not.toContain("evil.example")
	})

	it("is reached through hardenDocxDom, not only when called directly", () => {
		const root = render(`<style>a { background: url(https://evil.example/x) }</style><a href="javascript:alert(1)">x</a>`)

		hardenDocxDom(root)

		expect(root.querySelector("style")?.textContent).not.toContain("evil.example")
		expect(root.querySelector("a")?.hasAttribute("href")).toBe(false)
	})
})

describe("hardenDocxInlineStyles — the VML style-attribute bypass", () => {
	it("removes an inline background url pointing at a remote host", () => {
		// docx-preview copies a VML shape's `style` attribute straight through, so any <w:pict> in the
		// document carries an attacker-authored declaration block that never appears in a <style>
		// element at all — the <style> sweep cannot see it.
		const root = render(`<div style="background:url('https://evil.example/beacon');color:blue"></div>`)

		hardenDocxInlineStyles(root)

		const style = root.querySelector("div")?.getAttribute("style") ?? ""

		expect(style).not.toContain("evil.example")
		// Unrelated declarations in the same block survive.
		expect(style).toContain("blue")
	})

	it("keeps an inline data: url, which is how real embedded images arrive", () => {
		const root = render(`<div style="background-image:url(data:image/png;base64,AAAA)"></div>`)

		hardenDocxInlineStyles(root)

		expect(root.querySelector("div")?.getAttribute("style")).toContain("data:image/png")
	})

	it("leaves an inline style with no url completely alone", () => {
		const root = render(`<div style="color:red"></div>`)

		hardenDocxInlineStyles(root)

		expect(root.querySelector("div")?.getAttribute("style")).toContain("red")
	})

	it("sweeps every element carrying a style attribute", () => {
		const root = render(
			`<div style="background:url(https://evil.example/1)"></div><span style="background:url(https://evil.example/2)"></span>`
		)

		hardenDocxInlineStyles(root)

		for (const element of Array.from(root.querySelectorAll("[style]"))) {
			expect(element.getAttribute("style") ?? "").not.toContain("evil.example")
		}
	})

	it("is reached through hardenDocxDom", () => {
		const root = render(`<div style="background:url('https://evil.example/x')"></div>`)

		hardenDocxDom(root)

		expect(root.querySelector("div")?.getAttribute("style") ?? "").not.toContain("evil.example")
	})
})
