import { describe, expect, it } from "vitest"
import { mailboxText } from "@/features/preview/lib/mailboxText"

// A mailbox's start as plain text: its first messages listed, the first one's extract, never a part's bytes, bounded.

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

function message(index: number, body: string, attachment = false): string {
	const head = `From s${String(index)}@x Mon Nov 16 09:00:00 2026\nFrom: Sender ${String(index)} <s${String(index)}@x.io>\nSubject: Subject ${String(index)}\nDate: Mon, 16 Nov 2026 09:0${String(index % 10)}:00 +0000\n`

	return attachment
		? `${head}Content-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain\n\n${body}\n--b\nContent-Type: application/pdf; name="r.pdf"\nContent-Transfer-Encoding: base64\n\nJVBERi0xLjcKU0VDUkVU\n--b--\n\n`
		: `${head}\n${body}\n\n`
}

describe("mailboxText", () => {
	it("lists the first messages and gives the first one's extract, its attachment by name only", async () => {
		const text = await mailboxText(encode(message(0, "First body", true) + message(1, "Second body")), true, 4000)

		expect(text).toContain("Mailbox: 2 messages")
		expect(text).toContain("1. 2026-11-16T09:00:00.000Z | Sender 0 <s0@x.io> | Subject 0")
		expect(text).toContain("2. ")
		expect(text).toContain("First message:\nFrom: Sender 0 <s0@x.io>")
		expect(text).toContain("Attachments: r.pdf")
		expect(text).toContain("First body")
		expect(text).not.toContain("JVBERi0")
		expect(text).not.toContain("Second body")
	})

	it("says when only the start was read, and stays within its limit", async () => {
		const many = Array.from({ length: 200 }, (_, index) => message(index, "x".repeat(100))).join("")
		const text = await mailboxText(encode(many), false, 4000)

		expect(text).toMatch(/^Mailbox: at least 200 messages \(only the start of the file was read\), the first \d+ listed/u)
		expect(text.length).toBeLessThanOrEqual(4001)
	})
})

describe("mailboxText's first message", () => {
	it("says the first message was cut when it runs past what was read", async () => {
		const text = await mailboxText(encode(message(0, "x".repeat(500))), false, 4000)

		expect(text).toContain("First message (cut short: only its start was read):")
	})
})
