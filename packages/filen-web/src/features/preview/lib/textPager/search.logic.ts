import { readStretches, type PagerScanSource } from "@/features/preview/lib/textPager/index.logic"
import { decodeSpan, legacyCharLength, type PagerEncoding } from "@/features/preview/lib/textPager/rows.logic"

// Find in a text file too large to hold: the file is read once from its start in block-aligned stretches past the
// cache, one in flight ahead, and decoded as a stream (a character cut by a stretch's end is finished by the next).
// Each stretch's text is searched alone; a match across two stretches is found in the previous text's last
// `query.length - 1` units joined to the start of the next. At most MATCH_CAP matches are kept, as their byte offsets and
// line numbers (160 KB); the text is never kept, and nothing but a stretch and its text is held while it is searched.

export const MATCH_CAP = 10_000

export type { PagerScanSource } from "@/features/preview/lib/textPager/index.logic"

export class MatchList {
	private readonly offsets = new Float64Array(MATCH_CAP)
	private readonly lines = new Float64Array(MATCH_CAP)
	private length = 0
	private overflowed = false

	public get count(): number {
		return this.length
	}

	// A match past the cap was found: there are more than `count`. Exactly MATCH_CAP of them is not capped.
	public get capped(): boolean {
		return this.overflowed
	}

	// false once full.
	public push(offset: number, line: number): boolean {
		if (this.length === MATCH_CAP) {
			this.overflowed = true

			return false
		}

		this.offsets[this.length] = offset
		this.lines[this.length] = line
		this.length++

		return true
	}

	public at(index: number): { offset: number; line: number } | null {
		return index < 0 || index >= this.length ? null : { offset: this.offsets[index] ?? 0, line: this.lines[index] ?? 1 }
	}

	// The first match at or after `offset`, else -1.
	public firstFrom(offset: number): number {
		let low = 0
		let high = this.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((this.offsets[middle] ?? 0) < offset) low = middle + 1
			else high = middle
		}

		return low < this.length ? low : -1
	}
}

// Bytes read so far, as the decoder took them: a few kept from the previous stretch (the units a match across it may
// start in, and a character it cut) and the stretch itself, so neither is ever copied into the other.
interface Segment {
	readonly base: number
	readonly bytes: Uint8Array
}

// A legacy run decoded at once while walking to a match.
const LEGACY_RUN_BYTES = 4096

// Where each decoded unit came from: walks bytes as the decoder did, so a match's unit index becomes its byte offset.
// Exact for UTF-8 (WHATWG's maximal-subpart error handling), UTF-16, UTF-32, single-byte encodings and legacy ones
// (counted by decoding their characters); a malformed legacy sequence may shift offsets until the stretch ends. Units
// count from the first segment's start.
class UnitWalker {
	private unit = 0
	private byte: number
	private readonly segments: readonly Segment[]
	private readonly end: number
	private readonly encoding: PagerEncoding

	public constructor(segments: readonly Segment[], encoding: PagerEncoding) {
		const last = segments.at(-1)

		this.segments = segments
		this.byte = segments[0]?.base ?? 0
		this.end = last === undefined ? this.byte : last.base + last.bytes.length
		this.encoding = encoding
	}

	// The file offset where unit `target` starts; targets never decrease.
	public to(target: number): number {
		const { encoding } = this
		const origin = this.segments[0]?.base ?? 0

		if (encoding.kind === "single") {
			return origin + target
		}

		if (encoding.kind === "utf16") {
			return origin + target * 2
		}

		if (encoding.kind === "multi") {
			return this.legacyTo(target)
		}

		while (this.unit < target && this.byte < this.end) {
			const [length, units] = encoding.kind === "utf32" ? this.utf32Step() : utf8Step(at => this.byteAt(at), this.byte)

			this.byte += length
			this.unit += units
		}

		return this.byte
	}

	private byteAt(at: number): number | undefined {
		for (const segment of this.segments) {
			if (at >= segment.base && at < segment.base + segment.bytes.length) {
				return segment.bytes[at - segment.base]
			}
		}

		return undefined
	}

