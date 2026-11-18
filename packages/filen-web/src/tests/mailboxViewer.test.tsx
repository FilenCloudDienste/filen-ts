// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { MboxIndex, headerBlock, messageBytes } from "@/features/preview/lib/textPager/mbox.logic"
import { readHeaderSummary } from "@/features/preview/lib/emailReading"

// A mailbox lists the messages its pager worker finds (here the worker's own logic, run in place), counts them, and opens
// the one chosen in the email viewer.

const MAILBOX = new TextEncoder().encode(
	["One", "Two", "Three"].map(subject => `From x\nFrom: X <x@example.com>\nSubject: ${subject}\n\nbody ${subject}\n\n`).join("")
)
const { opened } = vi.hoisted(() => ({ opened: { current: [] as string[] } }))

vi.mock("@/features/preview/hooks/useTextPagerSession", async () => {
	const { MboxIndex: Index } = await import("@/features/preview/lib/textPager/mbox.logic")
	const index = new Index(MAILBOX.length)
	const source = { size: MAILBOX.length, scan: (start: number, end: number) => Promise.resolve(MAILBOX.subarray(start, end)) }
	const remote = {
		mboxEnsure: (want: number) => index.scanUntil(source, want, new AbortController().signal, () => undefined),
		mboxRows: async (first: number, count: number) => {
			const rows = []

			for (let at = first; at < Math.min(first + count, index.count); at++) {
				const span = index.span(at)
				const block = span === null ? null : headerBlock(MAILBOX.subarray(span.start, span.end ?? MAILBOX.length))

				rows.push(block === null ? null : await readHeaderSummary(block))
			}

			return rows
		},
		mboxMessage: (at: number) => {
			const span = index.span(at)

			return Promise.resolve({ status: "ok", bytes: messageBytes(MAILBOX.subarray(span?.start ?? 0, span?.end ?? MAILBOX.length)) })
		}
	}

	return {
		useTextPagerSession: () => ({
			status: "ready",
			reading: { pager: { run: (job: (r: typeof remote) => unknown) => Promise.resolve(job(remote)) } }
		})
	}
})
// Every row laid out (jsdom has no layout for the virtualizer to measure).
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 56 })),
		getTotalSize: () => count * 56
	})
}))
vi.mock("@/features/preview/lib/accessMode", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/preview/lib/accessMode")>()),
	usePreviewOrigin: () => ({ kind: "file" })
}))
vi.mock("@/features/preview/components/emailViewer", () => ({
	EmailViewer: ({ item }: { item: { data: { uuid: string } } }) => {
		opened.current.push(item.data.uuid)

		return <p>message {item.data.uuid}</p>
	}
}))

const { MailboxViewer } = await import("@/features/preview/components/mailboxViewer")

afterEach(() => {
	cleanup()
})

const ITEM = narrowItem({
	uuid: "mbox-0000-0000-0000-000000000000",
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: BigInt(MAILBOX.length),
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: {
		type: "decoded",
		data: { name: "inbox.mbox", mime: "application/mbox", modified: 0n, size: BigInt(MAILBOX.length), key: "k", version: 2 }
	}
} satisfies File)

describe("MailboxViewer", () => {
	it("counts the messages it found and opens the one chosen in the email viewer", async () => {
		render(<MailboxViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })

		expect(await screen.findByText("3 messages")).toBeTruthy()

		fireEvent.click(await screen.findByText("Two"))

		expect(await screen.findByText(`message ${ITEM.data.uuid}#msg1`)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Back to the messages" })).toBeTruthy()
	})
})

// Index logic kept with the viewer's: a fresh index over the same bytes agrees with what the list showed.
it("indexes the fixture as three messages", async () => {
	const index = new MboxIndex(MAILBOX.length)

	await index.scanUntil(
		{ size: MAILBOX.length, scan: (start, end) => Promise.resolve(MAILBOX.subarray(start, end)) },
		10,
		new AbortController().signal,
		() => undefined
	)

	expect(index.count).toBe(3)
})
