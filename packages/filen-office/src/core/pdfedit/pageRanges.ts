// Page ranges as people type them ("1-3, 7, 10-"): one grammar for printing, extracting and splitting. Pages are
// 1-based; a range without an end runs to the last page, one without a start from the first ("-4"). Commas or
// semicolons separate parts, whitespace is ignored; full-width forms, other scripts' digits, dashes, the minus sign and
// ideographic or Arabic commas count as their ASCII forms.

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

// The zero of each decimal digit block a shipped locale's keyboard types that NFKC leaves alone (Arabic-Indic,
// Extended Arabic-Indic, Devanagari, Bengali, Thai); each block runs 0 to 9.
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50]
// Hyphens, dashes, the minus sign and the katakana long vowel mark an IME types for "-".
const DASH = /^[\u2010-\u2015\u2212\u30fc]$/
// The ideographic and Arabic commas and the Arabic semicolon.
const COMMA = /^[\u3001\u060c\u061b]$/
const SPACE = /\s/

function nfkc(char: string): string {
	try {
		return char.normalize("NFKC")
	} catch {
		// No Unicode normalization on this engine: full-width forms stay unread, as before.
		return char
	}
}

// One character as the grammar reads it: full-width forms, other digits, dashes and commas as their ASCII forms.
function foldChar(char: string): string {
	const code = char.codePointAt(0) ?? 0

	if (code < 0x80) return char

	for (const zero of DIGIT_ZEROS) {
		if (code >= zero && code <= zero + 9) return String(code - zero)
	}

	const folded = nfkc(char)

	if (DASH.test(folded)) return "-"
	if (COMMA.test(folded)) return ","

	return folded
}

interface Part {
	// As typed (whitespace dropped), for errors shown to the user.
	readonly typed: string
	// As the grammar reads it.
	readonly folded: string
}

// The non-empty parts of `text`, split at commas and semicolons, whitespace dropped.
function splitParts(text: string): Part[] {
	const parts: Part[] = []
	let typed = ""
	let folded = ""

	for (const char of text) {
		if (SPACE.test(char)) continue

		const read = foldChar(char)

		if (read === "," || read === ";") {
			if (typed.length > 0) parts.push({ typed, folded })

			typed = ""
			folded = ""
		} else {
			typed += char
			folded += read
		}
	}

	if (typed.length > 0) parts.push({ typed, folded })

	return parts
}

function page(digits: string): number | null {
	return digits.length === 0 || digits.length > MAX_DIGITS ? null : Number(digits)
}

// Parses `text` for a document of `pageCount` pages into ranges sorted by first page, overlapping and adjacent ones
// merged.
export function parsePageRanges(text: string, pageCount: number): PageRangeResult {
	const parsed = parsePageRangeParts(text, pageCount)

	return parsed.ok ? { ok: true, ranges: normalizePageRanges(parsed.ranges) } : parsed
}

// Parses `text` like parsePageRanges, keeping every part as typed, in order (overlaps included): splitting by ranges
// makes one file per part.
export function parsePageRangeParts(text: string, pageCount: number): PageRangeResult {
	const parts = splitParts(text)

	if (parts.length === 0) return { ok: false, error: { kind: "empty" } }

	const ranges: PageRange[] = []

	for (const { typed: part, folded } of parts) {
		const match = PART.exec(folded)

		if (match === null || folded === "-") return { ok: false, error: { kind: "syntax", part } }

		const single = match[3]
		const first = single === undefined ? (match[1] === "" ? 1 : page(match[1] ?? "")) : page(single)
		const last = single === undefined ? (match[2] === "" ? pageCount : page(match[2] ?? "")) : first

		if (first === null || last === null) return { ok: false, error: { kind: "syntax", part } }
		if (first < 1 || last < 1 || first > pageCount || last > pageCount) return { ok: false, error: { kind: "outOfRange", part } }
		if (first > last) return { ok: false, error: { kind: "reversed", part } }

		ranges.push({ first, last })
	}

	return { ok: true, ranges }
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
