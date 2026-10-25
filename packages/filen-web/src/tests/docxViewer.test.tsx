// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react"
import type { ReactElement } from "react"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import type { ByteSource } from "@filen/office/core/opc"
import type {
	DocxAnnotations,
	DocxEvent,
	DocxListener,
	DocxOpenOptions,
	DocxPageData,
	DocxSessionApi,
	DrawingData
} from "@filen/office/dom/docx"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import type { DriveItem } from "@/features/drive/lib/item"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// Links open through the trusted-domain query (useTrustedLinkGate).
function render(ui: ReactElement) {
	return renderUi(ui, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

// The new viewer: the engine reads ranges of the cached buffer (never a copy of the whole file), docx-preview
// takes over only when the engine fails, and image object URLs live exactly as long as the document.

const { renderAsync, warn, host, prewarm, kvStore } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	prewarm: vi.fn(),
	renderAsync: vi.fn<(bytes: Uint8Array, container: HTMLElement) => Promise<void>>(() => Promise.resolve()),
	warn: vi.fn(),
	host: {
		listener: null as DocxListener | null,
		source: null as ByteSource | null,
		session: null as DocxSessionApi | null,
		options: [] as (DocxOpenOptions | undefined)[],
		closed: 0
	}
}))

const BYTES = new Uint8Array([80, 75, 3, 4, 9, 9, 9, 9])

vi.mock("docx-preview", () => ({ renderAsync }))
// The trusted link domains (useTrustedLinkGate), in memory.
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))
vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: BYTES, refetch: () => undefined })
}))
vi.mock("@/features/preview/lib/docxEngine", () => ({
	prewarmDocxWorker: prewarm,
	DOCX_FONT_URLS: {},
	docxHost: (source: ByteSource, listener: DocxListener, options?: DocxOpenOptions) => {
		host.source = source
		host.listener = listener
		host.options.push(options)

		const session = host.session ?? {
			objects: () => Promise.resolve([]),
			media: () => Promise.resolve(null),
			locate: () => Promise.resolve(null),
			find: () => Promise.resolve(new Int32Array(0)),
			close: () => undefined
		}

		return {
			...session,
			close: () => {
				host.closed++
				session.close()
			}
		}
	}
}))

const { DocxViewer } = await import("@/features/preview/components/docxViewer")

registerAllActions()

