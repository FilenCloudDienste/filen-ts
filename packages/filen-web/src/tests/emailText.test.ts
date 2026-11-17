import { describe, expect, it } from "vitest"
import { emailText, htmlText } from "@/features/preview/lib/emailText"
import type { EmailMessage } from "@/features/preview/lib/emailReading"

// A message as plain text: headers, the body's text (HTML read as text, nothing that runs or styles), attachment names,
// bounded.

const MESSAGE: EmailMessage = {
	subject: "Numbers",
	from: "Anna <anna@example.com>",
	to: ["me@example.com", "Bob <bob@example.com>"],
	cc: [],
	addressesOmitted: 0,
	sender: null,
	replyTo: [],
	fromIdnDomain: null,
	date: "2026-11-16T09:14:00.000Z",
	html: null,
	htmlTooLarge: false,
	text: "Hello",
	textTruncated: false,
	attachments: [],
	hasSource: true
}

describe("htmlText", () => {
	it("reads text and line breaks, skipping scripts, styles, comments and the head", () => {
		expect(
			htmlText(
				"<html><head><title>T</title><style>p{}</style></head><body><!-- hidden --><p>One &lt;two&gt;&#33;</p><script>run()</script><div>Three&nbsp;four</div>Five<br>Six</body></html>",
				1000
			)
		).toBe("One <two>!\nThree four\nFive\nSix")
	})

	it("stops reading once it has enough, and leaves an unclosed skipped element's rest out", () => {
		expect(htmlText(`<p>${"word ".repeat(100_000)}</p>`, 50).length).toBeLessThan(600_000)
		expect(htmlText("<p>a</p><script>never closed", 100)).toBe("a")
	})
})

describe("htmlText's tags", () => {
	it("ends a tag at a > outside its quoted values, and keeps a bare < as text", () => {
		expect(htmlText('<img alt="a>b" src="data:image/png;base64,iVBORw0KGgo"><p title=\'x>y\'>shown</p>1 < 2', 1000)).toBe(
			"shown\n1 < 2"
		)
	})
})

describe("emailText", () => {
	it("leaves out inline data a body carries as text", () => {
		const base64 = "QUJD".repeat(40)

		expect(
			emailText({ ...MESSAGE, text: `see data:image/png;base64,iVBORw0KGgo and ${base64} end` }, 1000).endsWith(
				"\n\nsee [data] and [data] end"
			)
		).toBe(true)
	})

	it("gives the headers, the text body and the attachment names", () => {
		const attachment = {
			name: "report.pdf",
			mimeType: "application/pdf",
			size: 3,
			blob: new Blob(["pdf"]),
			contentId: null,
			imageType: null
		}

		expect(emailText({ ...MESSAGE, attachments: [attachment] }, 1000)).toBe(
			"From: Anna <anna@example.com>\nTo: me@example.com, Bob <bob@example.com>\nDate: 2026-11-16T09:14:00.000Z\nSubject: Numbers\nAttachments: report.pdf\n\nHello"
		)
	})

	it("reads the HTML's text when there is no text body, and is at most one past its limit", () => {
		expect(emailText({ ...MESSAGE, text: null, html: "<p>Only <b>HTML</b></p>" }, 1000).endsWith("\n\nOnly HTML")).toBe(true)
		expect(emailText({ ...MESSAGE, text: "z".repeat(10_000) }, 200)).toHaveLength(201)
	})

	it("keeps the headers to their share, lists cut and counted, so the body is always read", () => {
		const to = Array.from({ length: 200 }, (_, index) => `person${String(index)}@example.com`)
		const attachments = Array.from({ length: 1000 }, (_, index) => ({ name: `file-${String(index)}.pdf` }))
		const extract = emailText({ ...MESSAGE, to, addressesOmitted: 50, attachments, text: "the body" }, 4000)
		const [head = ""] = extract.split("\n\n")

		expect(head.length).toBeLessThanOrEqual(1000)
		expect(head).toMatch(/^To: person0@example.com, .* and \d+ more$/mu)
		expect(head).toMatch(/^Attachments: file-0.pdf, .* and \d+ more$/mu)
		expect(extract.endsWith("\n\nthe body")).toBe(true)
	})
})
