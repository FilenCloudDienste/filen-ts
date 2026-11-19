import { describe, expect, it } from "vitest"
import type { DocxPageData } from "../core/docx/layout/pageData"
import type { DocxOpenInfo } from "../dom/docx/protocol"
import { DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH, pageAt, pageLeft, stackPages, type PagedDocument } from "../react/docx/viewport"

// The page stacking the viewer (DocxPages) and the editor (DocxEditor) share.

const GAP = 16

function page(width: number, height: number): DocxPageData {
	return { width, height } as DocxPageData
}

function paged(pages: readonly DocxPageData[], info?: { pageWidth: number; pageHeight: number }): PagedDocument {
	return { pages, info: info as DocxOpenInfo | undefined }
}

describe("stackPages", () => {
	it("stacks mixed page sizes with the gap between and around them", () => {
		const layout = stackPages(paged([page(816, 1056), page(1056, 816), page(500, 700)]), 3, 1, GAP, 0)

		expect(Array.from(layout.tops)).toEqual([16, 16 + 1056 + 16, 16 + 1056 + 16 + 816 + 16])
		expect(Array.from(layout.heights)).toEqual([1056, 816, 700])
		expect(Array.from(layout.widths)).toEqual([816, 1056, 500])
		expect(layout.total).toBe(16 + 1056 + 16 + 816 + 16 + 700 + 16)
		expect(layout.contentWidth).toBe(1056 + 2 * GAP)
	})

	it("scales the pages by the zoom, not the gap, and keeps the aside free", () => {
		const layout = stackPages(paged([page(800, 1000), page(600, 400)]), 2, 1.5, GAP, 200)

		expect(Array.from(layout.tops)).toEqual([16, 16 + 1500 + 16])
		expect(Array.from(layout.heights)).toEqual([1500, 600])
		expect(Array.from(layout.widths)).toEqual([1200, 900])
		expect(layout.total).toBe(16 + 1500 + 16 + 600 + 16)
		expect(layout.contentWidth).toBe(1200 + 2 * GAP + 200)
	})

	it("sizes pages not laid out yet like the last one that is", () => {
		const layout = stackPages(paged([page(816, 1056), page(600, 900)], { pageWidth: 1000, pageHeight: 2000 }), 4, 2, GAP, 0)

		expect(Array.from(layout.widths)).toEqual([1632, 1200, 1200, 1200])
		expect(Array.from(layout.heights)).toEqual([2112, 1800, 1800, 1800])
		expect(pageAt(layout, (layout.tops[3] ?? 0) + 1)).toBe(3)
	})

	it("sizes pages from the document before any is laid out, else Letter", () => {
		const fromInfo = stackPages(paged([], { pageWidth: 1000, pageHeight: 2000 }), 2, 1, GAP, 0)
		const letter = stackPages(paged([]), 2, 1, GAP, 0)

		expect(Array.from(fromInfo.widths)).toEqual([1000, 1000])
		expect(Array.from(fromInfo.heights)).toEqual([2000, 2000])
		expect(Array.from(letter.widths)).toEqual([DEFAULT_PAGE_WIDTH, DEFAULT_PAGE_WIDTH])
		expect(Array.from(letter.heights)).toEqual([DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_HEIGHT])
	})
})

describe("pageLeft", () => {
	const layout = stackPages(paged([page(816, 1056), page(500, 700)]), 2, 1, GAP, 100)

	it("centres each page in the view less the aside, rounded down", () => {
		expect(pageLeft(layout, 0, 2001, 100, GAP)).toBe(((2001 - 100 - 816) / 2) | 0)
		expect(pageLeft(layout, 1, 2001, 100, GAP)).toBe(((2001 - 100 - 500) / 2) | 0)
	})

	it("centres in the content's width when the view is narrower, never nearer the edge than the gap", () => {
		expect(pageLeft(layout, 0, 300, 100, GAP)).toBe(GAP)
		expect(pageLeft(layout, 1, 300, 100, GAP)).toBe(((816 + 2 * GAP + 100 - 100 - 500) / 2) | 0)
	})
})
