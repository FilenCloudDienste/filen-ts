import { describe, expect, it } from "vitest"
import { SCAN_BYTES } from "@/features/preview/lib/textPager/index.logic"
import {
	MAX_MESSAGES,
	MBOX_MATCH_CAP,
	MboxScanner,
	headerBlockOf,
	headerMatches,
	isSeparator,
	messageBytes,
	rowFields,
	searchHeaders
} from "@/features/preview/lib/textPager/mbox.logic"

// A mailbox's messages found on demand: a separator-shaped "From " line at the start or after a blank line, across
// stretches, CRLF or LF, past lines longer than a stretch; header blocks captured as the scan passes them; unquoting; the
// caps; and the header search.

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const SEP = (who: string): string => `From ${who} Mon Nov 16 09:14:00 2026`

function source(bytes: Uint8Array) {
	const reads: [number, number][] = []

	return {
		reads,
		size: bytes.length,
		scan: (start: number, end: number, signal: AbortSignal) => {
			if (signal.aborted) return Promise.reject(new DOMException("stopped", "AbortError"))

			reads.push([start, end])

			return Promise.resolve(bytes.slice(start, end))
		}
	}
}

async function scanAll(bytes: Uint8Array): Promise<MboxScanner> {
	const scanner = new MboxScanner(bytes.length)

	await scanner.scan(
		source(bytes),
		() => false,
		new AbortController().signal,
		() => undefined
	)

	return scanner
}

const MAILBOX = [
	SEP("a@x"),
	"From: Anna <a@x.io>",
	"Subject: One",
	"",
	"Hello",
	"",
	"From the start of a line after a blank line, but not a separator's shape",
	">From quoted",
	"",
	SEP("b@x"),
	"Subject: Two",
	"",
	"Body two",
	""
].join("\n")

describe("isSeparator", () => {
	it("takes a sender and an asctime date, as mutt does", () => {
		expect(isSeparator(encode("From a@x Mon Nov 16 09:14:00 2026"))).toBe(true)
		expect(isSeparator(encode("From MAILER-DAEMON  Thu Jan  1 00:00:00 1970"))).toBe(true)
		expect(isSeparator(encode('From "a b"@x Sun Feb  2 1:02 +0100 2025'))).toBe(true)
		expect(isSeparator(encode("From me"))).toBe(false)
		expect(isSeparator(encode("From the start of a line"))).toBe(false)
		expect(isSeparator(encode("From: a@x Mon Nov 16 09:14:00 2026"))).toBe(false)
	})
})

describe("MboxScanner", () => {
	it("splits only at separators after a blank line, and captures each header block as it passes", async () => {
		const bytes = encode(MAILBOX)
		const scanner = await scanAll(bytes)

		expect(scanner.state()).toMatchObject({ count: 2, complete: true, capped: false })
		expect(scanner.span(1)).toEqual({ start: MAILBOX.indexOf(SEP("b@x")), end: bytes.length })
		expect(scanner.takeCaptured().map(({ index, block }) => [index, decode(block)])).toEqual([
			[0, "From: Anna <a@x.io>\nSubject: One\n"],
			[1, "Subject: Two\n"]
		])
	})

	it("reads block-aligned stretches, each once, carrying a separator and a line across them", async () => {
		const long = "z".repeat(SCAN_BYTES + 10)
		const text = `${SEP("a")}\r\nSubject: one\r\n\r\n${long}\r\n\r\n${SEP("b")}\r\nSubject: two\r\n\r\nbody\r\n`
		const bytes = encode(text)
		const reader = source(bytes)
		const scanner = new MboxScanner(bytes.length)

		await scanner.scan(
			reader,
			() => false,
			new AbortController().signal,
			() => undefined
		)

		expect(scanner.state()).toMatchObject({ count: 2, complete: true })
		expect(scanner.span(1)?.start).toBe(text.indexOf(SEP("b")))
		expect(reader.reads.every(([start]) => start % SCAN_BYTES === 0)).toBe(true)
		expect(new Set(reader.reads.map(([start]) => start)).size).toBe(reader.reads.length)
	})

	it("scans only as far as asked", async () => {
		const message = `${SEP("x")}\nSubject: s\n\n${"y".repeat(1000)}\n\n`
		const bytes = encode(message.repeat(Math.ceil((3 * SCAN_BYTES) / message.length)))
		const reader = source(bytes)
		const scanner = new MboxScanner(bytes.length)

		await scanner.scan(
			reader,
			() => scanner.count >= 3,
			new AbortController().signal,
			() => undefined
		)

		expect(scanner.state().complete).toBe(false)
		// One stretch read, and one read ahead it called off.
		expect(reader.reads.length).toBeLessThanOrEqual(2)
		expect(scanner.span(scanner.count - 1)?.end).toBeNull()
	})

	it("stops keeping starts at the cap: capped, not complete, and the last message ends where the next would start", () => {
		const one = `${SEP("x")}\n\n`
		const bytes = encode(one.repeat(MAX_MESSAGES + 5))
		const scanner = new MboxScanner(bytes.length)

		scanner.feed(bytes, 0)

		expect(scanner.state()).toMatchObject({ count: MAX_MESSAGES, capped: true, complete: false })
		expect(scanner.span(MAX_MESSAGES - 1)?.end).toBe(MAX_MESSAGES * one.length)
	})

	it("keeps a header block's row fields, found past a long Received chain", async () => {
		const received = Array.from({ length: 3000 }, (_, index) => `Received: from relay${String(index)}.example by mx.example`)
		const text = `${SEP("a")}\n${received.join("\n")}\nFrom: Late <late@x.io>\nSubject: Long\n  headers\n\nbody\n`
		const scanner = await scanAll(encode(`${SEP("z")}\nSubject: early\nX-Other: 1\nFrom: Early <e@x.io>\n\n\n${text}`))
		const blocks = scanner.takeCaptured()

		expect(decode(blocks[0]?.block ?? new Uint8Array(0))).toBe("Subject: early\nFrom: Early <e@x.io>\n")
		expect(decode(blocks[1]?.block ?? new Uint8Array(0))).toBe("From: Late <late@x.io>\nSubject: Long\n  headers\n")
	})
})

