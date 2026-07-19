// @vitest-environment happy-dom

import { describe, it, expect } from "vitest"
import { quillV2ToLegacyV1 } from "@/components/textEditor/richText/quillCompat"

// Realistic Quill v2 markup. The expected outputs below are Quill v1's exact getHTML() form — captured
// from real Quill 1.3.7 — i.e. the bytes web/desktop (Quill 1.3.7) and @filen/utils read.
function v2Item(dataList: string, inner: string, className?: string): string {
	const cls = className ? ` class="${className}"` : ""

	return `<li data-list="${dataList}"${cls}><span class="ql-ui" contenteditable="false"></span>${inner}</li>`
}

// A v2 code-block container: per-line <div class="ql-code-block">; `lines` are each line's innerHTML as
// Quill v2 emits it (special characters already HTML-escaped, e.g. "&lt;").
function v2CodeBlock(lines: string[]): string {
	const inner = lines.map(line => `<div class="ql-code-block">${line}</div>`).join("")

	return `<div class="ql-code-block-container" spellcheck="false">${inner}</div>`
}

describe("quillV2ToLegacyV1", () => {
	describe("lists", () => {
		it("returns non-list, non-codeblock content unchanged", () => {
			const html = "<p>hello <strong>world</strong></p><h1>title</h1>"

			expect(quillV2ToLegacyV1(html)).toBe(html)
		})

		it("returns already-v1 list markup unchanged (no data-list present)", () => {
			const html = '<ul data-checked="true"><li>A</li></ul><ol><li>B</li></ol><ul><li>C</li></ul>'

			expect(quillV2ToLegacyV1(html)).toBe(html)
		})

		it("converts a single checked item and strips the ql-ui span", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("checked", "A")}</ol>`)).toBe('<ul data-checked="true"><li>A</li></ul>')
		})

		it("converts a single unchecked item", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("unchecked", "A")}</ol>`)).toBe('<ul data-checked="false"><li>A</li></ul>')
		})

		it("converts a bullet item", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("bullet", "A")}</ol>`)).toBe("<ul><li>A</li></ul>")
		})

		it("converts an ordered item", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("ordered", "A")}</ol>`)).toBe("<ol><li>A</li></ol>")
		})

		it("merges consecutive same-state items into one container", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("checked", "A")}${v2Item("checked", "B")}</ol>`)).toBe(
				'<ul data-checked="true"><li>A</li><li>B</li></ul>'
			)
		})

		it("splits a checked run from an unchecked run into separate containers", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("checked", "A")}${v2Item("unchecked", "B")}</ol>`)).toBe(
				'<ul data-checked="true"><li>A</li></ul><ul data-checked="false"><li>B</li></ul>'
			)
		})

		it("splits a mixed [checked, unchecked, bullet, ordered] run into four v1 containers", () => {
			const html = `<ol>${v2Item("checked", "A")}${v2Item("unchecked", "B")}${v2Item("bullet", "C")}${v2Item("ordered", "D")}</ol>`

			expect(quillV2ToLegacyV1(html)).toBe(
				'<ul data-checked="true"><li>A</li></ul><ul data-checked="false"><li>B</li></ul><ul><li>C</li></ul><ol><li>D</li></ol>'
			)
		})

		it("normalizes an empty item to <li><br></li>", () => {
			expect(quillV2ToLegacyV1(`<ol>${v2Item("unchecked", "")}</ol>`)).toBe('<ul data-checked="false"><li><br></li></ul>')
		})

		it("preserves inline formatting inside an item", () => {
			const html = `<ol>${v2Item("checked", 'Buy <strong>organic</strong> <a href="https://x.test">milk</a>')}</ol>`

			expect(quillV2ToLegacyV1(html)).toBe(
				'<ul data-checked="true"><li>Buy <strong>organic</strong> <a href="https://x.test">milk</a></li></ul>'
			)
		})

		it("strips only the ql-ui span, preserving any other inline span", () => {
			const html = '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>see <span class="mention">@bob</span></li></ol>'

			expect(quillV2ToLegacyV1(html)).toBe('<ol><li>see <span class="mention">@bob</span></li></ol>')
		})

		it("preserves ql-indent-N classes on the <li> without splitting the container", () => {
			const html = `<ol>${v2Item("bullet", "Top")}${v2Item("bullet", "Sub", "ql-indent-1")}</ol>`

			expect(quillV2ToLegacyV1(html)).toBe('<ul><li>Top</li><li class="ql-indent-1">Sub</li></ul>')
		})

		it("only rewrites v2 containers in a mixed v1+v2 document", () => {
			const html = `<ul data-checked="true"><li>old</li></ul><ol>${v2Item("bullet", "new")}</ol>`

			expect(quillV2ToLegacyV1(html)).toBe('<ul data-checked="true"><li>old</li></ul><ul><li>new</li></ul>')
		})
	})

	describe("code blocks", () => {
		it("collapses per-line divs into one <pre> with a trailing newline", () => {
			expect(quillV2ToLegacyV1(v2CodeBlock(["const x = 1;", "const y = 2;"]))).toBe(
				'<pre class="ql-syntax" spellcheck="false">const x = 1;\nconst y = 2;\n</pre>'
			)
		})

		it("re-escapes special characters and preserves leading indentation", () => {
			expect(quillV2ToLegacyV1(v2CodeBlock(["if (a &lt; b) {", "  return;"]))).toBe(
				'<pre class="ql-syntax" spellcheck="false">if (a &lt; b) {\n  return;\n</pre>'
			)
		})

		it("converts a single-line code block", () => {
			expect(quillV2ToLegacyV1(v2CodeBlock(["hello"]))).toBe('<pre class="ql-syntax" spellcheck="false">hello\n</pre>')
		})

		it("preserves empty lines inside a code block", () => {
			expect(quillV2ToLegacyV1(v2CodeBlock(["a", "", "b"]))).toBe('<pre class="ql-syntax" spellcheck="false">a\n\nb\n</pre>')
		})
	})

	describe("combined / whole-document", () => {
		it("leaves surrounding paragraphs byte-identical", () => {
			const html = `<p>Intro</p><ol>${v2Item("checked", "A")}</ol><p>Outro</p>`

			expect(quillV2ToLegacyV1(html)).toBe('<p>Intro</p><ul data-checked="true"><li>A</li></ul><p>Outro</p>')
		})

		it("converts lists and code blocks together in one document", () => {
			const html = `<p>x</p><ol>${v2Item("checked", "A")}</ol>${v2CodeBlock(["run();"])}`

			expect(quillV2ToLegacyV1(html)).toBe(
				'<p>x</p><ul data-checked="true"><li>A</li></ul><pre class="ql-syntax" spellcheck="false">run();\n</pre>'
			)
		})

		it("is idempotent and leaves no v2 markers", () => {
			const html = `<p>x</p><ol>${v2Item("checked", "A")}${v2Item("bullet", "B")}</ol>${v2CodeBlock(["a", "b"])}`
			const once = quillV2ToLegacyV1(html)
			const twice = quillV2ToLegacyV1(once)

			expect(twice).toBe(once)
			expect(once).not.toContain("data-list")
			expect(once).not.toContain("ql-ui")
			expect(once).not.toContain("ql-code-block")
		})
	})
})
