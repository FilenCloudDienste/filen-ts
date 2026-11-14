import { unzlibSync } from "fflate"
import { readExactly, type PdfByteSource } from "./source"
import { asciiBytes, dictName, dictNumber, isWhite, lastIndexOf, PdfLexer, type PdfValue } from "./syntax"

// The file's cross-reference sections, newest first, read from the raw bytes: which objects each revision wrote, and
// where. MuPDF merges them into one table, so per-revision questions (what changed after a signature, where does the
// signature dictionary lie) are answered here.

export type XrefEntry =
	| { readonly type: 0 }
	| { readonly type: 1; readonly offset: number; readonly gen: number }
	| { readonly type: 2; readonly stream: number; readonly index: number }

export interface XrefSection {
	// Byte offset of the section ("xref" keyword or the xref stream object).
	readonly offset: number
	readonly entries: ReadonlyMap<number, XrefEntry>
}

export interface XrefChain {
	// Newest first.
	readonly sections: readonly XrefSection[]
	// Offset the file's final startxref points at.
	readonly startxref: number
}

const TAIL_BYTES = 4096
const MAX_TAIL_BYTES = 1024 * 1024
const MAX_SECTIONS = 4096
const MAX_SECTION_BYTES = 64 * 1024 * 1024
const FIRST_WINDOW = 64 * 1024
const MAX_OBJECTS = 8_388_607

const STARTXREF = asciiBytes("startxref")

// The offset after the last "startxref" at or before `end`, scanning back in growing windows.
export async function findStartxref(
	source: PdfByteSource,
	end = source.length
): Promise<{ readonly offset: number; readonly at: number } | null> {
	for (let window = TAIL_BYTES; ; window *= 4) {
		const start = Math.max(0, end - window)
		const tail = await readExactly(source, start, end - start)
		const at = lastIndexOf(tail, STARTXREF)

		if (at >= 0) {
			const lexer = new PdfLexer(tail, at + STARTXREF.length)
			const offset = lexer.integer()

			return offset === null ? null : { offset, at: start + at }
		}

		if (start === 0 || window >= MAX_TAIL_BYTES) return null
	}
}

export async function readXrefChain(source: PdfByteSource): Promise<XrefChain | null> {
	const found = await findStartxref(source)

	if (found === null) return null

	const sections: XrefSection[] = []
	const seen = new Set<number>()
	let next: number | null = found.offset

	while (next !== null) {
		if (seen.has(next) || sections.length >= MAX_SECTIONS || next < 0 || next >= source.length) return null

		seen.add(next)

		const parsed = await readSection(source, next)

		if (parsed === null) return null

		const entries = new Map(parsed.entries)

		// A hybrid file's /XRefStm adds entries to the same section.
		if (parsed.xrefStm !== null && !seen.has(parsed.xrefStm)) {
			seen.add(parsed.xrefStm)

			const hybrid = await readSection(source, parsed.xrefStm)

			if (hybrid === null) return null

			for (const [num, entry] of hybrid.entries) if (!entries.has(num)) entries.set(num, entry)
		}

		sections.push({ offset: next, entries })
		next = parsed.prev
	}

	return { sections, startxref: found.offset }
}

// The newest entry for an object.
export function xrefEntry(chain: XrefChain, num: number): XrefEntry | null {
	for (const section of chain.sections) {
		const entry = section.entries.get(num)

		if (entry !== undefined) return entry
	}

	return null
}

interface ParsedSection {
	readonly entries: ReadonlyMap<number, XrefEntry>
	readonly prev: number | null
	readonly xrefStm: number | null
}

async function readSection(source: PdfByteSource, offset: number): Promise<ParsedSection | null> {
	for (let window = FIRST_WINDOW; ; window *= 4) {
		const length = Math.min(window, source.length - offset)
		const bytes = await readExactly(source, offset, length)
		const parsed = parseSection(bytes)

		if (parsed !== "truncated") return parsed
		if (offset + length >= source.length || window >= MAX_SECTION_BYTES) return null
	}
}

