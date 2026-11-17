// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, type Mock } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File } from "@filen/sdk-rs"
import { PdfEngineError } from "@filen/office/dom/pdfedit"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { PdfReaderShellProps } from "@/features/preview/components/pdfReaderShell"
import { setEbookTextSize } from "@/features/preview/lib/ebookTextSize"
import {
	EBOOK_DEFAULT_TEXT_SIZE,
	EBOOK_RESIZE_DEBOUNCE_MS,
	EBOOK_TEXT_SIZE_DEBOUNCE_MS,
	ebookPageSize
} from "@/features/preview/lib/ebookLayout.logic"
import "@/lib/i18n"

// The e-book reader over a stand-in read service and a stand-in PDF reader shell: its states, the text size laying the
// book out once per burst under a frozen view, and the engine closed with the viewer.

type Relayout = (layout: unknown, page: number) => Promise<{ readonly document: { readonly id: number }; readonly page: number }>

interface FakeReader {
	document: { readonly id: number }
	pageCount: number
	readonly reflowable: true
	readonly metadata: { readonly format: string; readonly title: string; readonly author: null; readonly subject: null }
	readonly relayout: Mock<Relayout>
	readonly close: Mock<() => Promise<void>>
}

const { openMupdfReader, shells } = vi.hoisted(() => ({
	openMupdfReader: vi.fn(),
	shells: [] as PdfReaderShellProps[]
}))

vi.mock("@/lib/mupdf/reader", () => ({ openMupdfReader, mupdfImagePixels: () => 4_000_000 }))
vi.mock("@/features/preview/components/pdfReaderShell", () => ({
	PdfReaderShell: (props: PdfReaderShellProps) => {
		shells.push(props)

		return (
			<div data-testid="shell">
				<span data-testid="document">{String((props.document as unknown as { id: number }).id)}</span>
				{props.commandGroups?.map(group => (
					<div key={group.id}>{group.content}</div>
				))}
				{props.pagesOverlay}
			</div>
		)
	}
}))

function fakeReader(): FakeReader {
	let next = 1
	const reader: FakeReader = {
		document: { id: 0 },
		pageCount: 10,
		reflowable: true,
		metadata: { format: "EPUB", title: "A Book", author: null, subject: null },
		relayout: vi.fn<Relayout>((_layout, page) => {
			const document = { id: next++ }

			reader.document = document

			return Promise.resolve({ document, page: page + 2 })
		}),
		close: vi.fn<() => Promise<void>>(() => Promise.resolve())
	}

	return reader
}

function book(name: string): DriveItem {
	const file: File = {
		uuid: "33333333-3333-3333-3333-333333333333",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 } }
	}

	return narrowItem(file)
}

afterEach(() => {
	cleanup()
	openMupdfReader.mockReset()
	shells.length = 0
	vi.useRealTimers()
})

async function settle(): Promise<void> {
	for (let round = 0; round < 20; round++) await act(() => Promise.resolve())
}

const { EbookViewer } = await import("@/features/preview/components/ebookViewer")

// The always-mounted live region (the visible veil is hidden from assistive technology).
function liveRegion(): HTMLElement {
	const region = document.querySelector<HTMLElement>('[role="status"].sr-only')

	if (region === null) throw new Error("no live region")

	return region
}

function lastShell(): PdfReaderShellProps {
	const shell = shells.at(-1)

	if (shell === undefined) throw new Error("no shell")

	return shell
}

async function openBook(reader: FakeReader = fakeReader()): Promise<{ readonly reader: FakeReader; readonly unmount: () => void }> {
	openMupdfReader.mockResolvedValue(reader)

	const view = render(
		<EbookViewer
			item={book("novel.epub")}
			alt="novel.epub"
		/>
	)

	await settle()

	return { reader, unmount: view.unmount }
}

