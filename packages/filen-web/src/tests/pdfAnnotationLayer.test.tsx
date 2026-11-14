// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { PageViewport, type PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { fakeToolContext } from "@/tests/support/pdfToolContext"

// The annotation layer on one page, keyboard paths: a placed shape commits the shape it is, line and arrow included.

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

const { PdfAnnotationLayer } = await import("@/features/pdf/annotations/annotationLayer")
const { annotationStoreOf } = await import("@/features/pdf/annotations/annotationStore")
const { PdfLiveRegion } = await import("@/features/pdf/tools/pdfLiveRegion")

// pdf.js's document as the layer reads it before the swap: page 1 unrotated, no annotations, no text.
function viewerDocument(annotations: unknown[] = []): PdfDomDocument {
	const page = {
		rotate: 0,
		getAnnotations: () => Promise.resolve(annotations),
		getTextContent: () => Promise.resolve({ items: [] })
	}

	return { getPage: () => Promise.resolve(page) } as unknown as PdfDomDocument
}

function setup(mode: "shape" | "select", variant: string | null, annotations: unknown[] = []) {
	const commands: [string, unknown][] = []
	const swap = {} as never
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
				document={viewerDocument(annotations)}
				variant={variant}
			/>
		</>
	)

	return { commands, store, context, view }
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
