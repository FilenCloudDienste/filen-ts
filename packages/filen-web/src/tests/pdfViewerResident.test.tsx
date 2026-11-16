// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { RESIDENT_IDLE_MS } from "@filen/office/react/pdf"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// The preview's PDF viewer reopening a ranged document that holds more than the device's resident limit once its
// reads settle, against a stand-in pdf.js whose range transport the test drives: the page in view is kept, an open
// search, a pending read or an editor starting holds the reopen off, and a reopened document that needs more than the
// limit for its view is not reopened again for it.

// Bytes a document may hold before it counts as resident: the device's limit, scaled down so a test reads a few bytes
// (the pdfLimits mock below says the same; vi.mock factories cannot read module constants).
const RESIDENT_LIMIT = 40

interface FakeTransport {
	requestDataRange: (begin: number, end: number) => void
	onDataRange: ReturnType<typeof vi.fn>
}

interface Opened {
	readonly transport: FakeTransport
	readonly destroy: ReturnType<typeof vi.fn>
}

const { opened, rangeSource, slow, editor } = vi.hoisted(() => {
	// Reads answered only when the test says so, while `held` is on.
	const slow = { held: false, answers: [] as (() => void)[] }
	// Never read to its end, so nothing reads as a full read.
	const rangeSource = {
		kind: "ranges",
		length: 10_000,
		read: (_offset: number, length: number) =>
			slow.held
				? new Promise<Uint8Array>(resolve => {
						slow.answers.push(() => {
							resolve(new Uint8Array(length))
						})
					})
				: Promise.resolve(new Uint8Array(length))
	} as const

	return { opened: [] as Opened[], rangeSource, slow, editor: { warm: (): void => undefined } }
})

// The editor never finishes starting: it stays in its starting phase, reading the viewer document's facts.
vi.mock("@/features/pdf/session/engineWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/pdf/session/engineWorker")>()),
	openPdfEngine: () => new Promise(() => undefined)
}))

vi.mock("@filen/office/react/pdfedit", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/pdfedit")>()),
	readPdfDocumentFacts: () => new Promise(() => undefined)
}))

vi.mock("@/features/pdf/session/usePdfEdit", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/pdf/session/usePdfEdit")>()

	return {
		...actual,
		usePdfEdit: (...args: Parameters<typeof actual.usePdfEdit>) => {
			const view = actual.usePdfEdit(...args)

			editor.warm = () => {
				view.swap.warm()
			}

			return view
		}
	}
})

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve(),
	kvGet: () => Promise.resolve(null),
	kvHas: () => Promise.resolve(false),
	kvEntriesJson: () => Promise.resolve([]),
	kvEntriesJsonInSlices: () => Promise.resolve([]),
	kvDeletePrefix: () => Promise.resolve(),
	kvDeleteIfAt: () => Promise.resolve([]),
	isMissingStorageMethod: () => false
}))

vi.mock("@/features/preview/lib/pdfLimits", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/lib/pdfLimits")>()

	return { ...actual, pdfViewerLimits: () => ({ ...actual.pdfViewerLimits(), residentReopenBytes: 40 }) }
})

// One stable source, as the hook keeps it across renders.
vi.mock("@/features/preview/hooks/usePreviewRangeSource", () => ({
	usePreviewRangeSource: () => ({ status: "success", source: rangeSource, refetch: () => undefined })
}))