const item = linkedFileItem("doc.docx", {
	uuid: "aaaaaaaa-0000-0000-0000-000000000002",
	mime: { Decrypted: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
	size: 8n
})

function emit(event: DocxEvent): Promise<void> {
	return act(async () => {
		host.listener?.(event)
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

function page(objects = 0): DocxPageData {
	return {
		index: 0,
		number: 1,
		numberText: "1",
		section: 0,
		width: 816,
		height: 1056,
		lineCount: 1,
		fragmentCount: 1,
		decorationCount: 0,
		lineFloats: Float32Array.from([96, 20, 112, 96, 40]),
		lineInts: Int32Array.from([0, 1, 0, 5, 1, 0, 0]),
		fragmentFloats: Float32Array.from([96, 40, 0, 0]),
		fragmentInts: Int32Array.from([0, 5, 0, 0, 0]),
		decorationFloats: new Float32Array(0),
		decorationInts: new Int32Array(0),
		graphicCount: 0,
		graphicFloats: new Float32Array(0),
		graphicInts: new Int32Array(0),
		objectCount: objects,
		objectFloats: Float32Array.from(objects > 0 ? [96, 200, 100, 50] : []),
		objectInts: Int32Array.from(objects > 0 ? [7, 1, 0] : []),
		objectKinds: Uint8Array.from(objects > 0 ? [1] : []),
		sourceCount: 1,
		sourceInts: Int32Array.from([0, 0, 1, 0]),
		sourceTexts: ["Hello"],
		linkCount: 0,
		linkInts: new Int32Array(0)
	}
}

const STYLE = {
	font: '400 16px "fo1-carlito", sans-serif',
	smallCapsFont: '400 11px "fo1-carlito", sans-serif',
	color: "",
	kerning: true,
	letterSpacing: 0,
	scaleX: 1,
	shift: 0,
	ascent: 12,
	descent: 4,
	revision: 0
}

function pages(objects = 0): DocxEvent {
	return { type: "pages", pages: [page(objects)], styles: [STYLE], decorations: [], links: [], final: true, pageCount: 1 }
}

// The same file in the user's own drive (a linked file is its own parent).
const ownItem: DriveItem = item.type === "file" ? { ...item, data: { ...item.data, parent: "bbbbbbbb-0000-0000-0000-000000000001" } } : item

function opened(info: { gate?: ("protected" | "signed")[]; comments?: number; revisions?: number }): DocxEvent {
	return {
		type: "opened",
		info: {
			variant: "docx",
			gate: info.gate ?? [],
			estimatedPages: 1,
			pageWidth: 816,
			pageHeight: 1056,
			mainPartBytes: 100,
			...(info.comments === undefined ? {} : { comments: info.comments }),
			...(info.revisions === undefined ? {} : { revisions: info.revisions })
		}
	}
}

function emptySession(): DocxSessionApi {
	return {
		objects: () => Promise.resolve([]),
		media: () => Promise.resolve(null),
		locate: () => Promise.resolve(null),
		find: () => Promise.resolve(new Int32Array(0)),
		close: () => undefined
	}
}

// One comment by Alice on "Hello".
const ANNOTATIONS: DocxAnnotations = {
	authors: ["Alice"],
	comments: [
		{
			id: "1",
			author: 0,
			initials: "A",
			date: "2024-01-01T00:00:00Z",
			paragraphs: [[{ text: "Looks good", bold: false, italic: false, underline: false, strike: false }]],
			parent: -1,
			done: false,
			firstRect: 0,
			rectCount: 1
		}
	],
	revisions: [],
	rectPages: Int32Array.from([0]),
	rectFloats: Float32Array.from([96, 96, 40, 20])
}

// One image item filling the drawing.
const DRAWING: DrawingData = {
	width: 100,
	height: 50,
	commands: new Uint8Array(0),
	coords: new Float32Array(0),
	itemCount: 1,
	itemFloats: Float32Array.from([1, 0, 0, 1, 0, 0, 0, 0, 100, 50]),
	itemInts: Int32Array.from([1, 0, 0, 0, -1, -1, 0, -1, 0, 0]),
	paints: [],
	strokes: [],
	images: [
		{
			partName: "word/media/image1.png",
			format: "png",
			handling: "native",
			svgPartName: undefined,
			crop: { left: 0, top: 0, right: 0, bottom: 0 },
			alpha: 1,
			grayscale: false,
			biLevel: -1,
			duotone: null,
			brightness: 0,
			contrast: 0,
			colorChange: null
		}
	],
	texts: [],
	shadows: []
}

beforeEach(() => {
	host.listener = null
	host.source = null
	host.session = null
	host.options = []
	host.closed = 0
})

afterEach(() => {
	kvStore.clear()
	vi.restoreAllMocks()
	renderAsync.mockClear()
	warn.mockClear()
	prewarm.mockClear()
})

describe("DocxViewer", () => {
	it("reads ranges of the cached buffer without copying it", async () => {
		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		expect(host.source?.size).toBe(BYTES.length)

		const range = await host.source?.read(2, 4)

		// A view into the same buffer: the engine host copies only the range it sends to the worker.
		expect(range?.buffer).toBe(BYTES.buffer)
		expect(Array.from(range ?? [])).toEqual([3, 4, 9, 9])

		await emit(pages())

		await waitFor(() => {
			expect(view.container.querySelector(".fo-docx-run")?.textContent).toBe("Hello")
		})
		expect(renderAsync).not.toHaveBeenCalled()

		view.unmount()
		await waitFor(() => {
			expect(host.closed).toBe(1)
		})
	})

	it("falls back to docx-preview with the same buffer when the engine fails, and logs it", async () => {
		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await emit({ type: "error", reason: "failed", message: "boom" })

		await waitFor(() => {
			expect(renderAsync).toHaveBeenCalledTimes(1)
		})
		expect(renderAsync.mock.calls[0]?.[0]).toBe(BYTES)
		expect(warn).toHaveBeenCalledWith("docx", expect.stringContaining("docx-preview instead"), "failed: boom (main part unknown bytes)")
		view.unmount()
	})

	it("shows the error instead of docx-preview when the document is too large for it", async () => {
		render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await emit({ type: "error", reason: "failed", message: "out of memory", mainPartBytes: 64 * 1024 * 1024 })

		expect(await screen.findByText("This document couldn't be rendered.")).toBeTruthy()
		expect(renderAsync).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledWith("docx", expect.stringContaining("too large"), expect.any(String))
	})

	it("does not start a spare worker for a buffer that is already loaded", () => {
		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		expect(prewarm).not.toHaveBeenCalled()
		view.unmount()
	})

	it("explains a file it cannot open instead of falling back", async () => {
		render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await emit({ type: "error", reason: "rightsManaged", message: "EncryptedPackage" })

		expect(
			await screen.findByText("This document is protected with rights management (IRM) and can't be opened in Filen.")
		).toBeTruthy()
		expect(renderAsync).not.toHaveBeenCalled()
	})

	it("revokes the images' object URLs when the viewer closes", async () => {
		let next = 0
		const created: string[] = []
		const createObjectURL = vi.fn(() => {
			const url = `blob:test/${String(next++)}`

			created.push(url)

			return url
		})
		const revokeObjectURL = vi.fn<(url: string) => void>()

		URL.createObjectURL = createObjectURL
		URL.revokeObjectURL = revokeObjectURL
		host.session = {
			objects: ids => Promise.resolve(ids.map(id => ({ kind: "drawing" as const, id, drawing: DRAWING }))),
			media: () => Promise.resolve({ bytes: new Uint8Array([137, 80, 78, 71]), type: "image/png" }),
			locate: () => Promise.resolve(null),
			find: () => Promise.resolve(new Int32Array(0)),
			close: () => undefined
		}

		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await emit(pages(1))

		await waitFor(() => {
			expect(view.container.querySelector(".fo-docx-object image")?.getAttribute("href")).toBe("blob:test/0")
		})
		expect(revokeObjectURL).not.toHaveBeenCalled()

		view.unmount()

		await waitFor(() => {
			expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(created)
		})
	})

	it("explains why a document is view-only, from the file and from where it was opened", async () => {
		render(
			<DocxViewer
				item={ownItem}
				alt="doc.docx"
				variant="trash"
			/>
		)

		await emit(opened({ gate: ["protected"] }))
		fireEvent.click(await screen.findByRole("button", { name: "View only" }))

		expect(await screen.findByText("This document can only be viewed")).toBeTruthy()
		expect(screen.getByText("It's in the trash.")).toBeTruthy()
		expect(screen.getByText("It's protected against editing in Word.")).toBeTruthy()
	})

	it("says a file reached through someone's link is theirs", async () => {
		render(
			<DocxViewer
				item={item}
				alt="doc.docx"
				variant="links"
			/>
		)

		await emit(opened({}))
		fireEvent.click(await screen.findByRole("button", { name: "View only" }))

		expect(await screen.findByText("It's someone else's file, opened through their link.")).toBeTruthy()
		expect(screen.queryByText("Open it from its directory in your drive to edit it.")).toBeNull()
	})

	it("shows no view-only badge for an editable place and file", async () => {
		render(
			<DocxViewer
				item={ownItem}
				alt="doc.docx"
				variant="drive"
			/>
		)

		await emit(opened({}))
		await emit(pages())

		expect(screen.queryByRole("button", { name: "View only" })).toBeNull()
	})

	it("finds in the toolbar on Mod+F, steps with Enter and closes on Escape without closing the preview", async () => {
		const find = vi.fn(() => Promise.resolve(Int32Array.from([0, 0, 0, 4, 0, 0, 1, 3])))

		// jsdom has neither the Highlight API nor range boxes: matches are drawn as (here empty) boxes.
		Range.prototype.getClientRects = () => [] as unknown as DOMRectList

		host.session = { ...emptySession(), find }

		render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await emit(opened({}))
		await emit(pages())

		fireEvent.keyDown(document.body, { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })

		const field = await screen.findByRole("searchbox", { name: "Find" })

		fireEvent.change(field, { target: { value: "hel" } })
		fireEvent.keyDown(field, { key: "Enter" })

		await waitFor(() => {
			expect(find).toHaveBeenCalledWith("hel", { caseSensitive: false })
		})
		expect(await screen.findByText("1/2")).toBeTruthy()

		fireEvent.keyDown(field, { key: "Enter" })
		expect(await screen.findByText("2/2")).toBeTruthy()

		const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })

		act(() => {
			field.dispatchEvent(escape)
		})

		expect(escape.defaultPrevented).toBe(true)
		expect(screen.queryByRole("searchbox")).toBeNull()
	})

	it("fits the page to the width again from the zoom menu", async () => {
		render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await emit(opened({}))
		await emit(pages())

		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
		fireEvent.click(screen.getByRole("button", { name: "Zoom level, 110%" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Fit to width" }))
		expect(await screen.findByRole("button", { name: "Zoom level, 100%" })).toBeTruthy()
	})

	it("offers the markup modes for a reviewed document, lays out the chosen view and marks its comments", async () => {
		host.session = { ...emptySession(), annotations: () => Promise.resolve(ANNOTATIONS) }

		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		expect(host.options[0]?.view).toBe("final")

		await emit(opened({ comments: 1, revisions: 0 }))
		await emit(pages())

		// Too narrow for balloons (jsdom lays nothing out): a marker at the page's edge.
		expect(await screen.findByRole("button", { name: "Comment by Alice" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Markup: Simple markup" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "All markup" }))

		await waitFor(() => {
			expect(host.options.at(-1)?.view).toBe("markup")
		})
		view.unmount()
	})

	describe("links", () => {
		// "Hello" as one external link.
		function linked(href: string): DocxEvent {
			return {
				...pages(),
				pages: [{ ...page(), linkCount: 1, linkInts: Int32Array.from([0, 0, 5, 0]) }],
				links: [{ kind: "external", href, tooltip: undefined }]
			} as DocxEvent
		}

		async function show(href: string) {
			const open = vi.spyOn(window, "open").mockReturnValue(null)
			const view = render(
				<DocxViewer
					item={item}
					alt="doc.docx"
				/>
			)

			await emit(opened({}))
			await emit(linked(href))

			const link = await screen.findByRole("link", { name: "Hello" })

			return { open, view, link }
		}

		it("asks before opening a web link to a domain not trusted yet, then trusts it", async () => {
			const { open, view, link } = await show("https://example.com/a")

			fireEvent.click(link)

			const dialog = await screen.findByRole("alertdialog", { name: "Open external link?" })

			expect(dialog.textContent).toContain("example.com")
			expect(open).not.toHaveBeenCalled()

			fireEvent.click(screen.getByRole("button", { name: "Open link" }))

			expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer")
			await waitFor(() => {
				expect(kvStore.get("chats.trustedLinkDomains.v1")).toEqual(["example.com"])
			})
			view.unmount()
		})

		it("opens a link to a trusted domain at once, and a mailto: link (the mail client asks)", async () => {
			kvStore.set("chats.trustedLinkDomains.v1", ["example.com"])

			const { open, view, link } = await show("https://example.com/b")

			// The trusted set is read once the query settles.
			await waitFor(() => {
				fireEvent.click(link)
				expect(open).toHaveBeenCalledWith("https://example.com/b", "_blank", "noopener,noreferrer")
			})
			expect(screen.queryByRole("alertdialog")).toBeNull()
			view.unmount()

			const mail = await show("mailto:someone@example.org")

			fireEvent.click(mail.link)
			expect(mail.open).toHaveBeenCalledWith("mailto:someone@example.org", "_blank", "noopener,noreferrer")
			expect(screen.queryByRole("alertdialog")).toBeNull()
			mail.view.unmount()
		})

		it("never opens or asks about javascript: and data: links", async () => {
			for (const href of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
				const { open, view, link } = await show(href)

				fireEvent.click(link)
				expect(open).not.toHaveBeenCalled()
				expect(screen.queryByRole("alertdialog")).toBeNull()
				view.unmount()
			}
		})
	})
})
