// Redaction rules shared by the editor (find, mark, apply) and the verifier that checks a saved redacted file: what
// was redacted (the manifest), why a check failed, term matching, the find presets, and the geometry both sides agree
// on. Coordinates are MuPDF page space (points, origin top left, y down), the space annotations and stext use.

import { invertMatrix, transformPoint, type PdfMatrix } from "./matrix"

export type RedactRect = readonly [number, number, number, number]
export type RedactQuad = readonly [number, number, number, number, number, number, number, number]

// "text": marked characters (quads); drawings are removed only where fully covered. "area": a drawn rectangle;
// drawings it touches are removed whole. "page": the whole page, as an area.
export type RedactionMarkKind = "text" | "area" | "page"

// A pending mark, as the review list shows it.
export interface RedactionMark {
	// The annotation's object number: stable across undo and redo, used to remove the mark.
	readonly id: number
	readonly page: number
	readonly kind: RedactionMarkKind
	readonly rect: RedactRect
	readonly quads: readonly RedactQuad[]
}

export interface RedactionRegion {
	// 0-based page index in the saved file.
	readonly page: number
	readonly kind: RedactionMarkKind
	readonly rect: RedactRect
}

export interface RedactionTerm {
	readonly text: string
	readonly matchCase: boolean
	readonly wholeWord: boolean
}

// What a redaction removed, handed to the verifier with the saved file.
export interface RedactionManifest {
	readonly regions: readonly RedactionRegion[]
	// Each must have no match anywhere in the file.
	readonly terms: readonly RedactionTerm[]
	// The words the marks covered (coveredWords): none may remain in a text alternative of the structure tree, where
	// tags would spell out what the pages no longer draw. Not searched elsewhere: a word may still be on a page
	// outside the marks.
	readonly hidden?: readonly RedactionTerm[]
	// Sanitize ran: no metadata, attachments, scripts or page-piece data may remain.
	readonly sanitized: boolean
	// Annotations over marks were removed, so the ones left must not draw into a mark.
	readonly annotationsRemoved: boolean
}

// Where a term was found, for the failure message.
export type RedactionPlace = "page" | "annotation" | "field" | "bookmark" | "metadata" | "attachment" | "tags" | "file"

export type RedactionFailure =
	// The file keeps earlier revisions.
	| { readonly code: "revisions"; readonly count: number }
	// A glyph still sits inside a mark (1-based page).
	| { readonly code: "text"; readonly page: number }
	// An image pixel inside a mark is not the fill.
	| { readonly code: "image"; readonly page: number }
	// A drawing touching an area mark survived.
	| { readonly code: "drawing"; readonly page: number }
	| { readonly code: "term"; readonly term: string; readonly place: RedactionPlace; readonly page?: number }
	// Sanitized, yet metadata of this kind remains.
	| { readonly code: "metadata"; readonly what: "info" | "xmp" | "attachments" | "scripts" | "pieceInfo" }
	// Thumbnails or alternate images remain.
	| { readonly code: "hiddenData" }
	// The page could not be loaded or run.
	| { readonly code: "unreadable"; readonly page: number }

export type RedactionVerdict = { readonly ok: true } | { readonly ok: false; readonly failure: RedactionFailure }

// Write options for a redacted file: a full rewrite without unused objects, so no earlier revision or orphaned
// original survives; never renumbered (savePlan.ts PDF_FULL_SAVE_OPTIONS: the document goes on after a copy or a
// failed check). The host adds its encryption option.
export const REDACTION_SAVE_OPTIONS = "garbage=yes,compress,objstms"

// ——— Geometry ———

export function rectsOverlap(left: RedactRect, right: RedactRect): boolean {
	return left[0] < right[2] && right[0] < left[2] && left[1] < right[3] && right[1] < left[3]
}

export function quadBounds(quad: RedactQuad): RedactRect {
	return [
		Math.min(quad[0], quad[2], quad[4], quad[6]),
		Math.min(quad[1], quad[3], quad[5], quad[7]),
		Math.max(quad[0], quad[2], quad[4], quad[6]),
		Math.max(quad[1], quad[3], quad[5], quad[7])
	]
}

export function rectUnion(rects: readonly RedactRect[]): RedactRect | null {
	if (rects.length === 0) return null

	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]

	for (const rect of rects) {
		x0 = Math.min(x0, rect[0])
		y0 = Math.min(y0, rect[1])
		x1 = Math.max(x1, rect[2])
		y1 = Math.max(y1, rect[3])
	}

	return [x0, y0, x1, y1]
}

export function intersectRects(left: RedactRect, right: RedactRect): RedactRect | null {
	const out: RedactRect = [
		Math.max(left[0], right[0]),
		Math.max(left[1], right[1]),
		Math.min(left[2], right[2]),
		Math.min(left[3], right[3])
	]

	return out[0] < out[2] && out[1] < out[3] ? out : null
}