function fakePage(): unknown {
	return {
		getViewport: vi.fn(() => ({ width: 100, height: 100, convertToViewportPoint: (x: number, y: number) => [x, y] })),
		render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
		cleanup: vi.fn(() => true),
		streamTextContent: () => [],
		getTextContent: () => Promise.resolve({ items: [] }),
		getAnnotations: vi.fn(() => Promise.resolve([])),
		userUnit: 1,
		rotate: 0
	}
}

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PDFDataRangeTransport: class {
		requestDataRange: (begin: number, end: number) => void = () => undefined
		readonly onDataRange = vi.fn()
	},
	TextLayer: class {
		readonly textDivs: HTMLElement[] = []
		readonly textContentItemsStr: string[] = []

		render(): Promise<void> {
			return Promise.resolve()
		}

		update(): void {
			// No text to lay out again.
		}

		cancel(): void {
			// Renders at once.
		}

		static cleanup(): void {
			// No measuring canvases.
		}
	},
	getDocument: (params: { range?: FakeTransport }) => {
		const pages = new Map([1, 2, 3].map(n => [n, fakePage()]))
		const destroy = vi.fn(() => Promise.resolve())

		if (params.range === undefined) {
			throw new Error("the viewer opened the ranged file whole")
		}

		opened.push({ transport: params.range, destroy })

		return {
			promise: Promise.resolve({
				numPages: 3,
				getPage: (n: number) => Promise.resolve(pages.get(n)),
				getDestination: () => Promise.resolve(null),
				getPageIndex: () => Promise.resolve(0),
				getOutline: () => Promise.resolve(null),
				getMetadata: () => Promise.resolve({ info: {} })
			}),
			destroy
		}
	}
}))

interface Observed {
	callback: IntersectionObserverCallback
	elements: Set<Element>
}

const observers: Observed[] = []

class FakeIntersectionObserver {
	readonly entry: Observed

	constructor(callback: IntersectionObserverCallback) {
		this.entry = { callback, elements: new Set() }
		observers.push(this.entry)
	}

	observe(element: Element): void {
		this.entry.elements.add(element)
	}

	unobserve(element: Element): void {
		this.entry.elements.delete(element)
	}

	disconnect(): void {
		this.entry.elements.clear()
	}
}

const { PdfViewer } = await import("@/features/preview/components/pdfViewer")

registerAllActions()

// Above one SDK block, so the viewer reads it in ranges.
const item = linkedFileItem("big.pdf", {
	uuid: "aaaaaaaa-0000-0000-0000-000000000002",
	mime: { Decrypted: "application/pdf" },
	size: 300n * 1024n * 1024n
})

function pageElement(n: number): Element {
	const element = document.querySelector(`[data-page="${String(n)}"]`)

	if (element === null) {
		throw new Error(`no page ${String(n)}`)
	}

	return element
}

function box(top: number, height: number): DOMRect {
	return { x: 0, y: top, left: 0, top, right: 100, bottom: top + height, width: 100, height, toJSON: () => ({}) }
}

// Scrolls page `n` into view, as pdfViewerPages.test.tsx does: jsdom lays nothing out, so the pages are stacked around
// it for the viewer's page-in-view measure, a frame after the scroll.
async function show(n: number): Promise<void> {
	const scroller = pageElement(n).closest("[tabindex]")

	if (scroller === null) {
		throw new Error("no scroller")
	}

	Object.defineProperty(scroller, "getBoundingClientRect", { configurable: true, value: () => box(0, 100) })

	for (const page of [1, 2, 3]) {
		Object.defineProperty(pageElement(page), "getBoundingClientRect", { configurable: true, value: () => box((page - n) * 100, 100) })
	}

	await act(async () => {
		scroller.dispatchEvent(new Event("scroll"))
		await new Promise(resolve => requestAnimationFrame(resolve))

		for (const observed of observers) {
			observed.callback(
				[{ target: pageElement(n), isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
				{} as IntersectionObserver
			)
		}
	})
}

function latest(): Opened {
	const last = opened.at(-1)

	if (last === undefined) {
		throw new Error("nothing opened")
	}

	return last
}

// pdf.js asks the latest document's transport for [begin, end); the read is answered at once.
async function read(begin: number, end: number): Promise<void> {
	await act(async () => {
		latest().transport.requestDataRange(begin, end)
		await vi.advanceTimersByTimeAsync(0)
	})
}

async function idle(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms)
	})
}

const HOST = { writable: true, onDirtyChange: () => undefined, saveRef: { current: null }, onSave: () => false }