function parseSection(bytes: Uint8Array): ParsedSection | null | "truncated" {
	const lexer = new PdfLexer(bytes)

	if (lexer.expect("xref")) return parseTable(lexer)

	return parseStream(lexer)
}

function parseTable(lexer: PdfLexer): ParsedSection | null | "truncated" {
	const entries = new Map<number, XrefEntry>()

	for (;;) {
		const at = lexer.position

		if (lexer.expect("trailer")) break

		lexer.position = at

		const first = lexer.integer()
		const count = lexer.integer()

		if (first === null || count === null) return lexer.position >= lexer.bytes.length ? "truncated" : null
		if (first + count > MAX_OBJECTS) return null

		for (let i = 0; i < count; i++) {
			const offset = lexer.integer()
			const gen = lexer.integer()
			const kind = lexer.word()

			if (offset === null || gen === null || kind === null) return lexer.position >= lexer.bytes.length ? "truncated" : null
			if (kind !== "n" && kind !== "f") return null

			// The first subsection entry wins within one section, as in every reader.
			if (!entries.has(first + i)) entries.set(first + i, kind === "n" ? { type: 1, offset, gen } : { type: 0 })
		}
	}

	const trailer = lexer.value()

	if (trailer === null) return "truncated"
	if (trailer.type !== "dict") return null

	return { entries, prev: dictNumber(trailer.entries, "Prev"), xrefStm: dictNumber(trailer.entries, "XRefStm") }
}

function parseStream(lexer: PdfLexer): ParsedSection | null | "truncated" {
	if (lexer.integer() === null || lexer.integer() === null || !lexer.expect("obj")) return null

	const dict = lexer.value()

	if (dict === null) return "truncated"
	if (dict.type !== "dict" || dictName(dict.entries, "Type") !== "XRef" || !lexer.expect("stream")) return null

	const bytes = lexer.bytes
	let start = lexer.position

	if (bytes[start] === 0x0d) start++
	if (bytes[start] === 0x0a) start++

	const length = dictNumber(dict.entries, "Length")

	if (length === null || length < 0) return null
	if (start + length > bytes.length) return "truncated"

	const data = decodeXrefStream(bytes.subarray(start, start + length), dict.entries)

	if (data === null) return null

	const entries = xrefStreamEntries(data, dict.entries)

	return entries === null ? null : { entries, prev: dictNumber(dict.entries, "Prev"), xrefStm: null }
}

function decodeXrefStream(raw: Uint8Array, dict: ReadonlyMap<string, PdfValue>): Uint8Array | null {
	const filter = dict.get("Filter")
	const name =
		filter?.type === "array"
			? filter.items.length === 1 && filter.items[0]?.type === "name"
				? filter.items[0].value
				: null
			: filter?.type === "name"
				? filter.value
				: filter === undefined
					? ""
					: null

	if (name === null) return null

	let data: Uint8Array

	if (name === "") data = raw
	else if (name === "FlateDecode") {
		try {
			data = unzlibSync(raw)
		} catch {
			return null
		}
	} else return null

	const parmsValue = dict.get("DecodeParms")
	const parms =
		parmsValue?.type === "dict"
			? parmsValue.entries
			: parmsValue?.type === "array" && parmsValue.items[0]?.type === "dict"
				? parmsValue.items[0].entries
				: null
	const predictor = parms === null ? 1 : (dictNumber(parms, "Predictor") ?? 1)

	if (predictor === 1) return data
	if (predictor < 10 || parms === null) return null

	return unpredictPng(data, dictNumber(parms, "Columns") ?? 1)
}

