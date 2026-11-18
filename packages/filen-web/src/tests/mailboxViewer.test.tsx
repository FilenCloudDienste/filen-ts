// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// A mailbox lists the messages its pager worker finds (here the worker's own session, run in place), counts them,
// filters them, opens the one chosen in the email viewer, and reports a failed read to its error state.

const SEP = "From x@x Mon Nov 16 09:14:00 2026"
const MAILBOX = new TextEncoder().encode(
	["One", "Two", "Three"].map(subject => `${SEP}\nFrom: X <x@example.com>\nSubject: ${subject}\n\nbody ${subject}\n\n`).join("")
)
const { opened, failed, broken, restart } = vi.hoisted(() => ({
	opened: { current: [] as string[] },
	failed: { current: [] as unknown[] },
	broken: { current: false },
	restart: { current: false }
}))

vi.mock("@/features/preview/hooks/useTextPagerSession", async () => {
	const { MailboxSession } = await import("@/features/preview/lib/textPager/mailboxSession")
	const { readHeaderSummary } = await import("@/features/preview/lib/emailReading")
	const read = (start: number, end: number) => MAILBOX.slice(start, end)
	const fresh = () =>
		new MailboxSession({
			cached: { size: MAILBOX.length, read },
			scan: {
				size: MAILBOX.length,
				scan: (start: number, end: number) =>
					broken.current ? Promise.reject(new RangeError("port lost")) : Promise.resolve(read(start, end))
			},
			parse: readHeaderSummary
		})
	let session = fresh()
	const remote = {
		mboxEnsure: (want: number) => session.ensure(want),
		mboxRows: (first: number, count: number) => session.rowsFrom(first, count),
		mboxRowsOf: (indexes: readonly number[]) => session.rowsOf(indexes),
		mboxSearch: (query: string) => session.find(query, () => undefined),
		mboxStopSearch: () => undefined,
		mboxStop: () => undefined,
		mboxMessage: (at: number) => session.message(at)
	}

	return {
		useTextPagerSession: () => {
			// A new viewer's own worker: a fresh session.
			if (restart.current) {
				restart.current = false
				session = fresh()
			}

			return {
				status: "ready",
				reading: {
					pager: {
						run: (job: (r: typeof remote) => unknown) => {
							return Promise.resolve(job(remote))
						}
					},
					fail: (error: unknown) => {
						failed.current.push(error)
					}
				}
			}
		}
	}
})
// Every row laid out (jsdom has no layout for the virtualizer to measure).
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 56 })),
		getTotalSize: () => count * 56,
		scrollToIndex: () => undefined
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
	broken.current = false
	failed.current = []
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

function mount(): void {
	render(<MailboxViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

describe("MailboxViewer", () => {
	it("counts the messages it found, gives the list its size, and opens the one chosen in the email viewer", async () => {
		mount()

		expect(await screen.findByText("3 messages")).toBeTruthy()

		const items = await screen.findAllByRole("listitem")

		expect(items.map(row => [row.getAttribute("aria-setsize"), row.getAttribute("aria-posinset")])).toEqual([
			["3", "1"],
			["3", "2"],
			["3", "3"]
		])

		fireEvent.click(await screen.findByText("Two"))

		expect(await screen.findByText(`message ${ITEM.data.uuid}#msg1`)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Back to the messages" })).toBeTruthy()
	})

	it("filters the list to the messages whose sender or subject holds the query, and back", async () => {
		mount()

		expect(await screen.findByText("Three")).toBeTruthy()

		fireEvent.change(screen.getByRole("searchbox", { name: "Search senders and subjects" }), { target: { value: "thr" } })

		expect(await screen.findByRole("status")).toBeTruthy()
		expect((await screen.findAllByText("1 match")).length).toBeGreaterThan(0)
		expect(screen.queryByText("Two")).toBeNull()
		expect(screen.getByText("Three")).toBeTruthy()

		fireEvent.change(screen.getByRole("searchbox", { name: "Search senders and subjects" }), { target: { value: "" } })

		expect(await screen.findByText("Two")).toBeTruthy()
	})

	it("hands a failed read to the error state", async () => {
		broken.current = true
		restart.current = true
		mount()

		await vi.waitFor(() => {
			expect(failed.current).toHaveLength(1)
		})
		expect(failed.current[0]).toBeInstanceOf(RangeError)
	})
})
