import { decodeUtf32, isMultiByteLegacy, readBom } from "@filen/shared/textEncoding"

// A text file too large to hold, laid out in rows straight from its bytes: every position is a byte offset, a row never
// holds more than ROW_MAX_UNITS UTF-16 units however long its line is, and finding where a row starts reads at most
// LINE_SEARCH_BYTES around it. So a jump anywhere in a file with no line breaks at all reads the block it lands in (and
// at most the one beside it), never the line from its start.

// A row's longest text; a longer line goes on in continuation rows.
export const ROW_MAX_UNITS = 4096

// How far back a line start is looked for before a row is anchored inside its line instead.
export const LINE_SEARCH_BYTES = 64 * 1024

// A byte below this never continues a character in a multi-byte legacy encoding (their trail bytes are 0x40 and up,
// GB18030's four-byte digits 0x30–0x39), so the byte after one starts a character.
const LEGACY_SAFE_BYTE = 0x30

const LF = 0x0a
const CR = 0x0d

export type PagerEncodingKind = "utf8" | "utf16" | "utf32" | "single" | "multi"

export interface PagerEncoding {
	// WHATWG name.
	readonly label: string
	readonly kind: PagerEncodingKind
	// Bytes per code unit: 2 for UTF-16, 4 for UTF-32, else 1.
	readonly unit: 1 | 2 | 4
	readonly littleEndian: boolean
	// Where the text starts: past a byte order mark.
	readonly start: number
	// The line break: LF (CRLF files too, their CR dropped from the row), or CR in a file broken by CR alone.
	readonly newline: typeof LF | typeof CR
}

// The bytes the file starts with: its byte order mark (skipped whatever it is read as, as a forced reading skips a mark
// of another encoding) and its line break, by the first break the head holds.
export function pagerEncoding(label: string, head: Uint8Array): PagerEncoding {
	const lowered = label.toLowerCase()
	const kind: PagerEncodingKind =
		lowered === "utf-8"
			? "utf8"
			: lowered.startsWith("utf-16")
				? "utf16"
				: lowered.startsWith("utf-32")
					? "utf32"
					: isMultiByteLegacy(lowered)
						? "multi"
						: "single"
	const base = {
		label: lowered,
		kind,
		unit: kind === "utf16" ? 2 : kind === "utf32" ? 4 : 1,
		littleEndian: !lowered.endsWith("be"),
		start: readBom(head)?.length ?? 0,
		newline: LF
	} as const satisfies PagerEncoding

	return nextBreak(head, 0, base.start, head.length, base) === -1 &&
		nextBreak(head, 0, base.start, head.length, { ...base, newline: CR }) !== -1
		? { ...base, newline: CR }
		: base
}

// The bytes of a file by range: from the block cache, so a read inside one resident block is a view and costs nothing.
export interface PagerSource {
	readonly size: number
	read(start: number, end: number): Uint8Array | Promise<Uint8Array>
}

export interface PagerRow {
	readonly start: number
	// Where the next row starts: past this row's line break, or where a long line was cut.
	readonly end: number
	// Without its line break (and a CRLF's CR).
	readonly text: string
	// Starts inside a line: a long line's later part, or a row a jump anchored where no line start was near.
	readonly continuation: boolean
	// Ends with a line break: the next row starts a line.
	readonly breaks: boolean
}

// A row's longest byte span: ROW_MAX_UNITS units at most, since no byte of UTF-8 or a legacy encoding decodes to more
// than one unit, and four UTF-32 bytes to at most two.
export function rowByteCap(encoding: PagerEncoding): number {
	return encoding.unit === 1 ? ROW_MAX_UNITS : ROW_MAX_UNITS * 2
}

// The byte of a unit that carries the break's value: the first in little-endian, the last in big-endian.
function significant(encoding: PagerEncoding): number {
	return encoding.littleEndian ? 0 : encoding.unit - 1
}

// Whether the unit at `at` (an index into `bytes`, which starts at file offset `base`) is aligned and holds nothing but
// the break.
function isBreakUnit(bytes: Uint8Array, base: number, at: number, encoding: PagerEncoding): boolean {
	if (encoding.unit === 1) {
		return true
	}

	if ((base + at - encoding.start) % encoding.unit !== 0 || at < 0 || at + encoding.unit > bytes.length) {
		return false
	}

	const keep = significant(encoding)

	for (let k = 0; k < encoding.unit; k++) {
		if (k !== keep && bytes[at + k] !== 0) {
			return false
		}
	}

	return true
}

// The file offset of the first line break whose unit starts in [from, to), or -1. `bytes` start at file offset `base`.
export function nextBreak(bytes: Uint8Array, base: number, from: number, to: number, encoding: PagerEncoding): number {
	const keep = significant(encoding)
	const last = Math.min(to - base, bytes.length - encoding.unit + 1)
	let index = Math.max(0, from - base) + keep

	while (index - keep < last) {
		const found = bytes.indexOf(encoding.newline, index)

		if (found === -1 || found - keep >= last) {
			return -1
		}

		if (isBreakUnit(bytes, base, found - keep, encoding)) {
			return base + found - keep
		}

		index = found + 1
	}

	return -1
}

