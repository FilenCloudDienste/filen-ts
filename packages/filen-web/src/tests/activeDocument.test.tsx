// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import {
	clearActiveDocument,
	elementSelection,
	getActiveDocument,
	publishActiveDocument,
	subscribeActiveDocument,
	usePublishActiveDocument,
	type ActiveDocumentPublication,
	type DocumentReader
} from "@/lib/activeDocument"
import { PreviewDocumentContext, previewDocumentItem, usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { PreviewByteOriginProvider } from "@/features/preview/lib/accessMode"
import { mockFile, mockFileItem } from "@/tests/fixtures/sdk"

// The open-document store: one entry, replaced by whoever published last, cleared only by its own publisher, and
// announced only when what a subscriber sees changed. Viewers publish through a hook, a frame at most, and only for
// a drive overlay's own file.

function reader(text: string): DocumentReader {
	return {
		units: () => Promise.resolve(1),
		text: () => Promise.resolve({ text, units: [{ label: "text", start: 0 }], truncated: false })
	}
}

function publication(page: number, text = "x"): ActiveDocumentPublication {
	return { kind: "pdf", position: { page, pages: 9 }, selection: null, editable: false, reader: reader(text) }
}

const item = mockFileItem({ uuid: "aaaa-a-a-a" })
const other = mockFileItem({ uuid: "bbbb-b-b-b" })

// Runs the frames the hook waits for.
async function frames(): Promise<void> {
	await act(async () => {
		await new Promise(resolve =>
			requestAnimationFrame(() => {
				resolve(undefined)
			})
		)
	})
}

afterEach(() => {
	const held = getActiveDocument()

	if (held !== null) {
		clearActiveDocument(held.token)
	}
})

describe("the active document store", () => {
	it("tells subscribers only of a change they can see, and clears only its own entry", () => {
		const listener = vi.fn()
		const off = subscribeActiveDocument(listener)
		const mine = Symbol("mine")
		const theirs = Symbol("theirs")
		const shared = reader("a")

		publishActiveDocument({ ...publication(1), selection: null, reader: shared, item, token: mine })
		publishActiveDocument({ ...publication(1), selection: null, reader: shared, item, token: mine })
		expect(listener).toHaveBeenCalledTimes(1)

		publishActiveDocument({ ...publication(2), selection: null, reader: shared, item, token: mine })
		expect(listener).toHaveBeenCalledTimes(2)

		publishActiveDocument({ ...publication(2), selection: null, reader: shared, item: other, token: theirs })
		clearActiveDocument(mine)
		expect(getActiveDocument()?.token).toBe(theirs)

		clearActiveDocument(theirs)
		expect(getActiveDocument()).toBeNull()
		expect(listener).toHaveBeenCalledTimes(4)
		off()
	})
})

describe("usePublishActiveDocument", () => {
	it("publishes on the next frame, follows the position, and reads through the latest reader", async () => {
		const { rerender, unmount } = renderHook(
			({ page, text }) => {
				usePublishActiveDocument(item, publication(page, text))
			},
			{
				initialProps: { page: 1, text: "first" }
			}
		)

		expect(getActiveDocument()).toBeNull()
		await frames()
		expect(getActiveDocument()?.position).toEqual({ page: 1, pages: 9 })

		const entry = getActiveDocument()

		rerender({ page: 1, text: "second" })
		await frames()
		// Same position: the entry stays, its reader reads the latest render's engine.
		expect(getActiveDocument()).toBe(entry)
		expect((await entry?.reader.text({ from: 1, to: 1 }, new AbortController().signal, 100))?.text).toBe("second")

		rerender({ page: 4, text: "second" })
		await frames()
		expect(getActiveDocument()?.position.page).toBe(4)

		unmount()
		expect(getActiveDocument()).toBeNull()
		await expect(entry?.reader.units()).rejects.toThrow()
	})

	it("never lets an outgoing viewer clear the one that replaced it", async () => {
		const outgoing = renderHook(() => {
			usePublishActiveDocument(item, publication(1))
		})

		await frames()

		const incoming = renderHook(() => {
			usePublishActiveDocument(other, publication(1))
		})

		await frames()
		outgoing.unmount()
		expect(getActiveDocument()?.item).toBe(other)
		incoming.unmount()
		expect(getActiveDocument()).toBeNull()
	})

	it("clears its entry when it has nothing to read any more", async () => {
		const { rerender } = renderHook(
			({ ready }) => {
				usePublishActiveDocument(item, ready ? publication(1) : null)
			},
			{
				initialProps: { ready: true }
			}
		)

		await frames()
		expect(getActiveDocument()).not.toBeNull()
		rerender({ ready: false })
		expect(getActiveDocument()).toBeNull()
	})
})

describe("a publication's selection", () => {
	function selectionOf(state: { chars: number; text: string }) {
		return {
			selectedChars: vi.fn(() => state.chars),
			selectedText: vi.fn(() => state.text)
		}
	}

	it("is measured a frame after a change, the entry replaced only when its size differs, its text read when asked", async () => {
		const state = { chars: 0, text: "" }
		const selection = selectionOf(state)
		const { result } = renderHook(() => usePublishActiveDocument(item, { ...publication(1), selection }))

		await frames()
		expect(getActiveDocument()?.selection).toBeNull()

		const listener = vi.fn()
		const off = subscribeActiveDocument(listener)

		state.chars = 12
		state.text = "hello world!"
		selection.selectedChars.mockClear()
		// Several changes in a frame: one measure.
		result.current()
		result.current()
		document.dispatchEvent(new Event("selectionchange"))
		await frames()
		expect(selection.selectedChars).toHaveBeenCalledTimes(1)
		expect(getActiveDocument()?.selection).toEqual({ chars: 12 })
		expect(listener).toHaveBeenCalledTimes(1)

		// The caret moved, nothing else: measured, not republished.
		result.current()
		await frames()
		expect(listener).toHaveBeenCalledTimes(1)
		expect(await getActiveDocument()?.reader.text("selection", new AbortController().signal, 5)).toEqual({
			text: "hello",
			units: [{ label: "selection", start: 0 }],
			truncated: true
		})

		// The page's own selection events are heard too.
		state.chars = 0
		state.text = ""
		document.dispatchEvent(new Event("selectionchange"))
		await frames()
		expect(getActiveDocument()?.selection).toBeNull()
		expect(listener).toHaveBeenCalledTimes(2)
		expect(await getActiveDocument()?.reader.text("selection", new AbortController().signal, 5)).toEqual({
			text: "",
			units: [],
			truncated: false
		})
		off()
	})

	it("lets the latest of overlapping measures win, aborting the one before", async () => {
		const pending: { resolve: (chars: number) => void; signal: AbortSignal }[] = []
		const selection = {
			selectedChars: (signal: AbortSignal) =>
				new Promise<number>(resolve => {
					pending.push({ resolve, signal })
				}),
			selectedText: () => ""
		}
		const { result } = renderHook(() => usePublishActiveDocument(item, { ...publication(1), selection }))

		await frames()
		result.current()
		await frames()
		expect(pending).toHaveLength(2)
		expect(pending[0]?.signal.aborted).toBe(true)
		await act(async () => {
			pending[1]?.resolve(5)
			pending[0]?.resolve(9)
			await Promise.resolve()
		})
		expect(getActiveDocument()?.selection).toEqual({ chars: 5 })
	})

	it("is published with a viewer whose selection came before it (the size measured first)", async () => {
		const selection = selectionOf({ chars: 3, text: "abc" })

		renderHook(() => usePublishActiveDocument(item, { ...publication(1), selection }))
		await frames()
		await frames()
		expect(getActiveDocument()?.selection).toEqual({ chars: 3 })
	})
})

describe("a DOM element's selection", () => {
	function paragraph(text: string): HTMLParagraphElement {
		const element = document.createElement("p")

		element.textContent = text
		document.body.append(element)

		return element
	}

	it("is kept while the selection moves out of the element, and dropped on a click inside it", () => {
		const inside = paragraph("selected text here")
		const outside = paragraph("elsewhere")
		const { reader, attach } = elementSelection()
		const selection = document.getSelection()
		const text = inside.firstChild

		if (selection === null || text === null) {
			throw new Error("no selection")
		}

		attach(inside)
		selection.setBaseAndExtent(text, 0, text, 8)
		expect(reader.selectedChars(new AbortController().signal)).toBe(8)
		expect(reader.selectedText(100, new AbortController().signal)).toBe("selected")

		selection.collapse(outside, 0)
		expect(reader.selectedChars(new AbortController().signal)).toBe(8)

		selection.collapse(text, 3)
		expect(reader.selectedChars(new AbortController().signal)).toBe(0)

		selection.setBaseAndExtent(text, 0, text, 4)
		attach(null)
		expect(reader.selectedChars(new AbortController().signal)).toBe(0)
		inside.remove()
		outside.remove()
	})
})

describe("the preview's publishing scope", () => {
	function scoped(value: ReturnType<typeof previewDocumentItem>, origin?: ByteOrigin) {
		return ({ children }: { children: ReactNode }) => (
			<PreviewDocumentContext value={value}>
				{origin === undefined ? children : <PreviewByteOriginProvider origin={origin}>{children}</PreviewByteOriginProvider>}
			</PreviewDocumentContext>
		)
	}

	it("offers every signed-in preview's file: the drive, Recents, Favorites and both shared screens", () => {
		for (const variant of ["drive", "recents", "favorites", "links", "sharedIn", "sharedOut"] as const) {
			expect(previewDocumentItem(item, variant), variant).toBe(item)
		}
	})

	it("publishes a drive overlay's file", async () => {
		renderHook(
			() => {
				usePublishPreviewDocument(publication(1))
			},
			{ wrapper: scoped(previewDocumentItem(item, "drive")) }
		)
		await frames()
		expect(getActiveDocument()?.item).toBe(item)
	})

	it("publishes nothing for a chat's linked file, in the trash, outside any overlay, or for an archive's entry", async () => {
		const embedded = mockFileItem({ uuid: "dddd-d-d-d", parent: "dddd-d-d-d" })

		expect(previewDocumentItem(embedded, "links")).toBeNull()
		expect(previewDocumentItem(item, "trash")).toBeNull()
		renderHook(
			() => {
				usePublishPreviewDocument(publication(1))
			},
			{ wrapper: scoped(previewDocumentItem(embedded, "links")) }
		)
		renderHook(() => {
			usePublishPreviewDocument(publication(1))
		})
		renderHook(
			() => {
				usePublishPreviewDocument(publication(1))
			},
			{
				wrapper: scoped(item, { kind: "file", file: mockFile({ uuid: "eeee-e-e-e" }) })
			}
		)
		await frames()
		expect(getActiveDocument()).toBeNull()
	})
})
