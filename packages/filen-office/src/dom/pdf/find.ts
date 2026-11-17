import { SliceClock, type Slicing } from "../../core/slicing"
import { nfcWithMap } from "../../core/text/nfc"
import { documentTagged } from "./structGate"
import type { PdfDocument } from "./types"

// Find over a document's text content, the same items pdf.js's text layer draws one span each for, so a match
// maps straight onto the spans it covers. Text is extracted once per page on first search and kept for the
// next query; the search yields to the host between slices.

// The most matches a find reports; one more is looked for, so the viewer can tell there are more.
export const PDF_FIND_LIMIT = 10_000

// Ints per match: page (1-based), first item, offset in it, last item, offset after the match in it.
export const PDF_FIND_INTS = 5

export interface PdfPageText {
	// The items' text in order, with "\n" after an item that ends a line.
	readonly text: string
	// Where each item starts in `text`, and its length.
	readonly starts: Int32Array
	readonly lengths: Int32Array
}

export interface PdfFindResult {
	readonly matches: Int32Array
	readonly capped: boolean
}

const EMPTY_PAGE: PdfPageText = { text: "", starts: new Int32Array(0), lengths: new Int32Array(0) }
const SPECIAL = /[.*+?^${}()|[\]\\]/g
const WHITESPACE = /\s+/gu

// The items that carry text (marked-content markers carry none and get no span).
export function pdfPageText(items: readonly unknown[]): PdfPageText {
	const starts: number[] = []
	const lengths: number[] = []
	let text = ""

	for (const item of items) {
		if (typeof item !== "object" || item === null) continue

		const str: unknown = Reflect.get(item, "str")

		if (typeof str !== "string") continue

		starts.push(text.length)
		lengths.push(str.length)
		text += str

		if (Reflect.get(item, "hasEOL") === true) text += "\n"
	}

	return { text, starts: Int32Array.from(starts), lengths: Int32Array.from(lengths) }
}

// The query as a pattern: literal text, any run of whitespace matching any run (line ends included). Null for a
// query with nothing to find.
export function pdfFindPattern(query: string, caseSensitive: boolean): RegExp | null {
	const normalized = query.normalize("NFC")

	if (normalized.trim().length === 0) return null

	const source = normalized.replace(SPECIAL, "\\$&").replace(WHITESPACE, "\\s+")

	return new RegExp(source, caseSensitive ? "gu" : "giu")
}

// The last item starting at or before `at` (an item of zero length shares its start with the next).
function itemAt(page: PdfPageText, at: number): number {
	let lo = 0
	let hi = page.starts.length - 1

	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1

		if ((page.starts[mid] ?? 0) <= at) lo = mid
		else hi = mid - 1
	}

	return lo
}

// Appends the matches in one page's text to `out`; true once `limit` matches are there.
export function findInPage(page: PdfPageText, pageNumber: number, pattern: RegExp, out: number[], limit: number): boolean {
	if (page.starts.length === 0) return out.length / PDF_FIND_INTS >= limit

	const { text, starts, ends } = nfcWithMap(page.text)

	pattern.lastIndex = 0

	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		const found = match.index
		const foundEnd = found + match[0].length

		if (foundEnd === found) {
			pattern.lastIndex++

			continue
		}

		// Back to the extracted text, widened to whole characters.
		const start = starts === null ? found : (starts[found] ?? found)
		const end = ends === null ? foundEnd : (ends[foundEnd - 1] ?? foundEnd)
		let first = itemAt(page, start)
		let firstOffset = Math.min(start - (page.starts[first] ?? 0), page.lengths[first] ?? 0)

		// Starting on a line end: the match begins with the next item.
		if (firstOffset === (page.lengths[first] ?? 0) && first + 1 < page.starts.length) {
			first++
			firstOffset = 0
		}

		const last = itemAt(page, end - 1)
		const lastEnd = Math.min(end - (page.starts[last] ?? 0), page.lengths[last] ?? 0)

		out.push(pageNumber, first, firstOffset, last, lastEnd)

		if (out.length / PDF_FIND_INTS >= limit) return true
	}

	return false
}

// [from, to) of the matches on `page` (matches are in page order).
export function pageMatchRange(matches: Int32Array, page: number): readonly [number, number] {
	const count = matches.length / PDF_FIND_INTS
	let lo = 0
	let hi = count

	while (lo < hi) {
		const mid = (lo + hi) >> 1

		if ((matches[mid * PDF_FIND_INTS] ?? 0) < page) lo = mid + 1
		else hi = mid
	}

	let to = lo

	while (to < count && matches[to * PDF_FIND_INTS] === page) to++

	return [lo, to]
}

export interface PdfFindSignal {
	readonly aborted: boolean
}

export class PdfFinder {
	private readonly document: PdfDocument
	private readonly slicing: Slicing | undefined
	private readonly texts: (PdfPageText | undefined)[] = []

	constructor(document: PdfDocument, slicing?: Slicing) {
		this.document = document
		this.slicing = slicing
	}

	private async pageText(pageNumber: number): Promise<PdfPageText> {
		const known = this.texts[pageNumber - 1]

		if (known !== undefined) return known

		let text = EMPTY_PAGE

		try {
			const page = await this.document.getPage(pageNumber)

			// As the text layer reads it: with marked content on a tagged document, whose items can split differently.
			const marked = await documentTagged(this.document, page)

			text = pdfPageText((await page.getTextContent(marked ? { includeMarkedContent: true } : undefined)).items)
		} catch {
			// A page whose text cannot be read has nothing to find; the rest of the document still searches.
		}

		this.texts[pageNumber - 1] = text

		return text
	}

	// Every match in the document, in page order. Null when `signal` aborted it (a newer query).
	async search(
		query: string,
		caseSensitive: boolean,
		signal: PdfFindSignal,
		limit: number = PDF_FIND_LIMIT
	): Promise<PdfFindResult | null> {
		const pattern = pdfFindPattern(query, caseSensitive)

		if (pattern === null) return { matches: new Int32Array(0), capped: false }

		const clock = this.slicing === undefined ? undefined : new SliceClock(this.slicing)
		const out: number[] = []
		const looking = limit + 1

		for (let pageNumber = 1; pageNumber <= this.document.numPages; pageNumber++) {
			const known = this.texts[pageNumber - 1]
			const text = known ?? (await this.pageText(pageNumber))

			if (signal.aborted) return null

			const full = findInPage(text, pageNumber, pattern, out, looking)

			if (full) break
			if (clock?.due === true) {
				await clock.pause()

				if (signal.aborted) return null
			}
		}

		const count = out.length / PDF_FIND_INTS
		const capped = count > limit

		return { matches: Int32Array.from(capped ? out.slice(0, limit * PDF_FIND_INTS) : out), capped }
	}

	dispose(): void {
		this.texts.length = 0
	}
}
