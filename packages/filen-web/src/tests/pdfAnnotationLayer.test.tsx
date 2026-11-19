// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { PdfEngineError } from "@filen/office/dom/pdfedit"
import { PageViewport, type PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { fakeToolContext } from "@/tests/support/pdfToolContext"
import type { AnnotationMode } from "@/features/pdf/annotations/annotationTools.logic"

// The annotation layer on one page, keyboard paths: a placed shape commits the shape it is, line and arrow included.
// Pointer paths do no work for a hover: no render in select mode, no text lines rebuilt in markup mode, no ancestor
// walk in hand mode. The store reads a failed page's annotations a bounded number of times.

vi.mock("react-i18next", async importOriginal => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const spies = vi.hoisted(() => ({ textLines: vi.fn(), readingOrder: vi.fn() }))

vi.mock("@/features/pdf/annotations/pageSpace.logic", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/pdf/annotations/pageSpace.logic")>()

	spies.textLines.mockImplementation(actual.textLines)

	return { ...actual, textLines: spies.textLines }
})

vi.mock("@/features/pdf/annotations/annotationTools.logic", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/pdf/annotations/annotationTools.logic")>()

	spies.readingOrder.mockImplementation(actual.readingOrder)

	return { ...actual, readingOrder: spies.readingOrder }
})

const { PdfAnnotationLayer } = await import("@/features/pdf/annotations/annotationLayer")
const { annotationStoreOf, PdfAnnotationStore } = await import("@/features/pdf/annotations/annotationStore")
const { PdfLiveRegion } = await import("@/features/pdf/tools/pdfLiveRegion")

// pdf.js's document as the layer reads it before the swap: page 1 unrotated, no annotations, no text.
function viewerDocument(annotations: unknown[] = [], text: unknown[] = []): PdfDomDocument {
	const page = {
		rotate: 0,
		getAnnotations: () => Promise.resolve(annotations),
		getTextContent: () => Promise.resolve({ items: text })
	}

	return { getPage: () => Promise.resolve(page) } as unknown as PdfDomDocument
}

