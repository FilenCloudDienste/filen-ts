import { describe, expect, it, vi } from "vitest"
import * as mupdf from "mupdf"
import { PDF_STORE_SHRINK_INTERVAL_MS, PDF_STORE_SHRINK_HEAP_BYTES, TileRenderer, wasmHeapBytes } from "../../dom/pdfedit/render"
import type { MupdfModule } from "../../dom/pdfedit/protocol"
import { makePdf } from "./fixtures"

// The tile renderer's caches, with the real MuPDF on this thread.

function open(pages: number): mupdf.PDFDocument {
	const document = mupdf.Document.openDocument(makePdf({ pages }), "application/pdf")

	if (!(document instanceof mupdf.PDFDocument)) throw new Error("not a PDF")

	return document
}

function counted(document: mupdf.PDFDocument): { readonly loads: () => number } {
	const load = document.loadPage.bind(document)
	let loads = 0

	document.loadPage = (index: number) => {
		loads++

		return load(index)
	}

	return { loads: () => loads }
}

const TILE = [0, 0, 60, 84] as const

describe("TileRenderer", () => {
	it("draws thumbnails without evicting or reordering the lists of the pages in view", () => {
		const document = open(24)
		const loads = counted(document)
		const renderer = new TileRenderer(mupdf, document, 4)

		for (let page = 0; page < 4; page++) renderer.render(page, 0.1, 0, TILE)

		expect(loads.loads()).toBe(4)

		for (let page = 4; page < 24; page++) renderer.render(page, 0.1, 0, TILE, undefined, true)

		// A held list serves a thumbnail of a page in view, without loading the page again.
		renderer.render(2, 0.1, 0, TILE, undefined, true)

		expect(loads.loads()).toBe(24)

		for (let page = 0; page < 4; page++) renderer.render(page, 0.1, 0, TILE)

		expect(loads.loads()).toBe(24)

		renderer.destroy()
		document.destroy()
	})

	it("draws a thumbnail like the page's tile", () => {
		const document = open(1)
		const renderer = new TileRenderer(mupdf, document, 4)
		const once = renderer.render(0, 0.1, 0, TILE, undefined, true)
		const listed = renderer.render(0, 0.1, 0, TILE)

		expect(once.width).toBe(listed.width)
		expect(Buffer.from(once.rgba).equals(Buffer.from(listed.rgba))).toBe(true)

		renderer.destroy()
		document.destroy()
	})

	it("leaves the resource store alone while the heap has not grown past it", () => {
		const document = open(12)
		const shrinkStore = vi.fn(() => true)
		const small: MupdfModule = { ...mupdf, shrinkStore }
		let now = 0
		const renderer = new TileRenderer(small, document, 2, () => now)

		for (let page = 0; page < 12; page++) {
			renderer.render(page, 0.1, 0, TILE)
			renderer.evict([page])
			now += PDF_STORE_SHRINK_INTERVAL_MS
		}

		// A fresh instance's heap is far below the store's level: clearing it would only cost decoding again.
		expect(wasmHeapBytes(mupdf)).toBeLessThan(PDF_STORE_SHRINK_HEAP_BYTES)
		expect(shrinkStore).not.toHaveBeenCalled()

		renderer.destroy()
		document.destroy()
	})

	it("shrinks the store at most once an interval on a grown heap, within the evicting call", () => {
		const document = open(12)
		const shrinkStore = vi.fn(() => true)
		// Grows the heap past the store's level (wasm memory never shrinks, so later tests see it grown too).
		const grown = new mupdf.Buffer(new Uint8Array(PDF_STORE_SHRINK_HEAP_BYTES))
		let now = 0
		const renderer = new TileRenderer({ ...mupdf, shrinkStore }, document, 2, () => now)

		for (let page = 0; page < 8; page++) {
			renderer.render(page, 0.1, 0, TILE)
			renderer.evict([page])
			now += PDF_STORE_SHRINK_INTERVAL_MS / 4
		}

		// Eight evictions over two intervals: two shrinks, each in the eviction itself (no timer runs between requests).
		expect(shrinkStore).toHaveBeenCalledTimes(2)
		expect(shrinkStore).toHaveBeenCalledWith(50)

		grown.destroy()
		renderer.destroy()
		document.destroy()
	})
})