// The file offset of the last line break whose unit starts in [from, to), or -1.
export function previousBreak(bytes: Uint8Array, base: number, from: number, to: number, encoding: PagerEncoding): number {
	const keep = significant(encoding)
	const first = Math.max(0, from - base)
	let index = Math.min(to - base, bytes.length - encoding.unit + 1) - 1 + keep

	while (index - keep >= first) {
		const found = bytes.lastIndexOf(encoding.newline, index)

		if (found === -1 || found - keep < first) {
			return -1
		}

		if (isBreakUnit(bytes, base, found - keep, encoding)) {
			return base + found - keep
		}

		index = found - 1
	}

	return -1
}

// A multi-byte legacy character's length from its first byte (lead-byte rules; a malformed one costs at most a
// one-character glitch where a row is cut).
export function legacyCharLength(bytes: Uint8Array, at: number, label: string): number {
	const lead = bytes[at] ?? 0

	if (lead < 0x80) {
		return 1
	}

	switch (label) {
		case "shift_jis":
			return (lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc) ? 2 : 1
		case "euc-jp":
			return lead === 0x8f ? 3 : lead === 0x8e || (lead >= 0xa1 && lead <= 0xfe) ? 2 : 1
		case "gb18030":
		case "gbk": {
			if (lead === 0x80 || lead === 0xff) {
				return 1
			}

			const next = bytes[at + 1] ?? 0

			return next >= 0x30 && next <= 0x39 ? 4 : 2
		}
		default:
			return lead >= 0x81 && lead <= 0xfe ? 2 : 1
	}
}

// How many bytes a UTF-8 sequence starting with `lead` takes; 1 for ASCII and a byte that starts none.
function utf8Length(lead: number): number {
	return lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1
}

function isContinuation(byte: number): boolean {
	return byte >= 0x80 && byte <= 0xbf
}

// The last character boundary at or before `at` in `bytes`, whose first byte starts a character; `at` itself when none
// is found after the first byte (a malformed run: a one-character glitch beats an empty row).
export function boundaryBefore(bytes: Uint8Array, at: number, encoding: PagerEncoding): number {
	switch (encoding.kind) {
		case "single":
			return at
		case "utf32":
			return at - (at % 4)
		case "utf16": {
			const aligned = at - (at % 2)
			const high = bytes[aligned - (encoding.littleEndian ? 1 : 2)] ?? 0

			// Never between the halves of a surrogate pair.
			return aligned >= 4 && high >= 0xd8 && high <= 0xdb ? aligned - 2 : aligned
		}
		case "utf8": {
			for (let lead = at - 1; lead >= Math.max(0, at - 4); lead--) {
				const byte = bytes[lead] ?? 0

				if (!isContinuation(byte)) {
					return lead + utf8Length(byte) <= at || lead === 0 ? at : lead
				}
			}

			return at
		}
		case "multi": {
			let index = 0

			while (index < at) {
				const length = legacyCharLength(bytes, index, encoding.label)

				if (index + length > at) {
					break
				}

				index += length
			}

			return index > 0 ? index : at
		}
	}
}

const decoders = new Map<string, TextDecoder>()

// Bytes that start and end on character boundaries, as text. A byte order mark is never in them, so a U+FEFF is text.
export function decodeSpan(bytes: Uint8Array, encoding: PagerEncoding): string {
	if (encoding.kind === "utf32") {
		return decodeUtf32(bytes, encoding.littleEndian, false).text
	}

	let decoder = decoders.get(encoding.label)

	if (decoder === undefined) {
		decoder = new TextDecoder(encoding.label, { ignoreBOM: true })
		decoders.set(encoding.label, decoder)
	}

	return decoder.decode(bytes)
}

// The row starting at `start` (a row boundary), within [start, limit).
export async function rowAt(
	source: PagerSource,
	encoding: PagerEncoding,
	start: number,
	continuation: boolean,
	limit: number
): Promise<PagerRow> {
	const cap = rowByteCap(encoding)
	const bytes = await source.read(start, Math.min(limit, start + cap + encoding.unit))
	// A break right at the cap still ends this row, so a cut never leaves an empty row before a break.
	const found = nextBreak(bytes, start, start, Math.min(limit - encoding.unit + 1, start + cap + 1), encoding)

	if (found !== -1) {
		const text = decodeSpan(bytes.subarray(0, found - start), encoding)

		return {
			start,
			end: found + encoding.unit,
			text: encoding.newline === LF && text.endsWith("\r") ? text.slice(0, -1) : text,
			continuation,
			breaks: true
		}
	}

	const end = limit - start <= cap ? limit : start + boundaryBefore(bytes, cap, encoding)

	return { start, end, text: decodeSpan(bytes.subarray(0, end - start), encoding), continuation, breaks: false }
}

