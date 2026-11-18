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

const { readPage } = vi.hoisted(() => ({ readPage: vi.fn<(index: number, maxSolidSkip: number) => Promise<Uint8Array>>() }))

vi.mock("@/lib/sdk/client", () => {
	const leases = new Map<string, EntryReadPlan>()

	return {
		sdkApi: {
			openArchiveReader: () => Promise.resolve(),
			closeArchiveReader: () => Promise.resolve(),
			leaseArchiveEntry: (id: string, _reader: string, plan: EntryReadPlan) => {
				leases.set(id, plan)

				return Promise.resolve()
			},
			releaseArchiveEntry: (id: string) => {
				leases.delete(id)

				return Promise.resolve()
			},
			cancelPreviewDownload: () => Promise.resolve(),
			downloadOriginBytes: (origin: ByteOrigin) => {
				const plan = origin.kind === "entry" ? leases.get(origin.reader) : undefined

				if (origin.kind !== "entry" || plan === undefined) {
					return Promise.reject(new Error("archive reader is closed"))
				}

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
vi.mock("@/features/preview/components/readOnlyPreviewBody", async () => {
	const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")

	return {
		ReadOnlyPreviewBody: ({ item }: { item: Parameters<typeof usePreviewBytes>[0] }) => {
			const result = usePreviewBytes(item)

			return <p>{result.status === "success" ? new TextDecoder().decode(result.bytes) : result.status}</p>
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
	ownParent: null
}

function solid(skipped: number): EntryAccess {
	return { type: "solidBlock", skippedBytes: BigInt(skipped), estimatedPackedBytes: BigInt(skipped + 100), blockPackedBytes: 1000n }
}

function showComic(count: number, solidPages = false) {
	const store = storeOf(
		Array.from({ length: count }, (_, i) => ({
			path: `p${String(i + 1)}.jpg`,
			index: i,
			size: 4,
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
})

describe("ComicPager", () => {
	it("turns pages with Page Down and Page Up, counting them and stopping at the last", async () => {
		showComic(3)

		expect(await screen.findByText("page 1")).toBeTruthy()
		expect(screen.getByText("1 / 3")).toBeTruthy()

		press("PageDown")
		expect(await screen.findByText("page 2")).toBeTruthy()
		press("PageDown")
		expect(await screen.findByText("page 3")).toBeTruthy()
		press("PageDown")
		expect(screen.getByText("3 / 3")).toBeTruthy()
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

	it("shows the cover alone and then pairs, the earlier page on the right when reading right to left", async () => {
		showComic(5)

		fireEvent.click(await screen.findByRole("button", { name: "Two-page spread" }))
		press("PageDown")
		expect(await screen.findByText("2–3 / 5")).toBeTruthy()

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
		expect(await screen.findByText("4–5 / 5")).toBeTruthy()
	})
})