function setup(mode: AnnotationMode, variant: string | null, annotations: unknown[] = [], text: unknown[] = []) {
	const commands: [string, unknown][] = []
	const warm = vi.fn()
	const swap = { warm } as never
	const session = {
		dispatch: (command: string, args: unknown) => {
			commands.push([command, args])

			return Promise.resolve({ state: { revision: 1 } })
		},
		getSnapshot: () => ({ state: { revision: 1 } })
	} as unknown as PdfEditSessionModel
	const context = fakeToolContext({
		swap,
		edit: change => {
			void change(session)
		}
	})
	const store = annotationStoreOf(swap)
	const view = render(
		<>
			<PdfLiveRegion owner={swap} />
			<PdfAnnotationLayer
				mode={mode}
				context={context}
				page={0}
				viewport={new PageViewport({ viewBox: [0, 0, 600, 800], scale: 1, rotation: 0 })}
				widgets={null}
				editing={false}
				document={viewerDocument(annotations, text)}
				variant={variant}
			/>
		</>
	)

	return { commands, store, context, view, warm }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe("annotation layer keyboard placement", () => {
	it.each([
		["Line", undefined],
		["Arrow", "OpenArrow"]
	])("commits a placed %s from the keyboard", async (variant, end) => {
		const { commands, store } = setup("shape", variant)

		await act(flush)

		act(() => {
			expect(store.key(0, { key: "Enter" })).toBe(true)
		})
		act(() => {
			store.key(0, { key: "ArrowRight", shift: true })
		})
		act(() => {
			store.key(0, { key: "Enter" })
		})

		await waitFor(() => {
			expect(commands).toHaveLength(1)
		})

		const [command, args] = commands[0] ?? []

		expect(command).toBe("annotations.line")
		expect(args).toMatchObject({ page: 0, from: [250, 360], to: [370, 440] })
		expect((args as { end?: string }).end).toBe(end)
	})

	it("names each page a placement target described by the hint, and says each step in the one live region", async () => {
		const { store, view } = setup("shape", "Square")

		await act(flush)

		const region = view.getByRole("status")
		const target = view.getByRole("application", { name: /previewPdfAnnotPlaceOnPage/ })

		// The region is there, empty, before anything is said; nothing else is a live region.
		expect(region.textContent).toBe("")
		expect(view.container.querySelectorAll("[aria-live]")).toHaveLength(1)
		expect(target.tabIndex).toBe(0)
		expect(document.getElementById(target.getAttribute("aria-describedby") ?? "")?.textContent).toBe("previewPdfAnnotPlacementHint")

		act(() => {
			store.key(0, { key: "Enter" })
		})
		await waitFor(() => {
			expect(region.textContent).toContain('"x":240,"y":360,"width":120,"height":80')
		})
		act(() => {
			store.key(0, { key: "ArrowDown" })
		})
		await waitFor(() => {
			expect(region.textContent).toContain('"x":240,"y":361')
		})
		expect(view.container.querySelectorAll("[aria-live]")).toHaveLength(1)
	})

	it("commits a rectangle placed from the keyboard", async () => {
		const { commands, store } = setup("shape", "Square")

		await act(flush)
		act(() => {
			store.key(0, { key: "Enter" })
		})
		act(() => {
			store.key(0, { key: "Enter" })
		})

		await waitFor(() => {
			expect(commands).toEqual([["annotations.shape", expect.objectContaining({ kind: "Square", rect: [240, 360, 360, 440] })]])
		})
	})
})

// pdf.js's annotation data as getAnnotations reports it (user space, y up; the page is 600 × 800).
const viewerAnnotation = (id: number, subtype: string, rect: number[], author: string, contents: string) => ({
	id: `${String(id)}R`,
	subtype,
	rect,
	titleObj: { str: author },
	contentsObj: { str: contents }
})

describe("existing annotations from the keyboard", () => {
	it("are focusable buttons named by kind, author and text, in reading order, selected with Enter", async () => {
		const { store, view } = setup("select", null, [
			viewerAnnotation(9, "Square", [300, 100, 400, 200], "", ""),
			viewerAnnotation(4, "Highlight", [50, 700, 200, 720], "Ada", "Check   this\nfigure"),
			viewerAnnotation(5, "Text", [400, 700, 420, 720], "Bob", "")
		])

		await waitFor(() => {
			expect(view.getAllByRole("button")).toHaveLength(3)
		})

		const buttons = view.getAllByRole("button")

		// Top of the page first, then left to right; the text flattened.
		expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual([
			'previewPdfAnnotLabelAuthorText {"kind":"previewPdfAnnotToolHighlight","author":"Ada","text":"Check this figure"}',
			'previewPdfAnnotLabelAuthor {"kind":"previewPdfAnnotToolNote","author":"Bob","text":""}',
			'previewPdfAnnotLabel {"kind":"previewPdfAnnotToolRectangle","author":"","text":""}'
		])
		expect(buttons.every(button => button.tabIndex === 0)).toBe(true)

		const [first] = buttons

		if (first === undefined) throw new Error("no annotation")

		first.focus()
		fireEvent.keyDown(first, { key: "Enter" })

		expect(store.getState().selected?.id).toBe(4)
		await waitFor(() => {
			expect(view.getAllByRole("button")[0]?.getAttribute("aria-pressed")).toBe("true")
		})
	})
})

function layerOf(view: ReturnType<typeof setup>["view"]): HTMLElement {
	const layer = view.container.querySelector<HTMLElement>("[data-pdf-annotation-layer]")

	if (layer === null) throw new Error("no layer")

	return layer
}

function hover(target: HTMLElement, count: number): void {
	for (let k = 0; k < count; k++) fireEvent.pointerMove(target, { clientX: 100 + k, clientY: 100 + k })
}

describe("annotation popover", () => {
	it("Comment opens the Comments panel and starts the editor that reads the threads", async () => {
		const { store, view, warm } = setup("select", null, [viewerAnnotation(4, "Square", [50, 600, 200, 720], "Ada", "")])

		await waitFor(() => {
			expect(view.getAllByRole("button")).toHaveLength(1)
		})

		const [box] = view.getAllByRole("button")

		if (box === undefined) throw new Error("no annotation")

		fireEvent.keyDown(box, { key: "Enter" })
		fireEvent.click(await view.findByRole("button", { name: "previewPdfAnnotComment" }))

		expect(store.getState().commentsOpen).toBe(true)
		expect(warm).toHaveBeenCalledTimes(1)
	})
})

describe("sticky note placement", () => {
	it("a click places a note: Comments opens with the note being written and the editor starts", async () => {
		const { store, view, warm } = setup("note", null)

		await act(flush)

		const layer = layerOf(view)

		Reflect.set(layer, "setPointerCapture", () => undefined)
		fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, button: 0 })
		fireEvent.pointerUp(layer, { clientX: 100, clientY: 100, button: 0 })

		expect(store.getState().commentsOpen).toBe(true)
		expect(store.getState().composing).toMatchObject({ kind: "note", page: 0 })
		expect(warm).toHaveBeenCalledTimes(1)
	})

	it("Enter places a note: Comments opens with the note being written and the editor starts", async () => {
		const { store, warm } = setup("note", null)

		await act(flush)
		act(() => {
			expect(store.key(0, { key: "Enter" })).toBe(true)
		})

		expect(store.getState().commentsOpen).toBe(true)
		expect(store.getState().composing).toMatchObject({ kind: "note", page: 0, at: [300, 400] })
		expect(warm).toHaveBeenCalledTimes(1)
	})
})

