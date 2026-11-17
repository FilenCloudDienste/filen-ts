// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { createEmailHtmlSanitizer, type EmailPurifier } from "@filen/shared/dom"

// A stand-in for DOMPurify: parses the markup and runs the hooks on every element (style elements first). Allowlist
// filtering is DOMPurify's own; the web app covers the sanitizer on the real one.
function fakePurifier(): { purifier: EmailPurifier } {
	const elementHooks: ((node: Node) => void)[] = []
	const attributeHooks: ((node: Element) => void)[] = []
	const purifier: EmailPurifier = {
		addHook: (entryPoint: string, hook: (node: never) => void) => {
			;(entryPoint === "uponSanitizeElement" ? elementHooks : attributeHooks).push(hook as never)
		},
		sanitize: dirty => {
			const template = document.createElement("template")

			template.innerHTML = dirty

			for (const element of template.content.querySelectorAll("*")) {
				elementHooks.forEach(hook => {
					hook(element)
				})
				attributeHooks.forEach(hook => {
					hook(element)
				})
			}

			return template.innerHTML
		}
	}

	return { purifier }
}

describe("createEmailHtmlSanitizer", () => {
	it("makes one purifier of its own, and reports each run's removals and links alone", () => {
		let calls = 0
		const { purifier } = fakePurifier()
		const sanitize = createEmailHtmlSanitizer(() => {
			calls++

			return purifier
		})

		const first = sanitize("<img src=\"https://x.y/a.png\"><a href=\"https://example.com\">Example</a>", () => null)
		const second = sanitize("<p style=\"background:url(cid:p1)\">x</p>", id => `blob:local/${id}`)

		expect(calls).toBe(1)
		expect(first).toMatchObject({ remoteBlocked: 1, links: [{ href: "https://example.com/", text: "Example" }] })
		expect(first.html).toBe("<img><a href=\"https://example.com\">Example</a>")
		expect(second).toEqual({ html: "<p style=\"background:url('blob:local/p1')\">x</p>", remoteBlocked: 0, links: [] })
	})
})