// The quad of a rectangle under a matrix (corners in rectangle order: x0y0, x1y0, x0y1, x1y1).
export function transformRectQuad(matrix: PdfMatrix, rect: RedactRect): RedactQuad {
	const [ax, ay] = transformPoint(matrix, rect[0], rect[1])
	const [bx, by] = transformPoint(matrix, rect[2], rect[1])
	const [cx, cy] = transformPoint(matrix, rect[0], rect[3])
	const [dx, dy] = transformPoint(matrix, rect[2], rect[3])

	return [ax, ay, bx, by, cx, cy, dx, dy]
}

export function transformRect(matrix: PdfMatrix, rect: RedactRect): RedactRect {
	return quadBounds(transformRectQuad(matrix, rect))
}

// The quad's corners as a convex polygon (the quad order is two rows, so the second row runs backwards).
function quadPolygon(quad: RedactQuad): readonly (readonly [number, number])[] {
	return [
		[quad[0], quad[1]],
		[quad[2], quad[3]],
		[quad[6], quad[7]],
		[quad[4], quad[5]]
	]
}

// Whether a (convex, parallelogram) quad and a rectangle share interior: separating-axis test on the rectangle's
// axes and the quad's edge normals.
export function quadOverlapsRect(quad: RedactQuad, rect: RedactRect): boolean {
	if (!rectsOverlap(quadBounds(quad), rect)) return false

	const polygon = quadPolygon(quad)
	const corners: readonly (readonly [number, number])[] = [
		[rect[0], rect[1]],
		[rect[2], rect[1]],
		[rect[2], rect[3]],
		[rect[0], rect[3]]
	]

	for (let index = 0; index < polygon.length; index++) {
		const from = polygon[index]
		const to = polygon[(index + 1) % polygon.length]

		if (from === undefined || to === undefined) continue

		const nx = to[1] - from[1]
		const ny = from[0] - to[0]

		if (Math.abs(nx) + Math.abs(ny) < 1e-12) continue

		let quadMin = Infinity
		let quadMax = -Infinity
		let rectMin = Infinity
		let rectMax = -Infinity

		for (const [x, y] of polygon) {
			const value = x * nx + y * ny

			quadMin = Math.min(quadMin, value)
			quadMax = Math.max(quadMax, value)
		}
		for (const [x, y] of corners) {
			const value = x * nx + y * ny

			rectMin = Math.min(rectMin, value)
			rectMax = Math.max(rectMax, value)
		}

		if (quadMax <= rectMin || rectMax <= quadMin) return false
	}

	return true
}

// The part of a glyph that counts as "inside" a mark: its advance box without 15 % at each side, from the baseline
// up to half the em. MuPDF removes a glyph when its box less 10 % at each side touches a mark; the smaller core keeps
// the check from failing on a neighbour that a mark only grazes, and every glyph that is substantially inside is
// still caught. `trm` maps glyph space (1 unit = 1 em) to page space.
export function glyphCore(trm: PdfMatrix, advance: number, vertical: boolean): RedactQuad {
	if (vertical) {
		const extent = Math.max(advance, 0.1)

		return transformRectQuad(trm, [-0.35, -0.85 * extent, 0.35, -0.15 * extent])
	}

	if (advance < 0.1) {
		// Zero-width glyphs (combining marks, invisible OCR fonts with no widths): a small box at the origin.
		return transformRectQuad(trm, [0, 0, 0.1, 0.5])
	}

	return transformRectQuad(trm, [0.15 * advance, 0, 0.85 * advance, 0.5])
}

// Calls `visit(column, row)` for every pixel of an image drawn with `ctm` whose area overlaps `rect`; `visit`
// returning false stops. `ctm` is the image matrix as a MuPDF device receives it: the unit square with pixel row 0
// at y = 0. Pixels only touching along an edge do not count.
export function forEachCoveredPixel(
	ctm: PdfMatrix,
	width: number,
	height: number,
	rect: RedactRect,
	visit: (column: number, row: number) => boolean | undefined
): void {
	const inverse = invertMatrix(ctm)

	if (inverse === null || width <= 0 || height <= 0) return

	const area = transformRect(inverse, rect)
	const columnFrom = Math.max(0, Math.floor(area[0] * width))
	const columnTo = Math.min(width - 1, Math.ceil(area[2] * width) - 1)
	const rowFrom = Math.max(0, Math.floor(area[1] * height))
	const rowTo = Math.min(height - 1, Math.ceil(area[3] * height) - 1)
	const inset = 1e-3

	for (let row = rowFrom; row <= rowTo; row++) {
		for (let column = columnFrom; column <= columnTo; column++) {
			const pixel = transformRectQuad(ctm, [
				(column + inset) / width,
				(row + inset) / height,
				(column + 1 - inset) / width,
				(row + 1 - inset) / height
			])

			if (quadOverlapsRect(pixel, rect) && visit(column, row) === false) return
		}
	}
}