describe("EbookViewer", () => {
	it("opens the book in its format and closes its engine once with the viewer", async () => {
		const reader = fakeReader()

		openMupdfReader.mockResolvedValue(reader)

		const view = render(
			<EbookViewer
				item={book("novel.fb2")}
				alt="novel.fb2"
			/>
		)

		await settle()
		expect(openMupdfReader).toHaveBeenCalledWith(expect.objectContaining({ format: "fb2", maxImagePixels: 4_000_000 }))
		expect(screen.getByTestId("document").textContent).toBe("0")

		view.unmount()
		expect(reader.close).toHaveBeenCalledOnce()
	})

	it.each([
		["notSupported", "This e-book can't be shown here. It may be damaged or protected."],
		["overBudget", "This e-book is too large to show on this device."],
		["readFailed", "This e-book couldn't be read. Check your connection and try again."]
	])("says why a book cannot open (%s)", async (failure, message) => {
		openMupdfReader.mockRejectedValueOnce(new PdfEngineError(failure as "notSupported", failure))
		openMupdfReader.mockResolvedValue(fakeReader())
		render(
			<EbookViewer
				item={book("novel.epub")}
				alt="novel.epub"
			/>
		)
		await settle()
		expect(screen.getByText(message)).toBeTruthy()

		const retry = screen.queryByRole("button", { name: "Try again" })

		expect(retry !== null).toBe(failure === "readFailed")

		if (retry !== null) {
			fireEvent.click(retry)
			await settle()
			expect(screen.getByTestId("shell")).toBeTruthy()
		}
	})

	it("lays the book out once per burst of text size steps, frozen meanwhile, then shows the anchored page", async () => {
		vi.useFakeTimers()

		const reader = fakeReader()
		let release: () => void = () => undefined

		reader.relayout.mockImplementationOnce((_layout, page) => {
			const document = { id: 7 }

			reader.document = document

			return new Promise(resolve => {
				release = () => {
					resolve({ document, page: page + 3 })
				}
			})
		})
		openMupdfReader.mockResolvedValue(reader)
		render(
			<EbookViewer
				item={book("novel.epub")}
				alt="novel.epub"
			/>
		)
		await settle()

		const larger = screen.getByRole("button", { name: "Larger text" })

		fireEvent.click(larger)
		fireEvent.click(larger)
		fireEvent.click(larger)
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_TEXT_SIZE_DEBOUNCE_MS + 10))

		expect(reader.relayout).toHaveBeenCalledOnce()
		expect(reader.relayout.mock.calls[0]?.[0]).toMatchObject({ em: 16 })
		expect(liveRegion().textContent).toBe("Laying out…")

		await act(async () => {
			release()
			await Promise.resolve()
		})
		await settle()

		expect(liveRegion().textContent).toBe("")
		expect(screen.getByTestId("document").textContent).toBe("7")
		expect(shells.at(-1)?.goTo?.page).toBe(4)

		fireEvent.click(screen.getByRole("button", { name: "Smaller text" }))
		fireEvent.click(screen.getByRole("button", { name: "Smaller text" }))
		fireEvent.click(screen.getByRole("button", { name: "Smaller text" }))
	})

	it("lays the book out at the pages area's size, as the outline pane opening beside it changes it", async () => {
		vi.useFakeTimers()

		const { reader } = await openBook()

		// The pages scroller, narrowed by the outline pane (wide enough a change to count).
		act(() => {
			lastShell().onPagesResize?.(700, 800)
		})
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_RESIZE_DEBOUNCE_MS + 10))
		expect(reader.relayout).toHaveBeenCalledOnce()
		expect(reader.relayout.mock.calls[0]?.[0]).toMatchObject(ebookPageSize(700, 800))

		// A height change of under a fifth (a find bar) lays nothing out.
		act(() => {
			lastShell().onPagesResize?.(700, 760)
		})
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_RESIZE_DEBOUNCE_MS + 10))
		expect(reader.relayout).toHaveBeenCalledOnce()
	})

	it("lays a text size step out at the latest page size, after a resize that came first", async () => {
		vi.useFakeTimers()

		const { reader } = await openBook()

		act(() => {
			lastShell().onPagesResize?.(1000, 900)
		})
		await act(() => vi.advanceTimersByTimeAsync(200))
		fireEvent.click(screen.getByRole("button", { name: "Larger text" }))
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_RESIZE_DEBOUNCE_MS + EBOOK_TEXT_SIZE_DEBOUNCE_MS + 10))

		const last = reader.relayout.mock.calls.at(-1)?.[0]

		expect(last).toMatchObject({ ...ebookPageSize(1000, 900), em: 12 })
		fireEvent.click(screen.getByRole("button", { name: "Smaller text" }))
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_TEXT_SIZE_DEBOUNCE_MS + 10))
	})

	it("closes an engine whose open settled after the viewer went", async () => {
		const reader = fakeReader()
		const opened = Promise.withResolvers<FakeReader>()

		openMupdfReader.mockReturnValue(opened.promise)

		const view = render(
			<EbookViewer
				item={book("novel.epub")}
				alt="novel.epub"
			/>
		)

		view.unmount()
		opened.resolve(reader)
		await settle()
		expect(reader.close).toHaveBeenCalledOnce()
	})

	it("closes the engine when a relayout fails, and offers no Retry for a book that breaks its engine twice", async () => {
		vi.useFakeTimers()

		const reader = fakeReader()

		reader.relayout.mockRejectedValueOnce(new PdfEngineError("failed", "layout broke"))
		await openBook(reader)
		fireEvent.click(screen.getByRole("button", { name: "Larger text" }))
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_TEXT_SIZE_DEBOUNCE_MS + 10))
		await settle()
		expect(reader.close).toHaveBeenCalledOnce()
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
		act(() => {
			setEbookTextSize(EBOOK_DEFAULT_TEXT_SIZE)
		})
		vi.useRealTimers()

		// Its engine poisoned: Retry reopens it once; poisoned again, the book is not offered again.
		cleanup()
		openMupdfReader.mockImplementation((options: { readonly onPoisoned: (message: string) => void }) => {
			queueMicrotask(() => {
				options.onPoisoned("out of memory")
			})

			return new Promise(() => undefined)
		})
		render(
			<EbookViewer
				item={book("novel.epub")}
				alt="novel.epub"
			/>
		)
		await settle()
		fireEvent.click(screen.getByRole("button", { name: "Try again" }))
		await settle()
		expect(screen.getByText("This e-book can't be shown here. It may be damaged or protected.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
	})

	it("leaves no visibility listener behind once the viewer goes", async () => {
		const added = vi.spyOn(document, "addEventListener")
		const removed = vi.spyOn(document, "removeEventListener")
		const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")

		vi.useFakeTimers()

		const { unmount } = await openBook()

		fireEvent.click(screen.getByRole("button", { name: "Larger text" }))
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_TEXT_SIZE_DEBOUNCE_MS + 10))
		fireEvent.click(screen.getByRole("button", { name: "Smaller text" }))
		await act(() => vi.advanceTimersByTimeAsync(EBOOK_TEXT_SIZE_DEBOUNCE_MS + 10))
		unmount()

		const listeners = (spy: typeof added) =>
			spy.mock.calls.filter(([type]) => type === "visibilitychange").map(([, listener]) => listener)

		expect(listeners(added).length).toBeGreaterThan(0)
		expect(listeners(added).every(listener => listeners(removed).includes(listener))).toBe(true)
		hidden.mockRestore()
	})

	it("names the text size for assistive technology, keeps a live region mounted and turns the full-read guard off", async () => {
		await openBook()

		const value = screen.getByRole("status", { name: "Text size" })

		expect(value.tagName).toBe("OUTPUT")
		expect(liveRegion().textContent).toBe("")
		expect(lastShell().fullReadGuard).toBe(false)
	})
})
