// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { isTextEditingTarget } from "@/features/preview/components/previewOverlay.logic"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// The preview's PDF viewer on @filen/office's pages against a stand-in pdf.js: pages, the link gate, find and the
// command bar (page field, rotate, outline, properties, zoom menu, F6).

interface FakePage {
	getViewport: ReturnType<typeof vi.fn>
	render: ReturnType<typeof vi.fn>
	cleanup: ReturnType<typeof vi.fn>
	streamTextContent: () => unknown
	getTextContent: () => Promise<{ items: unknown[] }>
	getAnnotations: ReturnType<typeof vi.fn>
	userUnit: number
	rotate: number
}

const { pages, outline, info, scrolled } = vi.hoisted(() => {
	const outline: { items: unknown[] | null } = { items: null }
	const info: { value: Record<string, unknown> } = { value: {} }

	return { pages: new Map<number, FakePage>(), outline, info, scrolled: [] as Element[] }
})

// The link gate reads the trusted link domains.
// The viewer reaches the account's cached settings (whether earlier versions are kept): an empty store.
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

function fakePage(text: string[] = []): FakePage {
	const items = text.map(str => ({ str, hasEOL: false }))

	return {
		getViewport: vi.fn(() => ({ width: 100, height: 100, convertToViewportPoint: (x: number, y: number) => [x, y] })),
		render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
		cleanup: vi.fn(() => true),
		streamTextContent: () => items,
		getTextContent: () => Promise.resolve({ items }),
		getAnnotations: vi.fn(() => Promise.resolve([])),
		userUnit: 1,
		rotate: 0
	}
}

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	// Only a ranged source constructs one.
	PDFDataRangeTransport: vi.fn(),
	TextLayer: class {
		readonly textDivs: HTMLElement[] = []
		readonly textContentItemsStr: string[] = []
		private readonly params: { textContentSource: { str: string }[]; container: HTMLElement }

		constructor(params: { textContentSource: { str: string }[]; container: HTMLElement }) {
			this.params = params
		}

		render(): Promise<void> {
			for (const { str } of this.params.textContentSource) {
				const span = document.createElement("span")

				span.textContent = str
				this.textDivs.push(span)
				this.textContentItemsStr.push(str)
				this.params.container.append(span)
			}

			return Promise.resolve()
		}

		cancel(): void {
			// Renders at once.
		}
	},
	getDocument: () => ({
		promise: Promise.resolve({
			numPages: 3,
			getPage: (n: number) => Promise.resolve(pages.get(n)),
			getDestination: (id: string) => Promise.resolve(id === "third" ? [{ page: 3 }] : null),
			getPageIndex: (ref: { page: number }) => Promise.resolve(ref.page - 1),
			getOutline: () => Promise.resolve(outline.items),
			getMetadata: () => Promise.resolve({ info: info.value })
		}),
		destroy: () => Promise.resolve()
	})
}))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([1]), refetch: () => undefined })
}))

interface Observed {
	callback: IntersectionObserverCallback
	options: IntersectionObserverInit | undefined
	elements: Set<Element>
}

const observers: Observed[] = []

class FakeIntersectionObserver {
	readonly entry: Observed

	constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
		this.entry = { callback, options, elements: new Set() }
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

const item = linkedFileItem("doc.pdf", { uuid: "aaaaaaaa-0000-0000-0000-000000000001", mime: { Decrypted: "application/pdf" }, size: 1n })

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

// Scrolls a page into view, as the view would: jsdom lays nothing out, so the pages are stacked around page `n`
// (it fills a 100px view) for the viewer's page-in-view measure, which runs a frame after the scroll, and page `n`
// enters both observer margins.
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

beforeEach(() => {
	observers.length = 0
	pages.clear()
	outline.items = null
	info.value = {}

	for (const n of [1, 2, 3]) {
		pages.set(n, fakePage())
	}

	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
	// jsdom lays nothing out and has no scrollIntoView.
	scrolled.length = 0
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		value: function (this: Element) {
			scrolled.push(this)
		}
	})
})

