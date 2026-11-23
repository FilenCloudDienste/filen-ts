import { describe, expect, it } from "vitest"
import {
	documentChunks,
	documentCoveredText,
	documentRangeText,
	documentReadRange,
	documentUnits,
	documentUnitsText,
	estimateTokens,
	nothingSelected,
	openDocumentContext,
	splitDocumentText
} from "@filen/shared/assistant"

describe("documentReadRange", () => {
	it("reads every unit for all, nothing asked, or a document without units", () => {
		expect(documentReadRange({}, 41)).toEqual({ from: 1, to: 41 })
		expect(documentReadRange({ part: "all", from: 3, to: 4 }, 41)).toEqual({ from: 1, to: 41 })
		expect(documentReadRange({ part: "pages" }, 0)).toEqual({ from: 1, to: 1 })
	})

	it("clamps a range to the document, to defaulting to from", () => {
		expect(documentReadRange({ part: "pages", from: 3, to: 7 }, 41)).toEqual({ from: 3, to: 7 })
		expect(documentReadRange({ from: 30 }, 41)).toEqual({ from: 30, to: 30 })
		expect(documentReadRange({ to: 2 }, 41)).toEqual({ from: 1, to: 2 })
		expect(documentReadRange({ from: 50, to: 60 }, 41)).toEqual({ from: 41, to: 41 })
		expect(documentReadRange({ from: 5, to: 2 }, 41)).toEqual({ from: 5, to: 5 })
		expect(documentReadRange({ from: 0, to: 2.7 }, 41)).toEqual({ from: 1, to: 2 })
	})

	it("is null for the selection", () => {
		expect(documentReadRange({ part: "selection", from: 2 }, 41)).toBeNull()
	})
})

describe("document text", () => {
	it("words a range by the document's unit", () => {
		expect(documentRangeText("pdf", 3, 7, 41)).toBe("pages 3–7 of 41")
		expect(documentRangeText("docx", 3, 3, 41)).toBe("page 3 of 41")
		expect(documentRangeText("slides", 1, 6, 6)).toBe("slides 1–6 of 6")
		expect(documentRangeText("sheet", 2, 2, 2)).toBe("sheet 2 of 2")
		expect(documentRangeText("text", 1, 1, 1)).toBe("all")
	})

	it("splits a reader's text into numbered units without the blank line between them", () => {
		const text = "first page\n\nsecond\n\npage"
		const units = splitDocumentText(
			{
				text,
				units: [
					{ label: "page 4", start: 0 },
					{ label: "page 5", start: 12 }
				]
			},
			4
		)

		expect(units).toEqual([
			{ unit: 4, label: "page 4", text: "first page" },
			{ unit: 5, label: "page 5", text: "second\n\npage" }
		])
		expect(documentUnitsText(units)).toBe("[page 4]\nfirst page\n\n[page 5]\nsecond\n\npage")
	})

	it("recognizes only well-formed units", () => {
		expect(documentUnits([{ unit: 1, label: "page 1", text: "a" }])).toHaveLength(1)
		expect(documentUnits([])).toBeNull()
		expect(documentUnits("text")).toBeNull()
		expect(documentUnits([{ label: "page 1", text: "a" }])).toBeNull()
	})
})

describe("openDocumentContext", () => {
	it("names the document, where the user is and the selection's size, never its text", () => {
		expect(
			openDocumentContext({ name: "report.pdf", handle: "f7", kind: "pdf", position: { page: 3, pages: 41 }, selectionChars: 212 })
		).toBe('open document: "report.pdf" (handle f7), PDF, page 3 of 41, 212 characters selected')
		expect(openDocumentContext({ name: "deck.pptx", handle: "f2", kind: "slides", position: { slide: 2 }, selectionChars: null })).toBe(
			'open document: "deck.pptx" (handle f2), presentation, slide 2'
		)
		expect(
			openDocumentContext({
				name: "budget.xlsx",
				handle: "f3",
				kind: "sheet",
				position: { sheet: "Q1‮evil", sheets: ["Summary", "Q1‮evil"] },
				selectionChars: 0
			})
		).toBe('open document: "budget.xlsx" (handle f3), spreadsheet, sheet "Q1evil" (2 of 2)')
		expect(openDocumentContext({ name: "notes.md", handle: "f4", kind: "text", position: {}, selectionChars: null })).toBe(
			'open document: "notes.md" (handle f4), text'
		)
	})
})

describe("documentChunks", () => {
	const page = (unit: number, text: string) => ({ unit, label: `page ${String(unit)}`, text })

	it("packs whole units in order, each chunk within the budget", () => {
		const units = Array.from({ length: 10 }, (_, index) => page(index + 1, "word ".repeat(40)))
		const chunks = documentChunks(units, 120)

		expect(chunks.length).toBeGreaterThan(1)
		expect(chunks[0]?.first).toBe(1)
		expect(chunks.at(-1)?.last).toBe(10)

		for (const [index, chunk] of chunks.entries()) {
			expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(120)
			expect(chunk.whole).toBe(true)
			expect(chunk.text.startsWith(`[page ${String(chunk.first)}]`)).toBe(true)

			if (index > 0) {
				expect(chunk.first).toBe((chunks[index - 1]?.last ?? 0) + 1)
			}
		}
	})

	it("splits a unit too long for one chunk at line ends, then inside a line, labelling its parts", () => {
		const long = ["line ".repeat(40), "x".repeat(2000), "end"].join("\n")
		const chunks = documentChunks([page(1, "short"), page(2, long), page(3, "after")], 100)
		const parts = chunks.filter(chunk => chunk.text.includes("[page 2 (part "))

		expect(parts.length).toBeGreaterThan(2)
		expect(parts.slice(0, -1).every(chunk => !chunk.whole)).toBe(true)
		expect(chunks.every(chunk => estimateTokens(chunk.text) <= 100)).toBe(true)
		expect(
			chunks
				.map(chunk => chunk.text)
				.join("")
				.replace(/\[page \d( \(part \d+\))?\]\n|\n/g, "")
		).toBe(`short${long.replaceAll("\n", "")}after`)
	})

	it("words what a cut-short read covered", () => {
		expect(documentCoveredText({ kind: "pdf", from: 1, to: 23, units: 41, end: 41 })).toBe("pages 1–23 of 41")
		expect(documentCoveredText({ kind: "pdf", from: 12, to: 11, units: 41, end: 41 })).toBe("part of page 12 of 41")
	})
})

describe("nothingSelected", () => {
	it("points a document's read at its pages or all of it, and an open text file's at read_text_file", () => {
		expect(nothingSelected("deck.pptx", "slides")).toBe(
			'Nothing is selected in "deck.pptx"; read its slides with part "pages" and from/to, or all of it with part "all"'
		)
		expect(nothingSelected("report.pdf", "pdf")).toContain('read its pages with part "pages"')
		expect(nothingSelected("todo.txt", "text")).toBe('Nothing is selected in "todo.txt"; read the file with read_text_file instead')
	})
})
