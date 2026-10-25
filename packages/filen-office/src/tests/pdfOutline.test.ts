import { describe, expect, it, vi } from "vitest"
import {
	loadPdfInfo,
	loadPdfOutline,
	parsePdfDate,
	pdfDocumentInfo,
	pdfOutline,
	PDF_OUTLINE_LIMIT,
	PDF_OUTLINE_MAX_DEPTH,
	type PdfDocument
} from "../dom/pdf/index"

// The bookmarks menu and the properties dialog read the document once: its outline flattened for a menu (bounded,
// only what leads somewhere in the document), its Info dictionary reduced to text and dates.

function node(title: string, dest: unknown, items: unknown[] = []): Record<string, unknown> {
	return { title, dest, url: null, items }
}

describe("pdfOutline", () => {
	it("flattens the tree depth first, with each bookmark's depth", () => {
		const ref = { num: 4, gen: 0 }

		expect(pdfOutline([node("One", "first", [node("One.a", [ref, { name: "XYZ" }])]), node("Two", "second")])).toEqual([
			{ title: "One", depth: 0, dest: "first" },
			{ title: "One.a", depth: 1, dest: [ref, { name: "XYZ" }] },
			{ title: "Two", depth: 0, dest: "second" }
		])
	})

	it("keeps a heading without a destination only while it groups others, and drops links out of the document", () => {
		expect(
			pdfOutline([
				node("Part", null, [node("Chapter", "c")]),
				{ title: "Website", dest: null, url: "https://example.com", items: [] },
				node("Empty", null)
			])
		).toEqual([
			{ title: "Part", depth: 0, dest: null },
			{ title: "Chapter", depth: 1, dest: "c" }
		])
	})

	it("cleans titles and skips nodes that are not bookmarks", () => {
		expect(pdfOutline([null, 3, node("  A\u0000\tB\n ", "a"), node("   ", "b")])).toEqual([{ title: "A B", depth: 0, dest: "a" }])
		expect(pdfOutline(null)).toEqual([])
	})

	it("bounds the menu in length and depth", () => {
		const many = Array.from({ length: PDF_OUTLINE_LIMIT + 50 }, (_, index) => node(`B${String(index)}`, "d"))

		expect(pdfOutline(many)).toHaveLength(PDF_OUTLINE_LIMIT)

		let deep = node("leaf", "d")

		for (let level = 0; level < PDF_OUTLINE_MAX_DEPTH + 3; level++) deep = node(`L${String(level)}`, "d", [deep])

		const flat = pdfOutline([deep])

		expect(flat).toHaveLength(PDF_OUTLINE_MAX_DEPTH)
		expect(Math.max(...flat.map(item => item.depth))).toBe(PDF_OUTLINE_MAX_DEPTH - 1)
	})
})

describe("document info", () => {
	it("parses PDF dates with and without a time zone", () => {
		expect(parsePdfDate("D:20240131235958Z")?.toISOString()).toBe("2024-01-31T23:59:58.000Z")
		expect(parsePdfDate("D:20240131120000+02'00'")?.toISOString()).toBe("2024-01-31T10:00:00.000Z")
		expect(parsePdfDate("D:20240131120000-05'30")?.toISOString()).toBe("2024-01-31T17:30:00.000Z")
		expect(parsePdfDate("D:2024")?.toISOString()).toBe("2024-01-01T00:00:00.000Z")
		expect(parsePdfDate("20240615")?.toISOString()).toBe("2024-06-15T00:00:00.000Z")
	})

	it("refuses what is no date", () => {
		expect(parsePdfDate("yesterday")).toBeNull()
		expect(parsePdfDate("D:20241301")).toBeNull()
		expect(parsePdfDate(20240101)).toBeNull()
	})

	it("reads the Info dictionary's text and dates", () => {
		expect(
			pdfDocumentInfo({
				Title: " Report ",
				Author: "",
				Producer: "pdfTeX",
				CreationDate: "D:20200101000000Z",
				ModDate: "garbage",
				PDFFormatVersion: "1.7",
				Keywords: 5
			})
		).toEqual({
			title: "Report",
			author: null,
			subject: null,
			keywords: null,
			creator: null,
			producer: "pdfTeX",
			created: new Date("2020-01-01T00:00:00.000Z"),
			modified: null,
			version: "1.7"
		})
		expect(pdfDocumentInfo(null).title).toBeNull()
	})
})

describe("read once per document", () => {
	function fakeDocument(outline: Promise<readonly unknown[] | null>): PdfDocument {
		return {
			numPages: 1,
			getPage: () => Promise.reject(new Error("unused")),
			getDestination: () => Promise.resolve(null),
			getPageIndex: () => Promise.resolve(0),
			getOutline: vi.fn(() => outline),
			getMetadata: vi.fn(() => Promise.resolve({ info: { Title: "T" } }))
		}
	}

	it("asks the worker once, however often it is read", async () => {
		const document = fakeDocument(Promise.resolve([node("A", "a")]))

		expect(await loadPdfOutline(document)).toEqual([{ title: "A", depth: 0, dest: "a" }])
		await loadPdfOutline(document)
		expect((await loadPdfInfo(document)).title).toBe("T")
		await loadPdfInfo(document)
		expect(document.getOutline).toHaveBeenCalledTimes(1)
		expect(document.getMetadata).toHaveBeenCalledTimes(1)
	})

	it("reads a failed outline as none", async () => {
		expect(await loadPdfOutline(fakeDocument(Promise.reject(new Error("broken"))))).toEqual([])
	})
})