// Whether a line segment passes through a rectangle's interior (Liang–Barsky clip).
export function segmentCrossesRect(x0: number, y0: number, x1: number, y1: number, rect: RedactRect): boolean {
	const dx = x1 - x0
	const dy = y1 - y0
	let low = 0
	let high = 1

	for (const [p, q] of [
		[-dx, x0 - rect[0]],
		[dx, rect[2] - x0],
		[-dy, y0 - rect[1]],
		[dy, rect[3] - y0]
	] as const) {
		if (p === 0) {
			if (q <= 0) return false

			continue
		}

		const t = q / p

		if (p < 0) low = Math.max(low, t)
		else high = Math.min(high, t)

		if (low >= high) return false
	}

	return true
}

// ——— Terms ———

// Case folding one UTF-16 unit at a time, so indices into the folded text are indices into the original.
export function foldCase(text: string): string {
	let out = ""

	for (const char of text) {
		const lower = char.toLowerCase()

		out += lower.length === char.length ? lower : char
	}

	return out
}

const WORD = /[\p{L}\p{N}_]/u

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && WORD.test(char)
}

export interface TextMatch {
	readonly start: number
	readonly end: number
}

// Every match of a literal term (no patterns); overlapping matches are skipped. `folded` is foldCase(text), passed
// when the caller searches one text for many terms.
export function matchTerm(text: string, term: RedactionTerm, folded?: string): TextMatch[] {
	const needle = term.matchCase ? term.text : foldCase(term.text)
	const haystack = term.matchCase ? text : (folded ?? foldCase(text))
	const matches: TextMatch[] = []

	if (needle.length === 0) return matches

	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
		const end = at + needle.length

		if (term.wholeWord && (isWordChar(text[at - 1]) || isWordChar(text[end]))) continue

		matches.push({ start: at, end })
		at = end - 1
	}

	return matches
}

// Shortest word a redaction's covered text adds to the manifest's hidden terms: shorter ones are too common to prove
// anything by their absence.
export const MIN_HIDDEN_WORD = 4
// Most hidden terms a manifest carries (the longest kept), the most terms the verifier is handed.
export const MAX_HIDDEN_TERMS = 1000

const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

// The words of a page's text that its marks covered, read before they were applied: each word (split on white space,
// edge punctuation trimmed) of every run of covered characters, at least MIN_HIDDEN_WORD long. `covered[i]` tells
// whether UTF-16 unit `i` of `text` lies under a mark.
export function coveredWords(text: string, covered: readonly boolean[]): string[] {
	const words = new Set<string>()
	let run = ""
	const flush = (): void => {
		for (const part of run.split(/\s+/u)) {
			const word = part.replace(EDGE_PUNCTUATION, "")

			if ([...word].length >= MIN_HIDDEN_WORD) words.add(word)
		}

		run = ""
	}

	for (let index = 0; index < text.length; index++) {
		if (covered[index] === true) run += text[index]
		else flush()
	}

	flush()

	return [...words]
}

// The manifest's hidden terms for covered words: each matched as a whole word, case and all, the longest kept up to
// MAX_HIDDEN_TERMS.
export function hiddenTerms(words: Iterable<string>): RedactionTerm[] {
	return [...new Set(words)]
		.sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
		.slice(0, MAX_HIDDEN_TERMS)
		.map(text => ({ text, matchCase: true, wholeWord: true }))
}

// A term with at least one character that is not whitespace.
export function isSearchableTerm(text: string): boolean {
	return text.trim().length > 0
}

export type RedactionPreset = "emails" | "phoneNumbers"

export const REDACTION_PRESETS: readonly RedactionPreset[] = ["emails", "phoneNumbers"]

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu
const PHONE = /(?<![\p{L}\p{N}+])\+?\(?\d[\d ().\-/–]{4,24}\d(?![\p{L}\p{N}])/gu
const DATE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/
// Amounts written with thousands separators ("1.234.567").
const GROUPED = /^\d{1,3}(?:[.,]\d{3})+$/

// Matches of a preset in a text.
export function matchPreset(text: string, preset: RedactionPreset): TextMatch[] {
	const matches: TextMatch[] = []
	const pattern = preset === "emails" ? EMAIL : PHONE

	pattern.lastIndex = 0

	for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
		const value = found[0]

		if (preset === "phoneNumbers") {
			const digits = value.replace(/\D/g, "").length

			if (digits < 7 || digits > 15 || DATE.test(value) || GROUPED.test(value)) continue
		}

		matches.push({ start: found.index, end: found.index + value.length })
	}

	return matches
}

