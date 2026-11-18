import { describe, expect, it } from "vitest"
import { SCAN_BYTES } from "@/features/preview/lib/textPager/index.logic"
import { MESSAGE_MAX_BYTES } from "@/features/preview/lib/textPager/mbox.logic"
import { MailboxSession } from "@/features/preview/lib/textPager/mailboxSession"

// A mailbox's session in its worker: rows from the headers the scan captured (no second read), scans waited out and gone
// on with, operations stopped alone, a message's end looked for within its bound, and a later open stopping an earlier.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const SEP = (index: number): string => `From s${String(index)}@x Mon Nov 16 09:14:00 2026`

function mailbox(count: number, body = "body"): Uint8Array {
	return encode(
		Array.from(
			{ length: count },
			(_, index) =>
				`${SEP(index)}\nFrom: S${String(index)} <s${String(index)}@x.io>\nSubject: Subject ${String(index)}\n\n${body}\n\n`
		).join("")
	)
}

function sources(bytes: Uint8Array, delay = 0) {
	const scans: [number, number][] = []
	const cached: [number, number][] = []

	return {
		scans,
		cached,
		value: {
			cached: {
				size: bytes.length,
				read: (start: number, end: number) => {
					cached.push([start, end])

					return bytes.slice(start, end)
				}
			},
			scan: {
				size: bytes.length,
				scan: async (start: number, end: number, signal: AbortSignal) => {
					if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))

					if (signal.aborted) throw new DOMException("stopped", "AbortError")

					scans.push([start, end])

					return bytes.slice(start, end)
				}
			},
			parse: (block: Uint8Array) => {
				const text = new TextDecoder().decode(block)

				return Promise.resolve({
					from: /^From: (.*)$/m.exec(text)?.[1] ?? null,
					subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? null,
					date: null
				})
			}
		}
	}
}

describe("MailboxSession", () => {
	it("shows the list from the headers its scan captured, without reading a block again", async () => {
		const { value, cached, scans } = sources(mailbox(50))
		const session = new MailboxSession(value)

		expect((await session.ensure(20)).count).toBe(50)
		expect((await session.rowsFrom(0, 50)).map(row => row?.subject)).toEqual(
			Array.from({ length: 50 }, (_, index) => `Subject ${String(index)}`)
		)
		expect(cached).toEqual([])
		expect(new Set(scans.map(([start]) => start)).size).toBe(scans.length)
	})

	it("waits out a running scan and goes on, so the list and Count all both reach the end", async () => {
		const bytes = mailbox(20_000, "x".repeat(200))
		const { value } = sources(bytes, 1)
		const session = new MailboxSession(value)
		const first = session.ensure(10)
		const counted = session.countAll(() => undefined)
		const later = session.ensure(15_000)

		await first

		expect((await later).count).toBeGreaterThanOrEqual(15_000)
		expect(await counted).toMatchObject({ count: 20_000, complete: true })
	})

	it("stops each operation alone: a finished Count all leaves the search's stop working", async () => {
		const { value } = sources(mailbox(20_000, "x".repeat(200)), 1)
		const session = new MailboxSession(value)
		const counting = session.countAll(() => undefined)
		const finding = session.find("Subject", (_searched, found) => {
			if (found.length > 0) session.stopFind()
		})

		session.stopCount()
		await counting

		const found = await finding

		expect(found.end).toBe("stopped")
		expect(found.matches.length).toBeGreaterThan(0)
	})

	it("gives up looking for a message's end past its size bound", async () => {
		const huge = new Uint8Array(MESSAGE_MAX_BYTES + 3 * SCAN_BYTES).fill(0x61)

		for (let at = 100; at < huge.length; at += 100) huge[at] = 0x0a

		const head = encode(`${SEP(0)}\nSubject: huge\n\n`)
		const bytes = new Uint8Array(head.length + huge.length)

		bytes.set(head)
		bytes.set(huge, head.length)

		const { value, scans } = sources(bytes)
		const session = new MailboxSession(value)

		await session.ensure(1)

		expect(await session.message(0)).toEqual({ status: "tooLarge" })
		// The file is larger; the scan stopped within the bound and a stretch or two.
		expect(Math.max(...scans.map(([, end]) => end))).toBeLessThanOrEqual(MESSAGE_MAX_BYTES + 3 * SCAN_BYTES)
	}, 30_000)

	it("stops an earlier open when another starts, and reads a message once, unquoted", async () => {
		const { value } = sources(encode(`${SEP(0)}\nSubject: a\n\n>From x\n\n${SEP(1)}\nSubject: b\n\nbody\n`), 5)
		const session = new MailboxSession(value)

		await session.ensure(2)

		const earlier = session.message(0)
		const later = session.message(1)

		expect(await earlier).toEqual({ status: "missing" })

		const opened = await later

		expect(opened.status === "ok" && new TextDecoder().decode(opened.bytes)).toBe("Subject: b\n\nbody\n")
	})
})