async function mount(editable = false): Promise<void> {
	render(
		<PdfViewer
			item={item}
			alt="big.pdf"
			{...(editable ? { editing: HOST } : {})}
		/>,
		{ wrapper: queryClientWrapper(createTestQueryClient()) }
	)

	await waitFor(() => {
		expect(screen.getByText("Page 1 of 3")).toBeTruthy()
	})
	// Only the idle wait is faked: the renders, frames and observers run as they would.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
}

beforeEach(() => {
	observers.length = 0
	opened.length = 0
	slow.held = false
	slow.answers.length = 0
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
	Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("PdfViewer resident reopen", () => {
	it("reopens a ranged document over the limit once its reads settle, keeping the page in view", async () => {
		await mount()
		await show(2)
		expect(screen.getByText("Page 2 of 3")).toBeTruthy()

		// Under the limit: held, however long it idles.
		await read(0, RESIDENT_LIMIT - 10)
		await idle(RESIDENT_IDLE_MS)
		expect(opened).toHaveLength(1)

		// Over it, but still reading: no reopen yet.
		await read(RESIDENT_LIMIT, RESIDENT_LIMIT + 20)
		await idle(RESIDENT_IDLE_MS - 1)
		expect(opened).toHaveLength(1)

		await idle(1)
		expect(opened).toHaveLength(2)
		expect(opened[0]?.destroy).toHaveBeenCalledTimes(1)
		expect(opened[1]?.destroy).not.toHaveBeenCalled()
		expect(screen.getByText("Page 2 of 3")).toBeTruthy()
	})

	it("never reopens a reopened document for what its view needs, only for the limit read past it", async () => {
		await mount()
		await read(0, RESIDENT_LIMIT + 1)
		await idle(RESIDENT_IDLE_MS)
		expect(opened).toHaveLength(2)

		// The new document needs more than the limit for the view where it was: another reopen would read it all again.
		await read(0, RESIDENT_LIMIT + 1)
		await idle(RESIDENT_IDLE_MS)
		expect(opened).toHaveLength(2)

		// Moving the view reads nothing new: nothing reopens.
		await show(3)
		await show(2)
		await idle(RESIDENT_IDLE_MS)
		expect(opened).toHaveLength(2)

		// More than the limit read past what the view needed, on another page: reopened.
		await show(3)
		await read(RESIDENT_LIMIT + 1, 2 * RESIDENT_LIMIT + 2)
		await idle(RESIDENT_IDLE_MS)
		expect(opened).toHaveLength(3)
		expect(opened[1]?.destroy).toHaveBeenCalledTimes(1)
	})

	it("waits while a read is still pending, however long it takes", async () => {
		await mount()
		await read(0, RESIDENT_LIMIT + 1)
		slow.held = true
		await idle(RESIDENT_IDLE_MS - 1)
		await read(RESIDENT_LIMIT + 1, RESIDENT_LIMIT + 2)
		await idle(RESIDENT_IDLE_MS * 3)
		expect(opened).toHaveLength(1)

		await act(async () => {
			slow.answers.shift()?.()
			await vi.advanceTimersByTimeAsync(RESIDENT_IDLE_MS)
		})
		expect(opened).toHaveLength(2)
	})

	it("never reopens while the editor starts from the document", async () => {
		await mount(true)
		act(() => {
			editor.warm()
		})

		await read(0, RESIDENT_LIMIT + 1)
		await idle(RESIDENT_IDLE_MS * 2)
		expect(opened).toHaveLength(1)
		expect(opened[0]?.destroy).not.toHaveBeenCalled()
	})

	it("holds the reopen while a search is open, and reopens once it closes", async () => {
		await mount()
		fireEvent.click(screen.getByRole("button", { name: "Find in document" }))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})

		await read(0, RESIDENT_LIMIT + 1)
		await idle(RESIDENT_IDLE_MS)
		expect(opened).toHaveLength(1)

		fireEvent.click(screen.getByRole("button", { name: "Close find" }))
		await idle(0)
		expect(opened).toHaveLength(2)
	})
})
