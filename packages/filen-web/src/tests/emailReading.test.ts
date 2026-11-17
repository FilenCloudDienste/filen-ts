import { describe, expect, it, vi } from "vitest"
// A small text cap, so bodies past it stay small here.
vi.mock("@/features/preview/lib/previewCaps", () => ({ TEXT_CAP: 4096, EMAIL_MAX_BYTES: 67_108_864 }))
// The sanitizer's HTML cap, as small: HTML past it is never sent to the page.
vi.mock("@filen/shared/dom/emailSanitizer", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/shared/dom/emailSanitizer")>()),
	EMAIL_MAX_HTML_CHARS: 2048
}))

const { rasterImageType, readEmail, readEmailNames } = await import("@/features/preview/lib/emailReading")
import { outlookMessage } from "@/tests/fixtures/outlookMessage"
import { msgBytes } from "@filen/office/testing/msg"

// A message read for its viewer: display headers, bodies, attachments as Blobs, a forwarded message as an attachment;
// past the nesting, part or size bounds it is "tooLarge". An Outlook message (.msg) reads into the same model.

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const CRLF = (lines: string[]): string => lines.join("\r\n")

describe("readEmail", () => {
	it("reads headers, both bodies, an inline picture by its Content-ID and an attachment, as Blobs", async () => {
		const reading = await readEmail(
			encode(
				CRLF([
					'From: "Anna Berg" <anna@example.com>',
					"To: me@example.com, Bob <bob@example.com>",
					"Cc: ana@x.io",
					"Subject: =?UTF-8?Q?Quarterly_numbers_=E2=80=AE?=",
					"Date: Mon, 16 Nov 2026 09:14:00 +0000",
					"MIME-Version: 1.0",
					'Content-Type: multipart/mixed; boundary="outer"',
					"",
					"--outer",
					'Content-Type: multipart/related; boundary="rel"',
					"",
					"--rel",
					'Content-Type: multipart/alternative; boundary="alt"',
					"",
					"--alt",
					"Content-Type: text/plain; charset=utf-8",
					"",
					"Hello",
					"--alt",
					"Content-Type: text/html; charset=utf-8",
					"",
					'<p>Hello <img src="cid:chart@x"></p>',
					"--alt--",
					"--rel",
					"Content-Type: image/png",
					"Content-ID: <chart@x>",
					"Content-Disposition: inline",
					"Content-Transfer-Encoding: base64",
					"",
					"iVBORw0KGgo=",
					"--rel--",
					"--outer",
					'Content-Type: application/pdf; name="report.pdf"',
					'Content-Disposition: attachment; filename="report.pdf"',
					"Content-Transfer-Encoding: base64",
					"",
					"JVBERi0xLjcK",
					"--outer",
					"Content-Type: message/rfc822",
					"",
					"Subject: Forwarded",
					"",
					"Inner body",
					"--outer--",
					""
				])
			)
		)

		expect(reading.status).toBe("ok")

		if (reading.status !== "ok") return

		expect(reading).toMatchObject({
			subject: "Quarterly numbers",
			from: "Anna Berg <anna@example.com>",
			to: ["me@example.com", "Bob <bob@example.com>"],
			cc: ["ana@x.io"],
			addressesOmitted: 0
		})
		expect(reading.text).toContain("Hello")
		expect(reading.html).toContain("cid:chart@x")
		expect(reading.date?.startsWith("2026-11-16")).toBe(true)
		expect(
			reading.attachments.map(attachment => [attachment.name, attachment.mimeType, attachment.contentId, attachment.imageType])
		).toEqual([
			["attachment-1", "image/png", "chart@x", "image/png"],
			["report.pdf", "application/pdf", null, null],
			["attachment-3.eml", "message/rfc822", null, null]
		])
		expect(reading.attachments[1]?.blob).toBeInstanceOf(Blob)
		expect(new TextDecoder().decode(await reading.attachments[1]?.blob.arrayBuffer())).toBe("%PDF-1.7\n")
	})

	it("types a part by its bytes, never its declared type: SVG and unknown bytes are no image", async () => {
		const part = (type: string, id: string, base64: string): string[] => [
			"--m",
			`Content-Type: ${type}`,
			`Content-ID: <${id}>`,
			"Content-Transfer-Encoding: base64",
			"",
			base64
		]
		const reading = await readEmail(
			encode(
				CRLF([
					"Subject: Types",
					'Content-Type: multipart/related; boundary="m"',
					"",
					"--m",
					"Content-Type: text/html",
					"",
					"<p>x</p>",
					...part("image/svg+xml", "svg@x", btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')),
					...part("image/png", "gif@x", btoa("GIF89a\x01\x00\x01\x00")),
					...part("image/png", "text@x", btoa("not an image")),
					"--m--"
				])
			)
		)

		expect(reading.status === "ok" && reading.attachments.map(attachment => [attachment.contentId, attachment.imageType])).toEqual([
			["svg@x", null],
			["gif@x", "image/gif"],
			["text@x", null]
		])
		expect(rasterImageType(Uint8Array.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe("image/avif")
		expect(rasterImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
	})

	it("reads at most 200 recipients and counts the rest", async () => {
		const to = Array.from({ length: 250 }, (_, index) => `u${String(index)}@example.com`).join(", ")
		const reading = await readEmail(encode(CRLF([`To: ${to}`, "Subject: Many", "", "x"])))

		expect(reading).toMatchObject({ status: "ok", addressesOmitted: 50 })
		expect(reading.status === "ok" && reading.to.length).toBe(200)
	})

	it("calls a message past its nesting or part bounds too large", async () => {
		const nested: string[] = ["Subject: Deep", "MIME-Version: 1.0"]

		for (let depth = 0; depth < 40; depth++)
			nested.push(`Content-Type: multipart/mixed; boundary="b${String(depth)}"`, "", `--b${String(depth)}`)

		nested.push("Content-Type: text/plain", "", "bottom")

		const parts: string[] = ["Subject: Parts", 'Content-Type: multipart/mixed; boundary="p"', ""]

		for (let index = 0; index < 1100; index++) parts.push("--p", "Content-Type: text/plain", "", String(index))

		parts.push("--p--")

		expect(await readEmail(encode(CRLF(nested)))).toEqual({ status: "tooLarge" })
		expect(await readEmail(encode(CRLF(parts)))).toEqual({ status: "tooLarge" })
	})

	it("reads an Outlook message into the same model, its embedded message a .msg attachment, with no source view", async () => {
		const reading = await readEmail((await outlookMessage()) as Uint8Array<ArrayBuffer>)

		expect(reading).toMatchObject({
			status: "ok",
			subject: "Status report",
			from: "Anna Berg <anna@example.com>",
			to: ["Bob <bob@example.com>"],
			html: "<p>All green</p>",
			hasSource: false
		})

		if (reading.status !== "ok") return

		expect(reading.attachments.map(attachment => [attachment.name, attachment.mimeType])).toEqual([
			["Earlier thread.msg", "application/vnd.ms-outlook"]
		])
		expect(await readEmail(new Uint8Array((await reading.attachments[0]?.blob.arrayBuffer()) ?? new ArrayBuffer(0)))).toMatchObject({
			status: "ok",
			subject: "Earlier thread",
			text: "Inner text"
		})
	})

	it("cuts a text body at the text cap and refuses an HTML body past it", async () => {
		const long = "x".repeat(5000)
		const reading = await readEmail(
			encode(
				CRLF([
					"Subject: Long",
					'Content-Type: multipart/alternative; boundary="a"',
					"",
					"--a",
					"Content-Type: text/plain",
					"",
					long,
					"--a",
					"Content-Type: text/html",
					"",
					`<p>${long}</p>`,
					"--a--"
				])
			)
		)

		expect(reading).toMatchObject({ status: "ok", html: null, htmlTooLarge: true, textTruncated: true })
		expect(reading.status === "ok" && reading.text?.length).toBe(4096)
	})

	it("puts the real address first, shows an international domain in ASCII, Reply-To when it differs, and collapses padding", async () => {
		const read = async (lines: string[]) => {
			const reading = await readEmail(encode(CRLF(lines)))

			if (reading.status !== "ok") throw new Error("expected a message")

			return reading
		}

		expect(await read(['From: "support@bank.com" <evil@x.io>', "Reply-To: drop@y.io", "", "x"])).toMatchObject({
			from: "evil@x.io (support@bank.com)",
			replyTo: ["drop@y.io"],
			fromIdnDomain: null
		})
		expect(await read(["From: Anna <anna@x.io>", "Reply-To: ANNA@x.io", "", "x"])).toMatchObject({
			from: "Anna <anna@x.io>",
			replyTo: []
		})
		expect(await read(["From: a@b\u00fccher.example", "", "x"])).toMatchObject({
			from: "a@xn--bcher-kva.example",
			fromIdnDomain: "b\u00fccher.example"
		})

		const padded = await read([
			"Subject: Padded",
			'Content-Type: multipart/mixed; boundary="p"',
			"",
			"--p",
			'Content-Type: application/octet-stream; name="invoice.pdf          .exe"',
			'Content-Disposition: attachment; filename="invoice.pdf          .exe"',
			"",
			"MZ",
			"--p--"
		])

		expect(padded.attachments[0]?.name).toBe("invoice.pdf .exe")
	})

	it("sends HTML up to the sanitizer's cap and none past it", async () => {
		const html = (chars: number) =>
			readEmail(encode(CRLF(["Subject: Html", "Content-Type: text/html", "", `<p>${"h".repeat(chars)}</p>`])))

		expect(await html(1000)).toMatchObject({ status: "ok", htmlTooLarge: false })
		expect(await html(3000)).toMatchObject({ status: "ok", html: null, htmlTooLarge: true })
	})

	it("reads names alone for a text extract: no Blob, no embedded message copied", async () => {
		const msg = await readEmailNames((await outlookMessage()) as Uint8Array<ArrayBuffer>)
		const eml = await readEmailNames(
			encode(
				CRLF([
					"Subject: Names",
					'Content-Type: multipart/mixed; boundary="n"',
					"",
					"--n",
					"Content-Type: text/plain",
					"",
					"body",
					"--n",
					'Content-Type: application/pdf; name="a.pdf"',
					"",
					"%PDF",
					"--n--"
				])
			)
		)

		expect(msg).toMatchObject({ status: "ok", subject: "Status report", attachments: [{ name: "Earlier thread.msg" }] })
		expect(eml).toMatchObject({ status: "ok", text: "body", attachments: [{ name: "a.pdf" }] })
		expect(
			[msg, eml].every(
				reading => reading.status === "ok" && reading.attachments.every(attachment => Object.keys(attachment).length === 1)
			)
		).toBe(true)
	})

	it("shows the Sender when it differs, an existing xn-- domain as written, and a fullwidth @ name address-first", async () => {
		const read = async (bytes: Uint8Array) => {
			const reading = await readEmail(bytes as Uint8Array<ArrayBuffer>)

			if (reading.status !== "ok") throw new Error("expected a message")

			return reading
		}

		expect(await read(encode(CRLF(["From: Boss <boss@x.io>", "Sender: Assistant <pa@x.io>", "", "x"])))).toMatchObject({
			from: "Boss <boss@x.io>",
			sender: "Assistant <pa@x.io>"
		})
		expect(await read(encode(CRLF(["From: a@x.io", "Sender: A@x.io", "", "x"])))).toMatchObject({ sender: null })
		expect(await read(encode(CRLF(["From: a@xn--bcher-kva.example", "", "x"])))).toMatchObject({
			from: "a@xn--bcher-kva.example",
			fromIdnDomain: "b\u00fccher.example"
		})
		expect(await read(encode(CRLF(['From: "support\uff20bank.com" <evil@x.io>', "", "x"])))).toMatchObject({
			from: "evil@x.io (support\uff20bank.com)"
		})
	})

	it("reads a .msg's sending account and its Reply-To from the headers it arrived with, else its reply names", async () => {
		const read = async (spec: Parameters<typeof msgBytes>[0]) => {
			const reading = await readEmail((await msgBytes(spec)) as Uint8Array<ArrayBuffer>)

			if (reading.status !== "ok") throw new Error("expected a message")

			return reading
		}

		expect(await read({ sender: [null, "evil@x.io"], representing: ["CEO", null] })).toMatchObject({ from: "CEO", sender: "evil@x.io" })
		expect(
			await read({ sender: ["Anna", "anna@x.io"], transportHeaders: "From: anna@x.io\r\nReply-To: Desk <desk@y.io>\r\n" })
		).toMatchObject({ replyTo: ["Desk <desk@y.io>"] })
		expect(await read({ sender: ["Anna", "anna@x.io"], replyToNames: "Desk; Other" })).toMatchObject({ replyTo: ["Desk", "Other"] })
		expect(await read({ sender: ["Anna", "anna@x.io"], replyToNames: "Anna" })).toMatchObject({ replyTo: [] })
	})
})