// PNG row filters (predictors 10-15), one byte per sample as xref streams use.
function unpredictPng(data: Uint8Array, columns: number): Uint8Array | null {
	if (columns < 1 || columns > 1 << 16) return null

	const rows = Math.floor(data.length / (columns + 1))
	const out = new Uint8Array(rows * columns)

	for (let row = 0; row < rows; row++) {
		const filter = data[row * (columns + 1)]
		const input = row * (columns + 1) + 1
		const at = row * columns

		for (let i = 0; i < columns; i++) {
			const raw = data[input + i] ?? 0
			const left = i > 0 ? (out[at + i - 1] ?? 0) : 0
			const up = row > 0 ? (out[at - columns + i] ?? 0) : 0
			const upLeft = row > 0 && i > 0 ? (out[at - columns + i - 1] ?? 0) : 0
			let value: number

			switch (filter) {
				case 0:
					value = raw
					break
				case 1:
					value = raw + left
					break
				case 2:
					value = raw + up
					break
				case 3:
					value = raw + ((left + up) >> 1)
					break
				case 4: {
					const p = left + up - upLeft
					const pa = Math.abs(p - left)
					const pb = Math.abs(p - up)
					const pc = Math.abs(p - upLeft)

					value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
					break
				}
				default:
					return null
			}

			out[at + i] = value & 0xff
		}
	}

	return out
}

function xrefStreamEntries(data: Uint8Array, dict: ReadonlyMap<string, PdfValue>): Map<number, XrefEntry> | null {
	const w = dict.get("W")

	if (w?.type !== "array" || w.items.length !== 3) return null

	const widths = w.items.map(item =>
		item.type === "number" && Number.isInteger(item.value) && item.value >= 0 && item.value <= 8 ? item.value : -1
	)

	if (widths.includes(-1)) return null

	const [w0 = 0, w1 = 0, w2 = 0] = widths
	const size = dictNumber(dict, "Size")
	const index = dict.get("Index")
	const ranges: number[] = []

	if (index?.type === "array") {
		for (const item of index.items) {
			if (item.type !== "number") return null

			ranges.push(item.value)
		}
	} else if (size !== null) ranges.push(0, size)
	else return null

	const row = w0 + w1 + w2
	const entries = new Map<number, XrefEntry>()
	let at = 0

	for (let r = 0; r + 1 < ranges.length; r += 2) {
		const first = ranges[r] ?? 0
		const count = ranges[r + 1] ?? 0

		if (first < 0 || count < 0 || first + count > MAX_OBJECTS) return null

		for (let i = 0; i < count; i++) {
			if (at + row > data.length) return null

			const type = w0 === 0 ? 1 : field(data, at, w0)
			const second = field(data, at + w0, w1)
			const third = field(data, at + w0 + w1, w2)

			at += row

			if (entries.has(first + i)) continue

			if (type === 0) entries.set(first + i, { type: 0 })
			else if (type === 1) entries.set(first + i, { type: 1, offset: second, gen: third })
			else if (type === 2) entries.set(first + i, { type: 2, stream: second, index: third })
		}
	}

	return entries
}

function field(data: Uint8Array, at: number, width: number): number {
	let value = 0

	for (let i = 0; i < width; i++) value = value * 256 + (data[at + i] ?? 0)

	return value
}

// Whether `end` is a revision's end: "startxref <offset of a section in the chain> %%EOF" with at most one EOL after.
export function endsRevision(tail: Uint8Array, tailStart: number, end: number, chain: XrefChain): boolean {
	let at = end - tailStart

	if (at > 0 && tail[at - 1] === 0x0a) at--
	if (at > 0 && tail[at - 1] === 0x0d) at--

	const eof = asciiBytes("%%EOF")

	if (at < eof.length) return false

	for (let i = 0; i < eof.length; i++) if (tail[at - eof.length + i] !== eof[i]) return false

	const keyword = lastIndexOf(tail, STARTXREF, at - eof.length)

	if (keyword < 0) return false

	const lexer = new PdfLexer(tail, keyword + STARTXREF.length)
	const offset = lexer.integer()
	let after = lexer.position

	while (after < tail.length && isWhite(tail[after] ?? 0)) after++

	if (offset === null || after !== at - eof.length) return false

	return chain.sections.some(section => section.offset === offset)
}

// True when every byte in the run is PDF whitespace.
export function onlyWhitespace(bytes: Uint8Array): boolean {
	for (const byte of bytes) if (!isWhite(byte)) return false

	return true
}
