import { describe, expect, it } from "vitest"
import { docxPageText, type FindablePage } from "../dom/docx/find"
import { LINE_INTS, LineInt } from "../core/text/displayList"

// A laid-out page's text for a reader (the assistant): the part of each paragraph its lines show, in line order.

function page(sourceTexts: readonly string[], lines: readonly (readonly [source: number, start: number, end: number])[]): FindablePage {
	const lineInts = new Int32Array(lines.length * LINE_INTS)

	lines.forEach(([source, start, end], line) => {
		lineInts[line * LINE_INTS + LineInt.SOURCE] = source
		lineInts[line * LINE_INTS + LineInt.TEXT_START] = start
		lineInts[line * LINE_INTS + LineInt.TEXT_END] = end
	})

	return { index: 0, sourceCount: sourceTexts.length, sourceTexts, lineCount: lines.length, lineInts }
}

describe("docxPageText", () => {
	it("joins a paragraph's lines, breaks between paragraphs, and keeps only what this page shows of one split over two", () => {
		const shown = page(
			["Heading", "The first line wraps here", "Second paragraph, whose end is on the next page"],
			[
				[0, 0, 7],
				[1, 0, 15],
				[1, 15, 25],
				[2, 0, 17]
			]
		)

		expect(docxPageText(shown)).toBe("Heading\nThe first line wraps here\nSecond paragraph,")
	})

	it("puts a space where a line break left out the space between its lines, and reads an empty page as empty", () => {
		expect(
			docxPageText(
				page(
					["one two"],
					[
						[0, 0, 3],
						[0, 4, 7]
					]
				)
			)
		).toBe("one two")
		expect(docxPageText(page([], []))).toBe("")
	})
})
