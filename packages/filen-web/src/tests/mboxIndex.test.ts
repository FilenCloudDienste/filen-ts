import { describe, expect, it } from "vitest"
import { SCAN_BYTES } from "@/features/preview/lib/textPager/index.logic"
import {
	MAX_MESSAGES,
	MESSAGE_MAX_BYTES,
	MboxIndex,
	headerBlock,
	messageBytes,
	readMessage
} from "@/features/preview/lib/textPager/mbox.logic"

// A mailbox's messages found on demand: a "From " line at the start or after a blank line, across scan stretches, CRLF
// or LF, past lines longer than a stretch; a message's header block and its unquoted bytes; and the caps.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

function source(bytes: Uint8Array) {
	const reads: [number, number][] = []

	return {
		reads,
		size: bytes.length,
		read: (start: number, end: number) => bytes.subarray(start, end),
		scan: (start: number, end: number) => {
			reads.push([start, end])

			return Promise.resolve(bytes.subarray(start, end))
		}
	}
}

const MAILBOX = [
	"From a@x Mon Nov 16 09:14:00 2026",
	"From: Anna <a@x.io>",
	"Subject: One",
	"",
	"Hello",
	"From the start of a line, but no blank line before it",
	">From quoted",
	">>From twice quoted",
	"",
	"From b@x Mon Nov 16 10:00:00 2026",
	"Subject: Two",
	"",
	"Body two",
	""
].join("\n")

describe("MboxIndex", () => {
	it("finds messages only at a From line after a blank line, and spans them", async () => {
		const bytes = encode(MAILBOX)
		const index = new MboxIndex(bytes.length)
		const counted = await index.scanUntil(source(bytes), Number.POSITIVE_INFINITY, new AbortController().signal, () => undefined)

		expect(counted).toMatchObject({ count: 2, complete: true, capped: false })
		expect(index.span(0)).toEqual({ start: 0, end: MAILBOX.indexOf("From b@x") })
		expect(index.span(1)).toEqual({ start: MAILBOX.indexOf("From b@x"), end: bytes.length })
		expect(index.span(2)).toBeNull()
	})

	it("scans only as far as asked, a stretch at a time", async () => {
		const message = `From x\nSubject: s\n\n${"y".repeat(1000)}\n\n`
		const bytes = encode(message.repeat(Math.ceil((3 * SCAN_BYTES) / message.length)))
		const reader = source(bytes)
		const index = new MboxIndex(bytes.length)
		const counted = await index.scanUntil(reader, 3, new AbortController().signal, () => undefined)

		expect(counted.count).toBeGreaterThanOrEqual(3)
		expect(counted.complete).toBe(false)
		expect(reader.reads).toHaveLength(1)
		// Its last message's end is not known yet.
		expect(index.span(counted.count - 1)?.end).toBeNull()
	})

	it("finds a separator split across stretches, with CRLF lines, and past a line longer than a stretch", () => {
		const long = "z".repeat(SCAN_BYTES + 10)
		const text = `From a\r\nSubject: one\r\n\r\n${long}\r\n\r\nFrom b\r\n\r\nbody\r\n`
		const bytes = encode(text)
		const index = new MboxIndex(bytes.length)

		// Fed in pieces that cut "From b" and the long line.
		const cut = text.indexOf("From b") + 2

		index.feed(bytes.subarray(0, cut), 0, false)

		const resume = index.state().scanned

		index.feed(bytes.subarray(resume), resume, true)

		expect(index.state()).toMatchObject({ count: 2, complete: true })
		expect(index.span(1)?.start).toBe(text.indexOf("From b"))
	})

	it("stops keeping starts at the cap and says so", () => {
		const bytes = encode("From x\n\n".repeat(MAX_MESSAGES + 5))
		const index = new MboxIndex(bytes.length)

		index.feed(bytes, 0, true)

		expect(index.state()).toMatchObject({ count: MAX_MESSAGES, capped: true, complete: true })
	})

	it("stops when told", async () => {
		const bytes = encode("From x\n\nbody\n\n".repeat(400_000))
		const controller = new AbortController()
		const index = new MboxIndex(bytes.length)

		controller.abort()

		expect((await index.scanUntil(source(bytes), Number.POSITIVE_INFINITY, controller.signal, () => undefined)).scanned).toBe(0)
	})
})

describe("mbox messages", () => {
	it("cuts the header block at the first blank line, after the From line", () => {
		expect(decode(headerBlock(encode("From a\nFrom: x\nSubject: y\n\nbody")) ?? new Uint8Array(0))).toBe("From: x\nSubject: y\n")
		expect(decode(headerBlock(encode("From a\r\nSubject: y\r\n\r\nbody")) ?? new Uint8Array(0))).toBe("Subject: y\r\n")
		expect(headerBlock(encode("From a\nSubject: y"))).toBeNull()
	})

	it("drops the From line and one quote off each quoted From line", () => {
		expect(decode(messageBytes(encode("From a\nSubject: s\n\n>From one\n>>From two\n>Fromage\nend\n")))).toBe(
			"Subject: s\n\nFrom one\n>From two\n>Fromage\nend\n"
		)
	})

	it("refuses a message past the size cap without reading it", async () => {
		const reader = source(new Uint8Array(16))

		expect(await readMessage(reader, { start: 0, end: MESSAGE_MAX_BYTES + 1 }, new AbortController().signal)).toBeNull()
		expect(reader.reads).toHaveLength(0)
	})
})
