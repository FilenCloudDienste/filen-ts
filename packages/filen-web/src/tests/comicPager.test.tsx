// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import type { AnyFile, EntryAccess, UuidStr } from "@filen/sdk-rs"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import type { EntryReadPlan } from "@/lib/sdk/archiveListing"
import "@/lib/i18n"

// The comic reader's pager over a listed comic: pages read through leases on the archive's reader (the worker stood
// in for by readPage), the solid cost asked once, the page keys, the spread and right-to-left toggles, the read-ahead.

const { readPage, sdkCancels, pageTokens, leasePlans } = vi.hoisted(() => ({
	// Every lease's plan, in order.
	leasePlans: [] as EntryReadPlan[],
	readPage: vi.fn<(index: number, maxSolidSkip: number) => Promise<Uint8Array>>(),
	sdkCancels: vi.fn<(token: string) => void>(),
	// Each read's cancel token, to the page it read.
	pageTokens: new Map<string, number>()
}))

vi.mock("@/lib/sdk/client", () => {
	const leases = new Map<string, EntryReadPlan>()

	return {
		sdkApi: {
			openArchiveReader: () => Promise.resolve(),
			closeArchiveReader: () => Promise.resolve(),
			archiveReaderHeldBytes: () => Promise.resolve(0),
			leaseArchiveEntry: (id: string, _reader: string, plan: EntryReadPlan) => {
				leases.set(id, plan)
				leasePlans.push(plan)

				return Promise.resolve()
			},
			releaseArchiveEntry: (id: string) => {
				leases.delete(id)

				return Promise.resolve()
			},
			cancelPreviewDownload: (token: string) => {
				sdkCancels(token)

				return Promise.resolve()
			},
			downloadOriginBytes: (origin: ByteOrigin, _access: string, _cap: number, token: string) => {
				const plan = origin.kind === "entry" ? leases.get(origin.reader) : undefined

				if (origin.kind !== "entry" || plan === undefined) {
					return Promise.reject(new Error("archive reader is closed"))
				}

				pageTokens.set(token, origin.entry.index)

				return readPage(origin.entry.index, plan.maxSolidSkip)
			}
		}
	}
})
// Wide: the spread layout applies.
vi.mock("@/features/shell/hooks/useIsNarrowViewport", () => ({ useIsNarrowViewport: () => false }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
// The image viewer stood in for by its bytes as text, on screen (ImageShownContext) once they are in.
vi.mock("@/features/preview/components/readOnlyPreviewBody", async () => {
	const { use, useEffect } = await import("react")
	const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")
	const { ImageShownContext } = await import("@/features/preview/lib/imageDisplay")

	return {
		ReadOnlyPreviewBody: ({ item, alt }: { item: Parameters<typeof usePreviewBytes>[0]; alt: string }) => {
			const result = usePreviewBytes(item)
			const shown = use(ImageShownContext)
			const success = result.status === "success"

			useEffect(() => {
				if (success) {
					shown?.({ width: 2, height: 3 })
				}
			}, [success, shown])

			return <p title={alt}>{success ? new TextDecoder().decode(result.bytes) : result.status}</p>
		}
	}
})

const { queryClient } = await import("@/queries/client")
const { ComicPager } = await import("@/features/comics/components/comicPager")
const { comicPages } = await import("@/features/comics/lib/pages.logic")
const { setComicDirection, setComicLayout } = await import("@/features/comics/lib/comicPreferences")
const { clearPreviewCache } = await import("@/features/preview/lib/previewCache")
const { runPreviewDisposers } = await import("@/lib/workers/previewDisposers")
const { storeOf, TEST_ARCHIVE } = await import("@/tests/support/archiveEntries")
const { PREVIEW_ACTIONS } = await import("@/features/preview/lib/keymap")
const { registerAction } = await import("@/lib/keymap/registry")

type Session = NonNullable<Parameters<typeof ComicPager>[0]["session"] extends () => infer S ? S : never>

const SOURCE = {
	file: { uuid: TEST_ARCHIVE } as unknown as AnyFile,
	uuid: TEST_ARCHIVE as UuidStr,
	name: "issue.cbr",
	size: 1000,
	anon: false,
	nested: null,
	ownParent: null
}

function solid(skipped: number): EntryAccess {
	return { type: "solidBlock", skippedBytes: BigInt(skipped), estimatedPackedBytes: BigInt(skipped + 100), blockPackedBytes: 1000n }
}

function showComic(count: number, solidPages = false, sizeOf: (index: number) => number = () => 4) {
	const store = storeOf(
		Array.from({ length: count }, (_, i) => ({
			path: `p${String(i + 1)}.jpg`,
			index: i,
			size: sizeOf(i),
			access: solidPages ? solid(i * 4) : ({ type: "direct", packedBytes: 4n } as const)
		}))
	)
	let accepted = false
	const session = {
		password: () => undefined,
		costAccepted: () => accepted,
		acceptCost: vi.fn(() => {
			accepted = true
		}),
		acceptPassword: vi.fn()
	} as unknown as Session

	render(
		<QueryClientProvider client={queryClient}>
			<ComicPager
				source={SOURCE}
				store={store}
				pages={comicPages(store)}
				session={() => session}
			/>
		</QueryClientProvider>
	)

	return session
}

function press(key: string): void {
	act(() => {
		fireEvent.keyDown(document.body, { key, code: key })
	})
}

beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	clearPreviewCache()
	setComicLayout("single")
	setComicDirection("ltr")
	readPage.mockImplementation(index => Promise.resolve(new TextEncoder().encode(`page ${String(index + 1)}`)))
})

