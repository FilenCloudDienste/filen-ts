// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import {
	clearActiveDocument,
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

		publishActiveDocument({ ...publication(1), reader: shared, item, token: mine })
		publishActiveDocument({ ...publication(1), reader: shared, item, token: mine })
		expect(listener).toHaveBeenCalledTimes(1)

		publishActiveDocument({ ...publication(2), reader: shared, item, token: mine })
		expect(listener).toHaveBeenCalledTimes(2)

		publishActiveDocument({ ...publication(2), reader: shared, item: other, token: theirs })
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

describe("the preview's publishing scope", () => {
	function scoped(value: ReturnType<typeof previewDocumentItem>, origin?: ByteOrigin) {
		return ({ children }: { children: ReactNode }) => (
			<PreviewDocumentContext value={value}>
				{origin === undefined ? children : <PreviewByteOriginProvider origin={origin}>{children}</PreviewByteOriginProvider>}
			</PreviewDocumentContext>
		)
	}

	it("offers every signed-in preview's file: the drive, Recents, Favorites and both shared screens", () => {
		for (const variant of ["drive", "recents", "favorites", "sharedIn", "sharedOut"] as const) {
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

	it("publishes nothing for a chat's linked file, outside any overlay, or for an archive's entry", async () => {
		expect(previewDocumentItem(item, "links")).toBeNull()
		expect(previewDocumentItem(item, "trash")).toBeNull()
		renderHook(
			() => {
				usePublishPreviewDocument(publication(1))
			},
			{ wrapper: scoped(previewDocumentItem(item, "links")) }
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