async function mount(): Promise<void> {
	render(
		<PdfViewer
			item={item}
			alt="doc.pdf"
		/>,
		{ wrapper: queryClientWrapper(createTestQueryClient()) }
	)

	// Page 1 sizes the pages not read yet; a page is read only once it nears the view.
	await waitFor(() => {
		expect(pages.get(1)?.getViewport).toHaveBeenCalled()
	})
	expect(pages.get(2)?.getViewport).not.toHaveBeenCalled()
	expect(pages.get(3)?.getViewport).not.toHaveBeenCalled()
}

describe("PdfViewer", () => {
	it("labels each page's canvas and follows the page most in view", async () => {
		await mount()

		expect(screen.getByLabelText("doc.pdf — Page 2 of 3")).toBeTruthy()
		expect(screen.getByText("Page 1 of 3")).toBeTruthy()

		await show(2)

		expect(await screen.findByText("Page 2 of 3")).toBeTruthy()
	})

	it("asks before a link annotation opens a domain not trusted yet", async () => {
		pages.set(1, {
			...fakePage(),
			getAnnotations: vi.fn(() => Promise.resolve([{ subtype: "Link", url: "https://example.com/x", rect: [0, 0, 10, 10] }]))
		})
		await mount()
		await show(1)

		const link = await screen.findByRole("link", { name: "https://example.com/x" })
		const click = new MouseEvent("click", { bubbles: true, cancelable: true })

		link.dispatchEvent(click)

		expect(click.defaultPrevented).toBe(true)
		expect(await screen.findByRole("alertdialog", { name: "Open external link?" })).toBeTruthy()
	})

	it("finds text from the toolbar and highlights the current match", async () => {
		pages.set(1, fakePage(["alpha beta"]))
		pages.set(3, fakePage(["beta"]))
		await mount()
		await show(1)

		fireEvent.click(screen.getByRole("button", { name: "Find in document" }))
		fireEvent.change(await screen.findByRole("searchbox", { name: "Find" }), { target: { value: "beta" } })

		expect(await screen.findByText("1/2")).toBeTruthy()
		await waitFor(() => {
			expect(pageElement(1).querySelector(".highlight.selected")?.textContent).toBe("beta")
		})

		fireEvent.click(screen.getByRole("button", { name: "Close find" }))

		await waitFor(() => {
			expect(document.querySelector(".highlight")).toBeNull()
		})
		expect(screen.getByText("Page 1 of 3")).toBeTruthy()
	})

	it("goes to a typed page, and to the first and last", async () => {
		await mount()

		const field = screen.getByRole("textbox", { name: "Page number" })

		fireEvent.focus(field)
		fireEvent.change(field, { target: { value: "3" } })
		fireEvent.keyDown(field, { key: "Enter" })
		expect(scrolled.at(-1)).toBe(pageElement(3))

		// Out of range lands on the last page; Escape puts the page in view back.
		fireEvent.change(field, { target: { value: "99" } })
		fireEvent.blur(field)
		expect(scrolled.at(-1)).toBe(pageElement(3))
		fireEvent.change(field, { target: { value: "2" } })
		fireEvent.keyDown(field, { key: "Escape" })
		expect((field as HTMLInputElement).value).toBe("1")

		await show(2)
		fireEvent.click(await screen.findByRole("button", { name: "Last page" }))
		expect(scrolled.at(-1)).toBe(pageElement(3))
		fireEvent.click(screen.getByRole("button", { name: "First page" }))
		expect(scrolled.at(-1)).toBe(pageElement(1))
	})

	// jsdom lays nothing out: the column must size to its widest page (w-max) so a page zoomed wider than the view
	// scrolls into reach on both sides, instead of being centred past the scroller's left edge.
	it("sizes the page column to its widest page so an overflowing page stays reachable", async () => {
		await mount()

		const column = pageElement(1).parentElement

		expect(column?.classList.contains("w-max")).toBe(true)
		expect(column?.classList.contains("min-w-full")).toBe(true)
		expect(column?.classList.contains("items-center")).toBe(true)
	})

	it("turns the pages from the Rotate group", async () => {
		await mount()
		fireEvent.click(screen.getByRole("button", { name: "Rotate clockwise" }))

		await waitFor(() => {
			expect(pages.get(1)?.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 90 })
		})
		fireEvent.click(screen.getByRole("button", { name: "Rotate counterclockwise" }))
		await waitFor(() => {
			expect(pages.get(1)?.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 0 })
		})
	})

	it("offers no outline for a document without bookmarks", async () => {
		await mount()
		expect(screen.queryByRole("button", { name: "Outline" })).toBeNull()
	})

	it("follows a bookmark from the Outline menu", async () => {
		outline.items = [{ title: "Chapter three", dest: "third", items: [] }]
		await mount()

		fireEvent.click(await screen.findByRole("button", { name: "Outline" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Chapter three" }))
		await waitFor(() => {
			expect(scrolled.at(-1)).toBe(pageElement(3))
		})
	})

	it("shows the document's properties from the File menu", async () => {
		info.value = { Title: "Annual report", Author: "Ada", PDFFormatVersion: "1.7" }
		await mount()

		fireEvent.click(screen.getByRole("button", { name: "File" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Document properties" }))

		const dialog = await screen.findByRole("dialog", { name: "Document properties" })

		expect(await within(dialog).findByText("Annual report")).toBeTruthy()
		expect(within(dialog).getByText("Ada")).toBeTruthy()
		expect(within(dialog).getByText("3")).toBeTruthy()
	})

	it("gives the pages focus with Escape on a command bar control, keeping the key from closing the preview", async () => {
		await mount()

		const file = screen.getByRole("button", { name: "File" })

		file.focus()
		expect(fireEvent.keyDown(file, { key: "Escape" })).toBe(false)
		expect(document.activeElement).toBe(document.querySelector<HTMLElement>(".fo-pdf-page")?.closest("[tabindex]"))
	})

	it("moves between the command bar and the pages with F6", async () => {
		await mount()

		const scroller = document.querySelector<HTMLElement>(".fo-pdf-page")?.closest<HTMLElement>("[tabindex]")

		scroller?.focus()
		fireEvent.keyDown(scroller ?? document.body, { key: "F6" })
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "File" }))
		fireEvent.keyDown(screen.getByRole("button", { name: "File" }), { key: "F6" })
		expect(document.activeElement).toBe(scroller)
	})

	it("leaves Left/Right inside the pages to the document instead of the preview's file pager", async () => {
		await mount()

		const page = document.querySelector<HTMLElement>(".fo-pdf-page")
		const scroller = page?.closest<HTMLElement>("[tabindex]")

		// The overlay steps to another file on Left/Right unless the target is a text field or a preview surface;
		// in the pages the keys scroll a zoomed page sideways.
		expect(isTextEditingTarget(scroller ?? null)).toBe(true)
		expect(isTextEditingTarget(page ?? null)).toBe(true)
		expect(isTextEditingTarget(scroller?.closest("[data-preview-surface]")?.parentElement ?? null)).toBe(false)
	})

	it("goes to the command bar with F6 pressed outside the viewer", async () => {
		await mount()

		// Focus outside the viewer, as on the preview overlay itself after a click in Safari and macOS Firefox.
		fireEvent.keyDown(document.body, { key: "F6" })
		expect(document.activeElement?.closest("[data-office-ribbon]")).not.toBeNull()
	})

	it("keeps the command row one Tab stop with the zoom menu's steps and fits", async () => {
		await mount()

		const row = screen.getByRole("toolbar", { name: "Commands" })

		expect(row.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
		fireEvent.click(within(row).getByRole("button", { name: "Zoom level, 100%" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "200%" }))
		expect(await within(row).findByRole("button", { name: "Zoom level, 200%" })).toBeTruthy()
		fireEvent.click(within(row).getByRole("button", { name: "Zoom level, 200%" }))
		expect(await screen.findByRole("menuitemradio", { name: "Fit page" })).toBeTruthy()
	})

	// The common PDF viewers' keys; each is kept from the browser, whose page zoom would scale the whole app.
	it("zooms, resets, fits and rotates from the keyboard instead of zooming the page", async () => {
		await mount()

		const row = screen.getByRole("toolbar", { name: "Commands" })
		const scroller = document.querySelector<HTMLElement>(".fo-pdf-page")?.closest<HTMLElement>("[tabindex]") ?? document.body

		expect(fireEvent.keyDown(scroller, { key: "=", code: "Equal", ctrlKey: true })).toBe(false)
		expect(await within(row).findByRole("button", { name: "Zoom level, 125%" })).toBeTruthy()
		expect(fireEvent.keyDown(scroller, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })).toBe(false)
		expect(await within(row).findByRole("button", { name: "Zoom level, 150%" })).toBeTruthy()
		expect(fireEvent.keyDown(scroller, { key: "-", code: "Minus", ctrlKey: true })).toBe(false)
		expect(await within(row).findByRole("button", { name: "Zoom level, 125%" })).toBeTruthy()
		expect(fireEvent.keyDown(scroller, { key: "0", code: "Digit0", ctrlKey: true })).toBe(false)
		expect(await within(row).findByRole("button", { name: "Zoom level, 100%" })).toBeTruthy()

		expect(fireEvent.keyDown(scroller, { key: "]", code: "BracketRight", ctrlKey: true })).toBe(false)
		await waitFor(() => {
			expect(pages.get(1)?.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 90 })
		})
		expect(fireEvent.keyDown(scroller, { key: "[", code: "BracketLeft", ctrlKey: true })).toBe(false)
		await waitFor(() => {
			expect(pages.get(1)?.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 0 })
		})

		expect(fireEvent.keyDown(scroller, { key: "\\", code: "Backslash", ctrlKey: true })).toBe(false)
		fireEvent.click(within(row).getByRole("button", { name: /^Zoom level/u }))
		expect((await screen.findByRole("menuitemradio", { name: "Fit to width" })).getAttribute("aria-checked")).toBe("true")
	})

	it("takes the zoom keys pressed outside the viewer in its layer, and at a zoom limit", async () => {
		await mount()

		const row = screen.getByRole("toolbar", { name: "Commands" })

		expect(fireEvent.keyDown(document.body, { key: "=", code: "Equal", ctrlKey: true })).toBe(false)
		expect(await within(row).findByRole("button", { name: "Zoom level, 125%" })).toBeTruthy()

		for (let step = 0; step < 20; step++) {
			fireEvent.keyDown(document.body, { key: "-", code: "Minus", ctrlKey: true })
		}

		expect(within(row).getByRole<HTMLButtonElement>("button", { name: "Zoom out" }).disabled).toBe(true)
		// Nothing left to zoom, but still not the browser's page zoom.
		expect(fireEvent.keyDown(document.body, { key: "-", code: "Minus", ctrlKey: true })).toBe(false)
	})

	it("leaves the zoom keys alone in a dialog over the viewer and without the modifier", async () => {
		await mount()

		const scroller = document.querySelector<HTMLElement>(".fo-pdf-page")?.closest<HTMLElement>("[tabindex]") ?? document.body

		expect(fireEvent.keyDown(scroller, { key: "=", code: "Equal" })).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "File" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Document properties" }))

		const dialog = await screen.findByRole("dialog", { name: "Document properties" })

		expect(fireEvent.keyDown(dialog, { key: "=", code: "Equal", ctrlKey: true })).toBe(true)
		// The modal hides the command bar from the accessibility tree.
		expect(screen.getByRole("button", { name: "Zoom level, 100%", hidden: true })).toBeTruthy()
	})
})
