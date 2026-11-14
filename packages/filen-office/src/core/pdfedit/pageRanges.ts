// Page ranges as people type them ("1-3, 7, 10-"): one grammar for printing, extracting and splitting. Pages are
// 1-based; a range without an end runs to the last page, one without a start from the first ("-4"). Commas or
// semicolons separate parts, whitespace is ignored, an en dash counts as a hyphen.

// Inclusive, 1-based, first <= last.
export interface PageRange {
	readonly first: number
	readonly last: number
}

export type PageRangeError =
	// Nothing but separators.
	| { readonly kind: "empty" }
	// A part that is not a page or a range.
	| { readonly kind: "syntax"; readonly part: string }
	// A page below 1 or above the document's last.
	| { readonly kind: "outOfRange"; readonly part: string }
	// A range that runs backwards ("7-3").
	| { readonly kind: "reversed"; readonly part: string }

export type PageRangeResult =
	{ readonly ok: true; readonly ranges: readonly PageRange[] } | { readonly ok: false; readonly error: PageRangeError }

const PART = /^(\d*)-(\d*)$|^(\d+)$/
// A part longer than this is not a page number anyone typed; refused before it reaches Number().
const MAX_DIGITS = 9

function page(digits: string): number | null {
	return digits.length === 0 || digits.length > MAX_DIGITS ? null : Number(digits)
}

// Parses `text` for a document of `pageCount` pages into ranges sorted by first page, overlapping and adjacent ones
// merged.
export function parsePageRanges(text: string, pageCount: number): PageRangeResult {
	const parts = text
		.replace(/–/g, "-")
		.split(/[,;]/)
		.map(part => part.replace(/\s+/g, ""))
		.filter(part => part.length > 0)

	if (parts.length === 0) return { ok: false, error: { kind: "empty" } }

	const ranges: PageRange[] = []

	for (const part of parts) {
		const match = PART.exec(part)

		if (match === null || part === "-") return { ok: false, error: { kind: "syntax", part } }

		const single = match[3]
		const first = single === undefined ? (match[1] === "" ? 1 : page(match[1] ?? "")) : page(single)
		const last = single === undefined ? (match[2] === "" ? pageCount : page(match[2] ?? "")) : first

		if (first === null || last === null) return { ok: false, error: { kind: "syntax", part } }
		if (first < 1 || last < 1 || first > pageCount || last > pageCount) return { ok: false, error: { kind: "outOfRange", part } }
		if (first > last) return { ok: false, error: { kind: "reversed", part } }

		ranges.push({ first, last })
	}

	return { ok: true, ranges: normalizePageRanges(ranges) }
}

// Sorted by first page, overlapping and adjacent ranges merged.
export function normalizePageRanges(ranges: readonly PageRange[]): PageRange[] {
	const sorted = [...ranges].sort((a, b) => a.first - b.first)
	const out: PageRange[] = []

	for (const range of sorted) {
		const previous = out.at(-1)

		if (previous !== undefined && range.first <= previous.last + 1) {
			out[out.length - 1] = { first: previous.first, last: Math.max(previous.last, range.last) }
		} else {
			out.push(range)
		}
	}

	return out
}

// The number of pages the ranges hold.
export function pageRangesCount(ranges: readonly PageRange[]): number {
	let count = 0

	for (const range of ranges) count += range.last - range.first + 1

	return count
}

// The pages in order, 1-based, without building an array of them.
export function* pageRangesPages(ranges: readonly PageRange[]): Generator<number> {
	for (const range of ranges) {
		for (let at = range.first; at <= range.last; at++) yield at
	}
}

// The canonical text of `ranges` ("1-3, 7, 10-12"), as a field shows it back.
export function formatPageRanges(ranges: readonly PageRange[]): string {
	return ranges
		.map(range => (range.first === range.last ? String(range.first) : `${String(range.first)}-${String(range.last)}`))
		.join(", ")
}
