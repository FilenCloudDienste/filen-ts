import { findPattern } from "../../core/docx/findPattern"
import { nfcWithMap } from "../../core/text/nfc"
import { DOCX_FIND_LIMIT, FIND_INTS, type DocxFindOptions } from "./protocol"

// Find over laid-out pages. A match belongs to the page whose line holds its first character, so a paragraph
// split over two pages (whose text both pages carry) reports each match once.

export interface FindablePage {
	readonly index: number
	readonly sourceCount: number
	readonly sourceTexts: readonly string[]
	readonly lineCount: number
	// lineInts as the text layout writes them (LINE_INTS per line; text start 2, end 3, source 5).
	readonly lineInts: Int32Array
}

const LINE_INTS = 7

// The page's line that holds offset `at` of `source`, or -1.
export function lineOf(page: FindablePage, source: number, at: number): number {
	for (let line = 0; line < page.lineCount; line++) {
		const i = line * LINE_INTS

		if (page.lineInts[i + 5] === source && at >= (page.lineInts[i + 2] ?? 0) && at < (page.lineInts[i + 3] ?? 0)) return line
	}

	return -1
}

export function findMatches(pages: Iterable<FindablePage | undefined>, query: string, options: DocxFindOptions = {}): Int32Array {
	const out: number[] = []
	const pattern = findPattern(query, options)

	if (pattern === null) return new Int32Array(0)

	// One past the limit: whoever shows the matches can tell there are more.
	const limit = (options.limit ?? DOCX_FIND_LIMIT) + 1

	for (const page of pages) {
		if (page === undefined) continue

		for (let source = 0; source < page.sourceCount; source++) {
			const { text, starts, ends } = nfcWithMap(page.sourceTexts[source] ?? "")

			pattern.lastIndex = 0

			for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
				const found = match.index
				const foundEnd = found + match[0].length

				if (foundEnd === found) {
					pattern.lastIndex++

					continue
				}

				// Back to the original text, widened to whole characters.
				const start = starts === null ? found : (starts[found] ?? found)
				const end = ends === null ? foundEnd : (ends[foundEnd - 1] ?? foundEnd)

				if (lineOf(page, source, start) < 0) continue

				out.push(page.index, source, start, end)

				if (out.length / FIND_INTS >= limit) return Int32Array.from(out)
			}
		}
	}

	return Int32Array.from(out)
}