	// Bytes [from, to): a view inside one segment, a copy (of a character or so) across two.
	private span(from: number, to: number): Uint8Array {
		for (const segment of this.segments) {
			if (from >= segment.base && to <= segment.base + segment.bytes.length) {
				return segment.bytes.subarray(from - segment.base, to - segment.base)
			}
		}

		const out = new Uint8Array(Math.max(0, Math.min(to, this.end) - from))

		for (let index = 0; index < out.length; index++) out[index] = this.byteAt(from + index) ?? 0

		return out
	}

	private segmentEnd(at: number): number {
		const segment = this.segments.find(each => at >= each.base && at < each.base + each.bytes.length)

		return segment === undefined ? this.end : segment.base + segment.bytes.length
	}

	private utf32Step(): [number, number] {
		const bytes = this.span(this.byte, this.byte + 4)
		const point = bytes.length < 4 ? 0 : new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, this.encoding.littleEndian)

		return [4, point > 0xffff && point <= 0x10ffff ? 2 : 1]
	}

	// A legacy character may decode to two units (GB18030 and Big5 HKSCS past the Basic Multilingual Plane, Big5's
	// pointers that give two code points), so units are counted by decoding: a run of characters inside one segment at a
	// time, then one character at a time inside the run that holds the target.
	private legacyTo(target: number): number {
		const { encoding } = this
		const charLength = (at: number): number => legacyCharLength(this.span(at, at + 2), 0, encoding.label)

		while (this.unit < target && this.byte < this.end) {
			const limit = Math.min(this.segmentEnd(this.byte), this.byte + LEGACY_RUN_BYTES)
			let end = this.byte

			while (end < limit && end + charLength(end) <= limit) end += charLength(end)

			const units = end > this.byte ? decodeSpan(this.span(this.byte, end), encoding).length : 0

			if (end > this.byte && this.unit + units <= target) {
				this.byte = end
				this.unit += units

				continue
			}

			// The target is inside the run, or a character straddles two segments: one character at a time.
			const stop = Math.max(end, this.byte + 1)

			while (this.unit < target && this.byte < stop) {
				const length = charLength(this.byte)

				this.unit += decodeSpan(this.span(this.byte, this.byte + length), encoding).length
				this.byte += length
			}
		}

		return this.byte
	}
}

// One UTF-8 decoder step at `at`: a valid sequence, or the bytes one U+FFFD stands for (the maximal subpart of a
// sequence; the byte that broke it starts the next step).
function utf8Step(byteAt: (at: number) => number | undefined, at: number): [number, number] {
	const lead = byteAt(at) ?? 0
	let needed: number
	let lower = 0x80
	let upper = 0xbf

	if (lead < 0x80) {
		return [1, 1]
	} else if (lead >= 0xc2 && lead <= 0xdf) {
		needed = 1
	} else if (lead >= 0xe0 && lead <= 0xef) {
		needed = 2
		lower = lead === 0xe0 ? 0xa0 : 0x80
		upper = lead === 0xed ? 0x9f : 0xbf
	} else if (lead >= 0xf0 && lead <= 0xf4) {
		needed = 3
		lower = lead === 0xf0 ? 0x90 : 0x80
		upper = lead === 0xf4 ? 0x8f : 0xbf
	} else {
		return [1, 1]
	}

	for (let seen = 1; seen <= needed; seen++) {
		const next = byteAt(at + seen)

		if (next === undefined || next < lower || next > upper) {
			return [seen, 1]
		}

		lower = 0x80
		upper = 0xbf
	}

	return [needed + 1, needed === 3 ? 2 : 1]
}

function countChar(text: string, char: string, from: number, to: number): number {
	let count = 0
	let at = text.indexOf(char, from)

	while (at !== -1 && at < to) {
		count++
		at = text.indexOf(char, at + 1)
	}

	return count
}