describe("annotation layer pointer moves", () => {
	it("a hover over an annotation in select mode does not render the layer again", async () => {
		const { view } = setup("select", null, [viewerAnnotation(4, "Square", [50, 600, 200, 720], "Ada", "")])

		await waitFor(() => {
			expect(view.getAllByRole("button")).toHaveLength(1)
		})
		spies.readingOrder.mockClear()
		hover(view.getAllByRole("button")[0] ?? layerOf(view), 20)

		expect(spies.readingOrder).not.toHaveBeenCalled()
	})

	it("a hover in markup mode rebuilds no text lines; a drag builds them once and still commits the markup", async () => {
		const text = [{ str: "Hello world", transform: [12, 0, 0, 12, 100, 700], width: 100 }]
		const { commands, store, view } = setup("markup", "Highlight", [], text)

		await act(flush)

		const layer = layerOf(view)

		Reflect.set(layer, "setPointerCapture", () => undefined)
		spies.textLines.mockClear()
		hover(layer, 20)
		expect(spies.textLines).not.toHaveBeenCalled()

		fireEvent.pointerDown(layer, { clientX: 105, clientY: 95, button: 0 })

		for (let x = 110; x <= 180; x += 10) fireEvent.pointerMove(layer, { clientX: x, clientY: 95 })

		// A render from the store between moves builds nothing either.
		act(() => {
			store.openAttachments(false)
		})
		fireEvent.pointerMove(layer, { clientX: 185, clientY: 95 })
		fireEvent.pointerUp(layer, { clientX: 190, clientY: 95 })

		expect(spies.textLines).toHaveBeenCalledTimes(1)

		await waitFor(() => {
			expect(commands).toEqual([
				["annotations.markup", expect.objectContaining({ page: 0, kind: "Highlight", from: [105, 95], to: [190, 95] })]
			])
		})
	})

	it("hand mode finds the scroller once on a press, never on a move", async () => {
		const { view } = setup("hand", null)

		await act(flush)

		const layer = layerOf(view)
		const computed = vi.spyOn(window, "getComputedStyle")

		Reflect.set(layer, "setPointerCapture", () => undefined)

		try {
			hover(layer, 20)
			expect(computed).not.toHaveBeenCalled()

			fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, button: 0 })

			const walked = computed.mock.calls.length

			expect(walked).toBeGreaterThan(0)
			hover(layer, 20)
			fireEvent.pointerUp(layer, { clientX: 120, clientY: 120 })
			expect(computed.mock.calls.length).toBe(walked)
		} finally {
			computed.mockRestore()
		}
	})
})

// An editor session whose engine answers `annotations` through `read` (one call per batch).
function engineSession(read: (pages: readonly number[]) => Promise<unknown>) {
	const calls: (readonly number[])[] = []
	const session = {
		engine: {
			call: (op: string, args: { readonly pages: readonly number[] }) => {
				if (op !== "annotations") return Promise.reject(new Error(op))

				calls.push(args.pages)

				return read(args.pages)
			}
		},
		subscribe: () => () => undefined,
		getSnapshot: () => ({ document: {}, touched: [] })
	} as unknown as PdfEditSessionModel

	return { calls, session }
}

const settle = async (): Promise<void> => {
	for (let k = 0; k < 5; k++) await flush()
}

describe("annotation store reads", () => {
	it("a page whose read keeps failing is read once in its batch and once alone, then not again", async () => {
		const store = new PdfAnnotationStore()
		const { calls, session } = engineSession(() => Promise.reject(new PdfEngineError("failed", "bad /Annots")))
		const renders = vi.fn()

		store.bind(session)
		store.subscribe(renders)

		const revision = store.getState().revision

		for (let round = 0; round < 10; round++) {
			expect(store.annotations(0)).toBeNull()
			expect(store.annotations(1)).toBeNull()
			await settle()
		}

		expect(calls).toEqual([[0, 1], [0], [1]])
		expect(store.getState().revision).toBe(revision)
		expect(renders).not.toHaveBeenCalled()
	})

	it("one bad page of a batch leaves the other pages their annotations", async () => {
		const store = new PdfAnnotationStore()
		const info = (page: number) => ({ page, id: page + 1, type: "Square", rect: [0, 0, 10, 10] })
		const { calls, session } = engineSession(pages =>
			pages.includes(1)
				? Promise.reject(new PdfEngineError("failed", "bad /Annots"))
				: Promise.resolve(pages.map(page => ({ page, annotations: [info(page)] })))
		)

		store.bind(session)

		const revision = store.getState().revision

		for (const page of [0, 1, 2]) store.annotations(page)
		await settle()

		expect(store.annotations(0)).toEqual([info(0)])
		expect(store.annotations(1)).toBeNull()
		expect(store.annotations(2)).toEqual([info(2)])
		expect(store.getState().revision).toBe(revision + 1)
		await settle()
		expect(calls).toEqual([[0, 1, 2], [0], [1], [2]])
	})

	it("a closed or poisoned engine is not asked again page by page", async () => {
		const store = new PdfAnnotationStore()
		const { calls, session } = engineSession(() => Promise.reject(new PdfEngineError("poisoned", "out of memory")))

		store.bind(session)
		store.annotations(0)
		store.annotations(1)
		await settle()
		store.annotations(0)
		await settle()

		expect(calls).toEqual([[0, 1]])
	})
})
