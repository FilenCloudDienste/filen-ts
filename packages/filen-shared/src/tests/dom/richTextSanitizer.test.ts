// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { createRichTextSanitizer, RICH_TEXT_ALLOWED_ATTR, RICH_TEXT_ALLOWED_TAGS, type RichTextPurifier } from "@filen/shared/dom"

// A stand-in for DOMPurify: parses the markup, runs the registered hook on every element and records the
// config it was called with. Allowlist filtering itself is DOMPurify's job and covered in the web app.
function fakePurifier() {
	const hooks: ((node: Element) => void)[] = []
	const configs: { ALLOWED_TAGS: string[]; ALLOWED_ATTR: string[] }[] = []
	const purifier: RichTextPurifier = {
		removed: [],
		addHook: (_entryPoint, hook) => {
			hooks.push(hook)
		},
		sanitize: (dirty, config) => {
			configs.push(config)

			const template = document.createElement("template")

			template.innerHTML = dirty

			for (const element of template.content.querySelectorAll("*")) {
				for (const hook of hooks) {
					hook(element)
				}
			}

			// As DOMPurify records what it removed, holding the run's document.
			purifier.removed.push({ element: template })

			return template.innerHTML
		}
	}

	return { purifier, hooks, configs }
}

describe("createRichTextSanitizer", () => {
	it("adds its hook once per purifier instance", () => {
		const { purifier, hooks } = fakePurifier()

		createRichTextSanitizer(purifier)
		createRichTextSanitizer(purifier)

		expect(hooks).toHaveLength(1)
	})

	it("sanitizes with the cross-client allowlists", () => {
		const { purifier, configs } = fakePurifier()

		createRichTextSanitizer(purifier)("<p>x</p>")

		expect(configs).toEqual([{ ALLOWED_TAGS: [...RICH_TEXT_ALLOWED_TAGS], ALLOWED_ATTR: [...RICH_TEXT_ALLOWED_ATTR] }])
		expect(RICH_TEXT_ALLOWED_ATTR).toEqual(["href", "target", "rel", "src", "alt", "class", "style"])
		expect(RICH_TEXT_ALLOWED_TAGS).toEqual([
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

	it("forces a link with an href to open in a new tab without opener or referrer", () => {
		const sanitize = createRichTextSanitizer(fakePurifier().purifier)

		expect(sanitize('<a href="https://example.com" target="_self" rel="opener">l</a>')).toBe(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">l</a>'
		)
		expect(sanitize("<a>no href</a>")).toBe("<a>no href</a>")
	})

	it("strips positioning and viewport-sized declarations, keeping the rest", () => {
		const sanitize = createRichTextSanitizer(fakePurifier().purifier)

		expect(sanitize('<p style="position:fixed;top:0;inset:0;z-index:9;width:100vw;color:red">x</p>')).toBe(
			'<p style="color: red">x</p>'
		)
		expect(sanitize('<p style="position:fixed;height:100vh">x</p>')).toBe("<p>x</p>")
	})

	it("keeps only Quill's content formatting classes", () => {
		const sanitize = createRichTextSanitizer(fakePurifier().purifier)

		expect(sanitize('<p class="fixed inset-0 z-50 ql-align-center ql-tooltip ql-indent-2">x</p>')).toBe(
			'<p class="ql-align-center ql-indent-2">x</p>'
		)
		expect(sanitize('<span class="ql-container ql-editor">x</span>')).toBe("<span>x</span>")
		expect(sanitize('<div class="ql-code-block-container"><div class="ql-code-block">c</div></div>')).toBe(
			'<div class="ql-code-block-container"><div class="ql-code-block">c</div></div>'
		)
	})
})

describe("createRichTextSanitizer — memory", () => {
	// DOMPurify's `removed` holds the last run's parsed document until its next run.
	it("lets go of what the run removed", () => {
		const { purifier } = fakePurifier()

		createRichTextSanitizer(purifier)("<p>x</p>")

		expect(purifier.removed).toEqual([])
	})
})
