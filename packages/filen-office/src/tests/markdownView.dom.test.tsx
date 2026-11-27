// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { markdownUrlTransform } from "../core/markdown/index"
import { MarkdownView, type MarkdownComponents, type MarkdownExtensions } from "../react/markdown/index"

function html(text: string, components?: MarkdownComponents, extensions?: MarkdownExtensions): string {
	return renderToStaticMarkup(
		<MarkdownView
			text={text}
			components={components}
			extensions={extensions}
		/>
	)
}

const MATH: MarkdownExtensions = { math: true }

describe("MarkdownView", () => {
	it("renders CommonMark and GFM without any styling", () => {
		expect(html("# Title\n\n**b** ~~s~~\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done")).toBe(
			"<h1>Title</h1>\n<p><strong>b</strong> <del>s</del></p>\n" +
				"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>\n" +
				'<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>\n</ul>'
		)
	})

	it("keeps raw HTML in the source inert", () => {
		const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">')

		expect(out).not.toContain("<script")
		expect(out).not.toContain("<img")
	})

	it("drops link and image URLs the shared link policy blocks", () => {
		expect(html("[a](javascript:alert(1)) [b](data:text/html,x) [c](docs/x.md) [d](#top) ![e](javascript:x)")).toBe(
			'<p><a>a</a> <a>b</a> <a>c</a> <a>d</a> <img alt="e"/></p>'
		)
	})

	it("keeps the allowed schemes and autolinks", () => {
		expect(html("[a](https://example.com/A?b=C) [m](mailto:x@example.com) [t](tel:+15551234) https://example.org")).toBe(
			'<p><a href="https://example.com/A?b=C">a</a> <a href="mailto:x@example.com">m</a> <a href="tel:+15551234">t</a> ' +
				'<a href="https://example.org">https://example.org</a></p>'
		)
	})

	it("renders the host's element slots", () => {
		const components: MarkdownComponents = { a: ({ href, children }) => <span data-href={href}>{children}</span> }

		expect(html("[a](https://example.com)", components)).toBe('<p><span data-href="https://example.com">a</span></p>')
	})

	it("takes the host's urlTransform", () => {
		expect(
			renderToStaticMarkup(
				<MarkdownView
					text="[a](https://example.com)"
					urlTransform={() => null}
				/>
			)
		).toBe("<p><a>a</a></p>")
	})
})

describe("markdownUrlTransform", () => {
	it("returns the url unchanged when the policy allows it, else undefined", () => {
		expect(markdownUrlTransform("https://example.com")).toBe("https://example.com")
		expect(markdownUrlTransform("sms:+1")).toBe("sms:+1")
		expect(markdownUrlTransform("javascript:alert(1)")).toBeUndefined()
		expect(markdownUrlTransform("#x")).toBeUndefined()
	})
})

describe("MarkdownView math (opt-in)", () => {
	it("is plain text without the extension", () => {
		expect(html("$x^2$")).toBe("<p>$x^2$</p>")
	})

	it("marks inline and display math for the host's code slot", () => {
		expect(html("Area $\\pi r^2$ here.", undefined, MATH)).toBe(
			'<p>Area <code class="language-math math-inline">\\pi r^2</code> here.</p>'
		)
		expect(html("$$\nx = 1\n$$", undefined, MATH)).toBe('<pre><code class="language-math math-display">x = 1</code></pre>')
	})

	it("keeps prices and spaced dollar signs text, as GitHub does", () => {
		expect(html("It costs $5 and $10 today.", undefined, MATH)).toBe("<p>It costs $5 and $10 today.</p>")
		expect(html("a $ b $ c", undefined, MATH)).toBe("<p>a $ b $ c</p>")
		expect(html("from $x$ to $y$", undefined, MATH)).toBe(
			'<p>from <code class="language-math math-inline">x</code> to <code class="language-math math-inline">y</code></p>'
		)
	})

	it("parses what lies between two prices as usual", () => {
		expect(html("Pay $5 for [the book](https://x.y) and $3 shipping.", undefined, MATH)).toBe(
			'<p>Pay $5 for <a href="https://x.y">the book</a> and $3 shipping.</p>'
		)
		expect(html("costs $5 and `code` $10", undefined, MATH)).toBe("<p>costs $5 and <code>code</code> $10</p>")
		expect(html("**$5** and **$10**", undefined, MATH)).toBe("<p><strong>$5</strong> and <strong>$10</strong></p>")
		expect(html("~~$5~~ now $4", undefined, MATH)).toBe("<p><del>$5</del> now $4</p>")
		expect(html("> $5 and\n> $10 c", undefined, MATH)).toBe("<blockquote>\n<p>$5 and\n$10 c</p>\n</blockquote>")
	})

	it("reads a ```math fence as display math, as GitHub does, and only with the extension", () => {
		const display = '<pre><code class="language-math math-display">x = 1\ny &lt; 2</code></pre>'

		expect(html("```math\nx = 1\ny < 2\n```", undefined, MATH)).toBe(display)
		expect(html("~~~Math\nx = 1\ny < 2\n~~~", undefined, MATH)).toBe(display)
		expect(html("> ```math\n> a\n> ```", undefined, MATH)).toBe(
			'<blockquote>\n<pre><code class="language-math math-display">a</code></pre>\n</blockquote>'
		)
		expect(html("```math\nx\n```")).toBe('<pre><code class="language-math">x\n</code></pre>')
		expect(html("```mathematica\nx\n```", undefined, MATH)).toBe('<pre><code class="language-mathematica">x\n</code></pre>')
	})

	it("keeps a math span whose closing sign a line ending follows", () => {
		expect(html("$x$\nnext", undefined, MATH)).toBe('<p><code class="language-math math-inline">x</code>\nnext</p>')
	})
})

describe("MarkdownView mermaid fences (opt-in)", () => {
	const DIAGRAMS = "```mermaid\ngraph TD; A-->B\n```\n\n```js\nx\n```\n\n- ```Mermaid\n  pie\n  ```"

	it("numbers each mermaid fence, nested ones included, and nothing else", () => {
		expect(html(DIAGRAMS, undefined, { mermaid: true })).toBe(
			'<pre><code class="language-mermaid" data-mermaid="0">graph TD; A--&gt;B\n</code></pre>\n' +
				'<pre><code class="language-js">x\n</code></pre>\n' +
				'<ul>\n<li>\n<pre><code class="language-Mermaid" data-mermaid="1">pie\n</code></pre>\n</li>\n</ul>'
		)
	})

	it("leaves fences unmarked without the extension, and composes with math", () => {
		expect(html(DIAGRAMS)).not.toContain("data-mermaid")
		expect(html("$x$\n\n```mermaid\npie\n```", undefined, { math: true, mermaid: true })).toBe(
			'<p><code class="language-math math-inline">x</code></p>\n<pre><code class="language-mermaid" data-mermaid="0">pie\n</code></pre>'
		)
	})
})