// Up to `count` rows from `start` on, within [start, limit).
export async function rowsFrom(
	source: PagerSource,
	encoding: PagerEncoding,
	start: number,
	continuation: boolean,
	count: number,
	limit: number
): Promise<PagerRow[]> {
	const rows: PagerRow[] = []
	let at = start
	let inLine = continuation

	while (rows.length < count && at < limit) {
		const row = await rowAt(source, encoding, at, inLine, limit)

		rows.push(row)
		at = row.end
		inLine = !row.breaks
	}

	return rows
}

// The start of the line holding the byte at `at`: past the last break before it within LINE_SEARCH_BYTES, the text's
// start when that reach gets there, else null (a line too long to look back through).
export async function lineStartOf(source: PagerSource, encoding: PagerEncoding, at: number): Promise<number | null> {
	if (at <= encoding.start) {
		return encoding.start
	}

	const from = Math.max(encoding.start, at - LINE_SEARCH_BYTES)
	const bytes = await source.read(from, at)
	const found = previousBreak(bytes, from, from, at - encoding.unit + 1, encoding)

	if (found !== -1) {
		return found + encoding.unit
	}

	return from === encoding.start ? encoding.start : null
}

// A character boundary at or just after `at`: aligned to the unit, past UTF-8 continuation bytes and a UTF-16 low
// surrogate, and in a multi-byte legacy encoding past the next byte that cannot continue a character (within
// LINE_SEARCH_BYTES; else `at`, a one-character glitch).
export async function boundaryAt(source: PagerSource, encoding: PagerEncoding, at: number): Promise<number> {
	const target = Math.min(Math.max(at, encoding.start), source.size)
	const aligned = target - ((target - encoding.start) % encoding.unit)

	if (encoding.kind === "single" || encoding.kind === "utf32" || aligned >= source.size) {
		return aligned
	}

	if (encoding.kind === "utf16") {
		const unit = await source.read(aligned, Math.min(source.size, aligned + 2))
		const high = unit[encoding.littleEndian ? 1 : 0] ?? 0

		return high >= 0xdc && high <= 0xdf ? aligned + 2 : aligned
	}

	if (encoding.kind === "utf8") {
		const bytes = await source.read(aligned, Math.min(source.size, aligned + 4))
		let skip = 0

		while (skip < 3 && skip < bytes.length && isContinuation(bytes[skip] ?? 0)) {
			skip++
		}

		return aligned + skip
	}

	const from = Math.max(encoding.start, aligned - 1)
	const bytes = await source.read(from, Math.min(source.size, aligned + LINE_SEARCH_BYTES))

	for (let index = 0; index < bytes.length; index++) {
		if ((bytes[index] ?? 0) < LEGACY_SAFE_BYTE && from + index + 1 >= aligned) {
			return from + index + 1
		}
	}

	return aligned
}

export interface LocatedRow {
	readonly start: number
	readonly continuation: boolean
}

// The row holding the byte at `at`: laid out from its line's start when that is within LINE_SEARCH_BYTES (so it is the
// row scrolling would show), else anchored at a character boundary there as a continuation.
export async function locateRow(source: PagerSource, encoding: PagerEncoding, at: number): Promise<LocatedRow> {
	if (at <= encoding.start) {
		return { start: encoding.start, continuation: false }
	}

	if (at >= source.size) {
		const [last] = await rowsBefore(source, encoding, source.size, 1)

		return last ?? { start: encoding.start, continuation: false }
	}

	const boundary = await boundaryAt(source, encoding, at)

	if (boundary >= source.size) {
		return await locateRow(source, encoding, source.size)
	}

	const line = await lineStartOf(source, encoding, boundary)

	if (line === null) {
		return { start: boundary, continuation: true }
	}

	let start = line
	let continuation = false

	for (;;) {
		const row = await rowAt(source, encoding, start, continuation, source.size)

		if (row.end > boundary || row.end >= source.size) {
			return { start: row.start, continuation: row.continuation }
		}

		start = row.end
		continuation = !row.breaks
	}
}

// Up to `count` rows ending exactly at `end` (a row boundary), in order. Each step back reads at most LINE_SEARCH_BYTES:
// one line from its start, or a continuation stretch of a line too long to look through.
export async function rowsBefore(source: PagerSource, encoding: PagerEncoding, end: number, count: number): Promise<PagerRow[]> {
	const stretches: PagerRow[][] = []
	let collected = 0
	let until = end

	while (collected < count && until > encoding.start) {
		const line = await lineStartOf(source, encoding, until - encoding.unit)
		let anchor = line ?? (await boundaryAt(source, encoding, until - LINE_SEARCH_BYTES))

		// A legacy boundary is looked for forwards: never past where this stretch ends.
		if (anchor >= until) {
			anchor = until - LINE_SEARCH_BYTES
		}

		const rows = await rowsFrom(source, encoding, anchor, line === null && anchor > encoding.start, Number.POSITIVE_INFINITY, until)

		stretches.push(rows)
		collected += rows.length
		until = anchor
	}

	return stretches.reverse().flat().slice(-count)
}
