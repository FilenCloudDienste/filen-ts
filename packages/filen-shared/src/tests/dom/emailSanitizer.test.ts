// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { createEmailHtmlSanitizer, type EmailPurifier } from "@filen/shared/dom"

// A stand-in for DOMPurify: parses the document and runs the hooks on every element, then answers with its html element
// (RETURN_DOM). Allowlist filtering is DOMPurify's own; the web app covers the sanitizer on the real one.
function fakePurifier(): EmailPurifier {
	const elementHooks: ((node: Node) => void)[] = []
	const attributeHooks: ((node: Element) => void)[] = []
	const purifier: EmailPurifier = {
		removed: [],
		addHook: (entryPoint: string, hook: (node: never) => void) => {
			;(entryPoint === "uponSanitizeElement" ? elementHooks : attributeHooks).push(hook as never)
		},
		sanitize: dirty => {
			const doc = new DOMParser().parseFromString(dirty, "text/html")

			for (const element of doc.querySelectorAll("*")) {
				elementHooks.forEach(hook => {
					hook(element)
				})
				attributeHooks.forEach(hook => {
					hook(element)
				})
			}

			// As DOMPurify records what it removed, holding the run's document.
			purifier.removed.push({ element: doc.body })

			return doc.documentElement
		}
	}

	return purifier
}

describe("createEmailHtmlSanitizer", () => {
	it("makes one purifier of its own, and reports each run's removals and links alone", () => {
		let calls = 0
		const purifier = fakePurifier()
		const sanitize = createEmailHtmlSanitizer(() => {
			calls++

			return purifier
		})

		const first = sanitize("<img src=\"https://x.y/a.png\"><a href=\"https://example.com\">Example</a>", () => null)
		const second = sanitize("<p style=\"background:url(cid:p1)\">x</p>", id => `blob:local/${id}`)

		expect(calls).toBe(1)
		expect(first).toMatchObject({ remoteBlocked: 1, links: [{ href: "https://example.com/", text: "Example" }] })
		expect(first.html).toContain("<img><a data-filen-href=\"https://example.com/\" role=\"link\" tabindex=\"0\">Example</a>")
		expect(second.html).toContain("<p style=\"background:url('blob:local/p1')\">x</p>")
		expect(second).toMatchObject({ remoteBlocked: 0, links: [] })
	})

	// DOMPurify's `removed` holds the last run's parsed document until its next run.
	it("lets go of what the run removed", () => {
		const purifier = fakePurifier()
		const sanitize = createEmailHtmlSanitizer(() => purifier)

		sanitize("<p>x</p>", () => null)

		expect(purifier.removed).toEqual([])
	})
})
