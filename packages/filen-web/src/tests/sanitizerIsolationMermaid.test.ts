// @vitest-environment jsdom

import DOMPurify from "dompurify"
import { describe, expect, it } from "vitest"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"

// Mermaid installs permanent hooks on the default DOMPurify instance as it renders. Notes and untrusted HTML each run on
// an instance of their own: a real Mermaid render changes neither's output.

const NOTE = '<p class="ql-align-center">Hi <a href="https://example.com" target="_blank">there</a></p>'
const MAIL = '<p>Hi <a href="https://example.com" target="_blank">there</a><img src="https://x.y/a.png"></p>'
const LINK = '<a href="https://example.com" target="_blank">x</a>'

describe("sanitizer isolation from Mermaid", () => {
	it("keeps notes and mail output the same after Mermaid renders", async () => {
		const noteBefore = sanitizeRichTextHtml(NOTE)
		const mailBefore = sanitizeEmailHtml(MAIL, () => null)
		const defaultBefore = DOMPurify.sanitize(LINK)
		const { default: mermaid } = await import("mermaid")

		mermaid.initialize({ startOnLoad: false, securityLevel: "strict" })

		// jsdom measures no text: the layout may fail, after the labels were sanitized (and the hooks installed).
		await mermaid.render("isolation", "graph TD; A[\"<a href='https://example.com' target='_blank'>x</a>\"]-->B").catch(() => undefined)

		// Mermaid's hooks are on the default instance now (they keep a link's target and give it a rel).
		expect(DOMPurify.sanitize(LINK)).not.toBe(defaultBefore)
		expect(sanitizeRichTextHtml(NOTE)).toBe(noteBefore)
		expect(sanitizeEmailHtml(MAIL, () => null)).toEqual(mailBefore)
	})
})
