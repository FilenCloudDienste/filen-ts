// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import type { MboxSearchResult } from "@/features/preview/lib/textPager/mbox.logic"

// A mailbox lists the messages its pager worker finds (here the worker's own session, run in place), counts them,
// filters them, opens the one chosen in the email viewer, and reports a failed read to its error state.

const SEP = "From x@x Mon Nov 16 09:14:00 2026"
const MAILBOX = new TextEncoder().encode(
	["One", "Two", "Three"].map(subject => `${SEP}\nFrom: X <x@example.com>\nSubject: ${subject}\n\nbody ${subject}\n\n`).join("")
)
type Progress = (searched: number, found: readonly number[]) => void

const { opened, failed, broken, restart, view, searching, rowsOf } = vi.hoisted(() => ({
	opened: { current: [] as string[] },
	failed: { current: [] as unknown[] },
	broken: { current: false },
	restart: { current: false },
	// How many rows the virtualizer lays out.
	view: { current: Number.POSITIVE_INFINITY },
	// A search driven by the test: its progress callback, its end (ends only once `finish` is called), and whether the
	// worker can read the matches' rows (else every read answers null).
	searching: {
		current: null as {
			progress: Progress | null
			finish?: ((result: MboxSearchResult) => void) | null
			readable?: boolean
		} | null
	},
	rowsOf: { current: [] as (readonly number[])[] }
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
		mboxRowsOf: (indexes: readonly number[]) => {
			rowsOf.current.push(indexes)

			return searching.current === null || searching.current.readable === true
				? session.rowsOf(indexes)
				: Promise.resolve(indexes.map(() => null))
		},
		mboxSearch: (query: string, progress: Progress) => {
			if (searching.current === null) return session.find(query, () => undefined)

			const driven = searching.current

			driven.progress = progress

			return new Promise<MboxSearchResult>(resolve => {
				driven.finish = resolve
			})
		},
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
		getVirtualItems: () => Array.from({ length: Math.min(count, view.current) }, (_, index) => ({ index, start: index * 56 })),
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
	view.current = Number.POSITIVE_INFINITY
	searching.current = null
	rowsOf.current = []
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

	it("reads the rows in view again only when a search's progress changes the matches near the view", async () => {
		// One row in view: the rows read are the first 21 matches (it and the overscan below it).
		view.current = 1
		searching.current = { progress: null }
		mount()

		fireEvent.change(await screen.findByRole("searchbox", { name: "Search senders and subjects" }), { target: { value: "x" } })

		await vi.waitFor(() => {
			expect(searching.current?.progress).toBeTypeOf("function")
		})

		const tick = async (searched: number, found: readonly number[]): Promise<void> => {
			await act(async () => {
				searching.current?.progress?.(searched, found)
				await Promise.resolve()
			})
		}
		const range = (start: number, end: number): number[] => Array.from({ length: end - start }, (_, at) => start + at)

		await tick(10, range(0, 10))
		expect(rowsOf.current).toEqual([range(0, 10)])

		// Grows the matches near the view: read once.
		await tick(30, range(10, 30))
		expect(rowsOf.current).toEqual([range(0, 10), range(0, 21)])

		// Matches beyond the view, and a stretch without any: nothing read.
		await tick(40, range(30, 40))
		await tick(50, [])
		expect(rowsOf.current).toHaveLength(2)
		expect(screen.getByText("40 matches · searching 50 messages…")).toBeTruthy()
	})

	it("keeps a shown match the worker no longer reads, and reads the rows once more when the search ends", async () => {
		const driven: NonNullable<typeof searching.current> = { progress: null, readable: true }

		searching.current = driven
		mount()

		fireEvent.change(await screen.findByRole("searchbox", { name: "Search senders and subjects" }), { target: { value: "x" } })

		await vi.waitFor(() => {
			expect(searching.current?.progress).toBeTypeOf("function")
		})

		const tick = async (searched: number, found: readonly number[]): Promise<void> => {
			await act(async () => {
				searching.current?.progress?.(searched, found)
				await Promise.resolve()
			})
		}

		await tick(1, [0])
		expect(await screen.findByText("One")).toBeTruthy()

		// The worker no longer has the first match's row: it stays shown; the new match is still being read.
		driven.readable = false
		await tick(3, [2])
		expect(rowsOf.current).toEqual([[0], [0, 2]])
		expect(screen.getByText("One")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Message 2, loading" })).toBeTruthy()

		// The search ends with the same matches: the rows are read exactly once more.
		driven.readable = true
		await act(async () => {
			searching.current?.finish?.({ matches: [0, 2], searched: 3, end: "done" })
			await Promise.resolve()
		})
		expect(await screen.findByText("Three")).toBeTruthy()
		expect(rowsOf.current).toEqual([[0], [0, 2], [0, 2]])
		expect(screen.getByText("One")).toBeTruthy()
	})

	it("ignores a search's progress that arrives after its result", async () => {
		const driven: NonNullable<typeof searching.current> = { progress: null, readable: true }

		searching.current = driven
		mount()

		fireEvent.change(await screen.findByRole("searchbox", { name: "Search senders and subjects" }), { target: { value: "thr" } })

		await vi.waitFor(() => {
			expect(driven.progress).toBeTypeOf("function")
		})

		await act(async () => {
			driven.finish?.({ matches: [2], searched: 3, end: "done" })
			await Promise.resolve()
		})
		expect(await screen.findByText("Three")).toBeTruthy()

		// The progress callback's own port keeps no order with the result's: its report comes in last.
		await act(async () => {
			driven.progress?.(3, [2])
			await Promise.resolve()
		})
		expect(screen.getAllByText("Three")).toHaveLength(1)
		expect(screen.getAllByText("1 match").length).toBeGreaterThan(0)
	})

	it("names a row still being read by its place in the list, and lets it take focus", async () => {
		view.current = 1
		searching.current = { progress: null }
		mount()

		fireEvent.change(await screen.findByRole("searchbox", { name: "Search senders and subjects" }), { target: { value: "x" } })

		await vi.waitFor(() => {
			expect(searching.current?.progress).toBeTypeOf("function")
		})
		// A match the list never read (the worker answers null for it), so the page holds no row for it.
		await act(async () => {
			searching.current?.progress?.(10, [9])
			await Promise.resolve()
		})

		const row = await screen.findByRole("button", { name: "Message 1, loading" })

		expect(row.getAttribute("aria-busy")).toBe("true")
		expect((row as HTMLButtonElement).disabled).toBe(false)

		row.focus()

		expect(document.activeElement).toBe(row)
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