afterEach(() => {
	cleanup()
	runPreviewDisposers()
	vi.clearAllMocks()
	leasePlans.length = 0
})

describe("ComicPager", () => {
	it("turns pages with Page Down and Page Up, counting them and stopping at the last", async () => {
		showComic(3)

		expect(await screen.findByText("page 1")).toBeTruthy()
		expect(screen.getAllByText("1 / 3")).toHaveLength(2)

		press("PageDown")
		expect(await screen.findByText("page 2")).toBeTruthy()
		press("PageDown")
		expect(await screen.findByText("page 3")).toBeTruthy()
		press("PageDown")
		expect(screen.getAllByText("3 / 3")).toHaveLength(2)
		press("PageUp")
		expect(await screen.findByText("page 2")).toBeTruthy()
	})

	it("asks a solid comic's cost once, then turns every later page unasked, each within its own skip", async () => {
		const session = showComic(4, true)

		expect(await screen.findByText("page 1")).toBeTruthy()
		press("PageDown")

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("You won't be asked again while this archive is open.")
		fireEvent.click(within(dialog).getByRole("button", { name: "Open" }))
		expect(await screen.findByText("page 2")).toBeTruthy()
		expect(session.acceptCost).toHaveBeenCalledTimes(1)

		press("PageDown")
		expect(await screen.findByText("page 3")).toBeTruthy()
		expect(screen.queryByRole("alertdialog")).toBeNull()

		const skips = new Map(readPage.mock.calls.map(([index, skip]) => [index, skip]))

		expect(skips.get(1)).toBe(4)
		expect(skips.get(2)).toBe(8)
	})

	it("reads the next page ahead once the shown one is in, and nothing of a solid comic before its cost is accepted", async () => {
		showComic(3)

		expect(await screen.findByText("page 1")).toBeTruthy()
		await vi.waitFor(() => {
			expect(readPage.mock.calls.map(([index]) => index)).toContain(1)
		})

		cleanup()
		readPage.mockClear()
		clearPreviewCache()
		showComic(3, true)

		expect(await screen.findByText("page 1")).toBeTruthy()
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(readPage.mock.calls.map(([index]) => index)).toEqual([0])
	})

	it("turned back, reads the window before the page shown, and the page before it ahead", async () => {
		showComic(6, true)

		expect(await screen.findByText("page 1")).toBeTruthy()
		press("PageDown")
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Open" }))

		for (const page of [2, 3, 4]) {
			expect(await screen.findByText(`page ${String(page)}`)).toBeTruthy()
			press("PageDown")
		}

		expect(await screen.findByText("page 5")).toBeTruthy()
		leasePlans.length = 0
		readPage.mockClear()
		press("PageUp")
		expect(await screen.findByText("page 4")).toBeTruthy()
		await vi.waitFor(() => {
			expect(readPage.mock.calls.map(([index]) => index)).toContain(2)
		})

		// Page 4's window ends at it, taking the pages before it; nothing after it is read.
		const own = leasePlans.find(plan => plan.window.at(-1)?.index === 3)

		expect(own?.window.map(item => item.index)).toEqual([0, 1, 2, 3])
		expect(own?.windowSkip).toBe(0)
		expect(readPage.mock.calls.map(([index]) => index)).not.toContain(4)
	})

	it("keeps the read ahead of the page a turn shows, which its viewer joins: read once", async () => {
		const second = Promise.withResolvers<Uint8Array>()

		readPage.mockImplementation(index =>
			index === 1 ? second.promise : Promise.resolve(new TextEncoder().encode(`page ${String(index + 1)}`))
		)
		showComic(3)

		expect(await screen.findByText("page 1")).toBeTruthy()
		await vi.waitFor(() => {
			expect(readPage.mock.calls.map(([index]) => index)).toContain(1)
		})
		press("PageDown")
		second.resolve(new TextEncoder().encode("page 2"))
		expect(await screen.findByText("page 2")).toBeTruthy()
		expect(readPage.mock.calls.filter(([index]) => index === 1)).toHaveLength(1)
		expect(sdkCancels.mock.calls.map(([token]) => pageTokens.get(token))).not.toContain(1)
	})

	it("turns one page with Page Down on the slider, and names its value as a page of the book", async () => {
		showComic(5)

		expect(await screen.findByText("page 1")).toBeTruthy()

		// The thumb's range input (jsdom lays nothing out, so Base UI keeps the thumb hidden from role queries).
		const range = (): HTMLInputElement => {
			const input = document.querySelector<HTMLInputElement>("input[type=range]")

			if (input === null) {
				throw new Error("no slider")
			}

			return input
		}
		const thumb = range()

		expect(thumb.getAttribute("aria-valuetext")).toBe("Page 1 of 5")
		act(() => {
			fireEvent.keyDown(thumb, { key: "PageDown", code: "PageDown" })
		})
		expect(await screen.findByText("page 2")).toBeTruthy()
		expect(screen.getAllByText("2 / 5").length).toBeGreaterThan(0)
		expect(range().getAttribute("aria-valuetext")).toBe("Page 2 of 5")
	})

	it("keeps a page too large to show in its place with a note, the numbering the book's", async () => {
		showComic(3, false, index => (index === 1 ? 2 ** 40 : 4))

		expect(await screen.findByText("page 1")).toBeTruthy()
		press("PageDown")
		expect(await screen.findByText(/Page 2 is too large to show here/)).toBeTruthy()
		expect(screen.getAllByText("2 / 3").length).toBeGreaterThan(0)
		expect(readPage.mock.calls.map(([index]) => index)).not.toContain(1)
		press("PageDown")
		expect(await screen.findByText("page 3")).toBeTruthy()
	})

	it("shows the cover alone and then pairs, the earlier page on the right when reading right to left", async () => {
		showComic(5)

		fireEvent.click(await screen.findByRole("button", { name: "Two-page spread" }))
		press("PageDown")
		expect(await screen.findAllByText("2–3 / 5")).toHaveLength(2)

		const shown = (): string[] => screen.getAllByText(/^page \d$/).map(page => page.textContent)

		await vi.waitFor(() => {
			expect(shown()).toEqual(["page 2", "page 3"])
		})

		fireEvent.click(screen.getByRole("button", { name: "Right to left" }))
		await vi.waitFor(() => {
			expect(shown()).toEqual(["page 3", "page 2"])
		})
		// ◀ goes forward now.
		fireEvent.click(screen.getByRole("button", { name: "Next page" }))
		expect(await screen.findAllByText("4–5 / 5")).toHaveLength(2)
	})
})
