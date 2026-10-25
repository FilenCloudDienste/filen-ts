import { describe, expect, it, vi } from "vitest"
import {
	findInPage,
	pageMatchRange,
	pdfFindPattern,
	pdfPageText,
	PdfFinder,
	PDF_FIND_INTS,
	type PdfDocument,
	type PdfPage
} from "../dom/pdf/index"

function item(str: string, hasEOL = false): object {
	return { str, hasEOL, dir: "ltr", transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1, fontName: "F1" }
}

function find(items: readonly object[], query: string, caseSensitive = false): number[][] {
	const pattern = pdfFindPattern(query, caseSensitive)
	const out: number[] = []

	if (pattern !== null) findInPage(pdfPageText(items), 1, pattern, out, 100)

	const matches: number[][] = []

	for (let at = 0; at < out.length; at += PDF_FIND_INTS) matches.push(out.slice(at + 1, at + PDF_FIND_INTS))

	return matches
}

describe("pdfPageText", () => {
	it("joins the text items, a line end after an item that ends a line, skipping marked-content markers", () => {
		const text = pdfPageText([
			item("Hello "),
			item("world", true),
			{ type: "beginMarkedContent" },
			item("next"),
			{ type: "endMarkedContent" }
		])

		expect(text.text).toBe("Hello world\nnext")
		expect(Array.from(text.starts)).toEqual([0, 6, 12])
		expect(Array.from(text.lengths)).toEqual([6, 5, 4])
	})
})

describe("find in a page", () => {
	it("maps a match to the items and offsets it covers", () => {
		expect(find([item("The quick "), item("brown fox")], "quick brown")).toEqual([[0, 4, 1, 5]])
	})

	it("ignores case unless asked not to", () => {
		expect(find([item("Fox fox FOX")], "fox")).toHaveLength(3)
		expect(find([item("Fox fox FOX")], "fox", true)).toEqual([[0, 4, 0, 7]])
	})

	it("matches any run of whitespace, line ends included, with one space", () => {
		expect(find([item("end of", true), item("line")], "of line")).toEqual([[0, 4, 1, 4]])
		expect(find([item("a  \t b")], "a b")).toEqual([[0, 0, 0, 6]])
	})

	it("takes the query literally", () => {
		expect(find([item("cost (a+b)*2 $5.00")], "(a+b)*2")).toEqual([[0, 5, 0, 12]])
		expect(find([item("cost (a+b)*2 $5.00")], "$5.")).toEqual([[0, 13, 0, 16]])
		expect(find([item("aXb")], "a.b")).toEqual([])
	})

	it("matches text however it composes its accents", () => {
		expect(find([item("café noir")], "café")).toEqual([[0, 0, 0, 5]])
		expect(find([item("café")], "café")).toEqual([[0, 0, 0, 4]])
	})

	it("finds nothing for an empty or blank query", () => {
		expect(pdfFindPattern("", false)).toBeNull()
		expect(pdfFindPattern("  \n", false)).toBeNull()
	})

	it("starts a match that begins at a line end with the next item", () => {
		expect(find([item("one", true), item("two")], " two")).toEqual([[1, 0, 1, 3]])
	})

	it("stops at the limit", () => {
		const pattern = pdfFindPattern("a", false)
		const out: number[] = []

		expect(pattern).not.toBeNull()
		expect(findInPage(pdfPageText([item("aaaaa")]), 1, pattern as RegExp, out, 3)).toBe(true)
		expect(out.length / PDF_FIND_INTS).toBe(3)
	})
})

describe("pageMatchRange", () => {
	it("finds the matches of a page in the page-ordered list", () => {
		const matches = Int32Array.from([1, 0, 0, 0, 1, 3, 0, 0, 0, 1, 3, 0, 2, 0, 3, 7, 0, 0, 0, 1])

		expect(pageMatchRange(matches, 1)).toEqual([0, 1])
		expect(pageMatchRange(matches, 2)).toEqual([1, 1])
		expect(pageMatchRange(matches, 3)).toEqual([1, 3])
		expect(pageMatchRange(matches, 7)).toEqual([3, 4])
		expect(pageMatchRange(matches, 9)).toEqual([4, 4])
	})
})

function documentOf(pages: readonly (readonly object[] | Error)[]): { document: PdfDocument; reads: ReturnType<typeof vi.fn> } {
	const reads = vi.fn()
	const document: PdfDocument = {
		numPages: pages.length,
		getPage: pageNumber =>
			Promise.resolve({
				getTextContent: () => {
					reads(pageNumber)

					const content = pages[pageNumber - 1]

					return content instanceof Error || content === undefined
						? Promise.reject(content ?? new Error("no page"))
						: Promise.resolve({ items: content })
				}
			} as unknown as PdfPage),
		getDestination: () => Promise.resolve(null),
		getPageIndex: () => Promise.resolve(0),
		getOutline: () => Promise.resolve(null),
		getMetadata: () => Promise.resolve({ info: {} })
	}

	return { document, reads }
}

describe("PdfFinder", () => {
	it("finds across pages in page order and reads each page's text once over many queries", async () => {
		const { document, reads } = documentOf([[item("alpha beta")], [item("beta")], [item("gamma beta beta")]])
		const finder = new PdfFinder(document)
		const signal = { aborted: false }
		const first = await finder.search("beta", false, signal)
		const second = await finder.search("gamma", false, signal)

		expect(Array.from(first?.matches ?? [])).toEqual([1, 0, 6, 0, 10, 2, 0, 0, 0, 4, 3, 0, 6, 0, 10, 3, 0, 11, 0, 15])
		expect(first?.capped).toBe(false)
		expect(Array.from(second?.matches ?? [])).toEqual([3, 0, 0, 0, 5])
		expect(reads.mock.calls).toEqual([[1], [2], [3]])
	})

	it("reports the limit and that there are more", async () => {
		const { document } = documentOf([[item("x x x x x")]])
		const result = await new PdfFinder(document).search("x", false, { aborted: false }, 3)

		expect(result?.matches.length).toBe(3 * PDF_FIND_INTS)
		expect(result?.capped).toBe(true)
	})

	it("searches the other pages when one page's text cannot be read", async () => {
		const { document } = documentOf([new Error("broken"), [item("needle")]])
		const result = await new PdfFinder(document).search("needle", false, { aborted: false })

		expect(Array.from(result?.matches ?? [])).toEqual([2, 0, 0, 0, 6])
	})

	it("gives up when a newer query aborts it", async () => {
		const { document, reads } = documentOf([[item("a")], [item("a")], [item("a")]])
		const signal = { aborted: false }
		const searching = new PdfFinder(document).search("a", false, signal)

		signal.aborted = true

		await expect(searching).resolves.toBeNull()
		expect(reads.mock.calls.length).toBeLessThan(3)
	})

	it("gives the host a turn once a slice is used up", async () => {
		const { document } = documentOf(Array.from({ length: 6 }, () => [item("text")]))
		let now = 0
		const pause = vi.fn(() => Promise.resolve())
		const finder = new PdfFinder(document, {
			sliceMs: 8,
			now: () => (now += 5),
			pause
		})

		await finder.search("text", false, { aborted: false })

		expect(pause).toHaveBeenCalled()
	})
})