// What Find and redact searches for.
export interface RedactionQuery {
	readonly terms: readonly RedactionTerm[]
	readonly presets: readonly RedactionPreset[]
}

// One hit of a find, as the review list shows it.
export interface RedactionFinding {
	// Stable within one find: "page:index".
	readonly id: string
	readonly page: number
	// The matched text.
	readonly text: string
	readonly quads: readonly RedactQuad[]
	// The term (index into the query's terms) or preset that found it.
	readonly source: { readonly kind: "term"; readonly index: number } | { readonly kind: "preset"; readonly preset: RedactionPreset }
}

// The terms the verifier must find nowhere: a query term counts when every one of its findings stays marked (a hit
// the user chose to keep would otherwise fail the check); each marked preset hit counts as its literal text.
export function verifiedTerms(
	terms: readonly RedactionTerm[],
	findings: readonly RedactionFinding[],
	marked: ReadonlySet<string>
): RedactionTerm[] {
	const kept = new Set<number>()
	const out: RedactionTerm[] = []
	const literals = new Set<string>()

	for (const finding of findings) {
		if (finding.source.kind === "term" && !marked.has(finding.id)) kept.add(finding.source.index)
	}

	terms.forEach((term, index) => {
		if (!kept.has(index) && isSearchableTerm(term.text)) out.push(term)
	})

	for (const finding of findings) {
		if (finding.source.kind !== "preset" || !marked.has(finding.id) || literals.has(finding.text)) continue

		literals.add(finding.text)
		out.push({ text: finding.text, matchCase: true, wholeWord: false })
	}

	return out
}

// ——— Decoding the strings a file carries ———

function utf16(bytes: Uint8Array, from: number, littleEndian: boolean): string {
	let out = ""

	for (let index = from; index + 1 < bytes.length; index += 2) {
		const high = bytes[index] ?? 0
		const low = bytes[index + 1] ?? 0

		out += String.fromCharCode(littleEndian ? low * 256 + high : high * 256 + low)
	}

	return out
}

export function latin1Text(bytes: Uint8Array): string {
	let out = ""

	for (let index = 0; index < bytes.length; index += 8192) {
		out += String.fromCharCode(...bytes.subarray(index, index + 8192))
	}

	return out
}

// UTF-8, with every invalid byte read as Latin-1 (binary data decodes without throwing).
export function utf8Text(bytes: Uint8Array): string {
	let out = ""
	let index = 0

	while (index < bytes.length) {
		const first = bytes[index] ?? 0
		let length =
			first < 0x80 ? 1 : first >= 0xc2 && first < 0xe0 ? 2 : first >= 0xe0 && first < 0xf0 ? 3 : first >= 0xf0 && first < 0xf5 ? 4 : 0
		let code = length === 1 ? first : length === 2 ? first & 0x1f : length === 3 ? first & 0x0f : first & 0x07

		for (let next = 1; next < length; next++) {
			const byte = bytes[index + next]

			if (byte === undefined || (byte & 0xc0) !== 0x80) {
				length = 0

				break
			}

			code = code * 64 + (byte & 0x3f)
		}

		if (length === 0 || code > 0x10ffff) {
			out += String.fromCharCode(first)
			index++
		} else {
			out += String.fromCodePoint(code)
			index += length
		}
	}

	return out
}

// A PDF text string's bytes: UTF-16 with a byte order mark, UTF-8 with one, else PDFDocEncoding (read as Latin-1).
export function pdfTextString(bytes: Uint8Array): string {
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes, 2, false)
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes, 2, true)
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8Text(bytes.subarray(3))

	return latin1Text(bytes)
}

const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

// XML character and entity references resolved (XMP spells text this way).
export function decodeXmlText(text: string): string {
	return text.replace(ENTITY, (whole, decimal?: string, hex?: string, named?: string) => {
		const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : -1

		if (code >= 0) return code <= 0x10ffff ? String.fromCodePoint(code) : whole

		return (named !== undefined ? NAMED[named] : undefined) ?? whole
	})
}

// Every reading of raw stream bytes a term could hide in: Latin-1, UTF-8 (with XML references resolved) and UTF-16
// in both byte orders at both alignments.
export function streamReadings(bytes: Uint8Array): string[] {
	const readings = [latin1Text(bytes), decodeXmlText(utf8Text(bytes))]

	if (bytes.length >= 2) readings.push(utf16(bytes, 0, false), utf16(bytes, 1, false), utf16(bytes, 0, true), utf16(bytes, 1, true))

	return readings
}