describe("mbox messages", () => {
	it("reads a header block again from a message's start, and its row fields with folded lines", () => {
		const block = headerBlockOf(encode(`${SEP("a")}\nFrom: x\nX-Big: 1\nSubject: y\n  more\n\nbody`))

		expect(decode(block)).toBe("From: x\nX-Big: 1\nSubject: y\n  more\n")
		expect(decode(rowFields(block))).toBe("From: x\nSubject: y\n  more\n")
	})

	it("drops the From line and one quote off each quoted From line, in place", () => {
		const bytes = encode(`${SEP("a")}\nSubject: s\n\n>From one\n>>From two\n>Fromage\nend\n`)
		const message = messageBytes(bytes)

		expect(decode(message)).toBe("Subject: s\n\nFrom one\n>From two\n>Fromage\nend\n")
		expect(message.buffer).toBe(bytes.buffer)
	})
})

describe("searchHeaders", () => {
	const mailbox = (subjects: readonly string[]): Uint8Array =>
		encode(
			subjects
				.map(
					(subject, index) =>
						`${SEP(`s${String(index)}@x`)}\nFrom: S${String(index)} <s${String(index)}@x.io>\nSubject: ${subject}\n\nbody\n\n`
				)
				.join("")
		)
	const parse = (block: Uint8Array) => {
		const text = decode(block)

		return Promise.resolve({
			from: /^From: (.*)$/m.exec(text)?.[1] ?? null,
			subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? null,
			date: null
		})
	}

	it("finds the messages whose sender or subject holds the query, reading the file once", async () => {
		const bytes = mailbox(["Q3 Budget", "lunch", "budget review", "other"])
		const reader = source(bytes)
		const result = await searchHeaders("budget", {
			source: reader,
			parse,
			signal: new AbortController().signal,
			onProgress: () => undefined
		})

		expect([result.matches, result.end, result.searched]).toEqual([[0, 2], "done", 4])
		expect(reader.reads).toHaveLength(1)
		expect(headerMatches({ from: "Anna <A@X.io>", subject: null }, "a@x")).toBe(true)
	})

	it("stops at the cap; only one past it says capped", async () => {
		const exactly = await searchHeaders("x", {
			source: source(mailbox(Array.from({ length: MBOX_MATCH_CAP }, () => "x"))),
			parse,
			signal: new AbortController().signal,
			onProgress: () => undefined
		})
		const more = await searchHeaders("x", {
			source: source(mailbox(Array.from({ length: MBOX_MATCH_CAP + 1 }, () => "x"))),
			parse,
			signal: new AbortController().signal,
			onProgress: () => undefined
		})

		expect([exactly.end, exactly.matches.length]).toEqual(["done", MBOX_MATCH_CAP])
		expect([more.end, more.matches.length]).toEqual(["capped", MBOX_MATCH_CAP])
	})

	it("keeps what it found when stopped, and never says done then", async () => {
		const controller = new AbortController()
		const bytes = mailbox(Array.from({ length: 30_000 }, () => "x"))
		const result = await searchHeaders("x", {
			source: source(bytes),
			parse,
			signal: controller.signal,
			onProgress: searched => {
				if (searched > 0) controller.abort()
			}
		})

		expect(result.end).toBe("stopped")
		expect(result.matches.length).toBeGreaterThan(0)
	})

	it("lets a real error through", async () => {
		await expect(
			searchHeaders("x", {
				source: { size: 10, scan: () => Promise.reject(new RangeError("lost")) },
				parse,
				signal: new AbortController().signal,
				onProgress: () => undefined
			})
		).rejects.toThrow("lost")
	})
})