export function searchPattern(query: string, caseSensitive: boolean): RegExp {
	return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu")
}

export interface SearchOptions {
	readonly source: PagerScanSource
	readonly encoding: PagerEncoding
	readonly query: string
	readonly caseSensitive: boolean
	readonly matches: MatchList
	readonly signal: AbortSignal
	// Each stretch as read, in file order from the text's start (the line index counts them).
	readonly onBytes?: (bytes: Uint8Array, base: number) => void
	// After each stretch: how far the file is read.
	readonly onProgress?: (scanned: number) => void
}

export type SearchEnd = "done" | "capped" | "stopped"

// Decodes stretches in order as one stream.
function streamDecoder(encoding: PagerEncoding): (bytes: Uint8Array, last: boolean) => string {
	if (encoding.kind === "utf32") {
		// Stretches end on unit boundaries (the text starts on one, stretches are block-aligned): each decodes alone.
		return bytes => decodeSpan(bytes.subarray(0, bytes.length - (bytes.length % 4)), encoding)
	}

	const decoder = new TextDecoder(encoding.label, { ignoreBOM: true })

	return (bytes, last) => decoder.decode(bytes, { stream: !last })
}

// Fills `matches` with every match of `query` (no line breaks in it) from the text's start, in file order.
export async function searchText(options: SearchOptions): Promise<SearchEnd> {
	const { source, encoding, query, matches, signal } = options
	const pattern = searchPattern(query, options.caseSensitive)
	const newline = String.fromCharCode(encoding.newline)
	const decode = streamDecoder(encoding)
	// The previous text's last units, where a match across the stretches may start, and the bytes they and a character
	// the decoder still holds came from; breaks before them.
	let carry = ""
	let kept: Segment = { base: encoding.start, bytes: new Uint8Array(0) }
	let lines = 0

	for await (const { bytes, base } of readStretches(source, encoding.start, signal)) {
		options.onBytes?.(bytes, base)

		const last = base + bytes.length >= source.size
		const text = decode(bytes, last)
		const walker = new UnitWalker([kept, { base, bytes }], encoding)
		// Units before `text`: the carry's.
		const offset = carry.length
		let counted = 0
		let breaks = lines

		const take = (index: number): boolean => {
			breaks += countChar(text, newline, counted, Math.max(counted, index - offset))
			counted = Math.max(counted, index - offset)

			return matches.push(walker.to(index), breaks + 1)
		}

		// Across the two stretches: matches starting in the carry, found in it joined to the text's first units.
		if (carry.length > 0) {
			const joined = carry + text.slice(0, query.length - 1)

			for (const match of joined.matchAll(pattern)) {
				if (match.index < offset && match.index + match[0].length > offset && !take(match.index)) {
					return "capped"
				}
			}
		}

		for (const match of text.matchAll(pattern)) {
			if (!take(offset + match.index)) {
				return "capped"
			}
		}

		lines = breaks + countChar(text, newline, counted, text.length)

		if (signal.aborted) {
			return "stopped"
		}

		options.onProgress?.(base + bytes.length)

		if (last) {
			break
		}

		// The units a match across the next stretch could start in; never the low half of a surrogate pair.
		let keep = Math.max(0, text.length - (query.length - 1))

		if (keep > 0 && keep < text.length && (text.charCodeAt(keep) & 0xfc00) === 0xdc00) {
			keep--
		}

		const from = walker.to(offset + keep)

		carry = text.slice(keep)
		kept = { base: from, bytes: from >= base ? bytes.slice(from - base) : concatTail(kept, bytes, from) }
	}

	return matches.capped ? "capped" : "done"
}

// Bytes from `from` (inside the kept bytes) to the stretch's end: only when a query outlasts a whole stretch's text.
function concatTail(kept: Segment, bytes: Uint8Array, from: number): Uint8Array {
	const head = kept.bytes.subarray(from - kept.base)
	const out = new Uint8Array(head.length + bytes.length)

	out.set(head)
	out.set(bytes, head.length)

	return out
}
