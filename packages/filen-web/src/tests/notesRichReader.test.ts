// @vitest-environment jsdom
//
// jsdom: both DOMPurify and the Quill 1 converter need a real `document`.

import { describe, expect, it } from "vitest"
import { richReaderHtml } from "@/features/notes/components/reader/richReader.logic"

function v2Item(dataList: string, inner: string, className?: string): string {
	const cls = className ? ` class="${className}"` : ""

	return `<li data-list="${dataList}"${cls}><span class="ql-ui" contenteditable="false"></span>${inner}</li>`
}

describe("richReaderHtml", () => {
	it("renders Quill 2 lists as the Quill 1 containers the reader styles", () => {
		const html = `<ol>${v2Item("bullet", "a")}${v2Item("bullet", "b", "ql-indent-1")}${v2Item("checked", "done")}${v2Item("unchecked", "todo")}${v2Item("ordered", "n")}</ol>`

		expect(richReaderHtml(html)).toBe(
			'<ul><li>a</li><li class="ql-indent-1">b</li></ul><ul data-checked="true"><li>done</li></ul><ul data-checked="false"><li>todo</li></ul><ol><li>n</li></ol>'
		)
	})

	it("renders a Quill 2 code block as one <pre>", () => {
		const html =
			'<div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block">if (a &lt; b) {</div><div class="ql-code-block">  run()</div></div>'

		expect(richReaderHtml(html)).toBe('<pre class="ql-syntax" spellcheck="false">if (a &lt; b) {\n  run()\n</pre>')
	})

	it("leaves Quill 1 content as sanitized", () => {
		const html = '<ul data-checked="true"><li>done</li></ul><ul><li>a</li></ul><pre class="ql-syntax">x\n</pre>'

		expect(richReaderHtml(html)).toBe(html)
	})

	it("sanitizes before converting", () => {
		const html = `<ol>${v2Item("bullet", '<img src="x" onerror="alert(1)">a<script>window.__xss = 1</script>')}</ol>`

		expect(richReaderHtml(html)).toBe("<ul><li>a</li></ul>")
	})
})
