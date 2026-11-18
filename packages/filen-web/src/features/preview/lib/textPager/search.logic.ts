import { SCAN_BYTES, type PagerScanSource } from "@/features/preview/lib/textPager/index.logic"
import {
	boundaryBefore,
	decodeSpan,
	legacyCharLength,
	previousBreak,
	type PagerEncoding
} from "@/features/preview/lib/textPager/rows.logic"

// Find in a text file too large to hold: the file is read once from its start in block-aligned stretches past the
// cache, each decoded up to its last line break (the rest is searched with the next stretch). A stretch with no break
// at all (a line longer than a stretch) is searched up to a character boundary and keeps only the last
// `query.length - 1` units for the next, so a match across the cut is found once. At most MATCH_CAP matches are kept,
// as their byte offsets and line numbers (160 KB); the text is never kept.

export const MATCH_CAP = 10_000

export type { PagerScanSource } from "@/features/preview/lib/textPager/index.logic"

export class MatchList {
	private readonly offsets = new Float64Array(MATCH_CAP)
	private readonly lines = new Float64Array(MATCH_CAP)
	private length = 0

	public get count(): number {
		return this.length
	}

	public get capped(): boolean {
		return this.length === MATCH_CAP
	}

	// false once full.
	public push(offset: number, line: number): boolean {
		if (this.length === MATCH_CAP) {
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

// Where each decoded unit came from: walks bytes as the decoder did, so a match's unit index becomes its byte offset.
// Exact for UTF-8 (WHATWG's maximal-subpart error handling), UTF-16, UTF-32 and single-byte encodings; a malformed
// multi-byte legacy sequence may shift offsets until the stretch ends.
class UnitWalker {
	private unit = 0
	private byte = 0
	private readonly bytes: Uint8Array
	private readonly encoding: PagerEncoding

	public constructor(bytes: Uint8Array, encoding: PagerEncoding) {
		this.bytes = bytes
		this.encoding = encoding
	}

	// The byte where unit `target` starts; targets never decrease.
	public to(target: number): number {
		const { encoding } = this

		if (encoding.kind === "single") {
			return target
		}

		if (encoding.kind === "utf16") {
			return target * 2
		}

		while (this.unit < target && this.byte < this.bytes.length) {
			const [length, units] = this.step()

			this.byte += length
			this.unit += units
		}

		return this.byte
	}

	// The next character's bytes and the units it decodes to.
	private step(): [number, number] {
		const { bytes, byte, encoding } = this

		if (encoding.kind === "utf32") {
			const point =
				byte + 4 > bytes.length ? 0 : new DataView(bytes.buffer, bytes.byteOffset + byte, 4).getUint32(0, encoding.littleEndian)

			return [4, point > 0xffff && point <= 0x10ffff ? 2 : 1]
		}

		if (encoding.kind === "multi") {
			const length = legacyCharLength(bytes, byte, encoding.label)

			// GB18030's four-byte sequences from 0x90 on are past the Basic Multilingual Plane.
			return [length, length === 4 && (bytes[byte] ?? 0) >= 0x90 ? 2 : 1]
		}

		return utf8Step(bytes, byte)
	}
}

// One UTF-8 decoder step: a valid sequence, or the bytes one U+FFFD stands for (the maximal subpart of a sequence; the
// byte that broke it starts the next step).
function utf8Step(bytes: Uint8Array, at: number): [number, number] {
	const lead = bytes[at] ?? 0
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
		const next = bytes[at + seen]

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

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
	const out = new Uint8Array(head.length + tail.length)

	out.set(head)
	out.set(tail, head.length)

	return out
}

// Fills `matches` with every match of `query` (no line breaks in it) from the text's start, in file order.
export async function searchText(options: SearchOptions): Promise<SearchEnd> {
	const { source, encoding, query, matches, signal } = options
	const pattern = searchPattern(query, options.caseSensitive)
	const newline = String.fromCharCode(encoding.newline)
	// Bytes before `at` not searched yet: a line's start, or a long line's last few units.
	let carry: Uint8Array | null = null
	let at = encoding.start
	// Breaks before the stretch.
	let lines = 0

	while (at < source.size) {
		if (signal.aborted) {
			return "stopped"
		}

		const end = Math.min(source.size, (Math.floor(at / SCAN_BYTES) + 1) * SCAN_BYTES)
		// Rejects once `signal` aborts.
		const read = await source.scan(at, end, signal)

		options.onBytes?.(read, at)

		const bytes: Uint8Array = carry === null ? read : concat(carry, read)
		const base: number = at - (carry === null ? 0 : carry.length)
		const last = end >= source.size
		const lastBreak: number = last ? -1 : previousBreak(bytes, base, base, base + bytes.length, encoding)
		const cut: number = last
			? bytes.length
			: lastBreak !== -1
				? lastBreak - base + encoding.unit
				: boundaryBefore(bytes, bytes.length, encoding)
		const text = decodeSpan(bytes.subarray(0, cut), encoding)
		const walker = new UnitWalker(bytes, encoding)
		let counted = 0

		pattern.lastIndex = 0

		for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
			lines += countChar(text, newline, counted, match.index)
			counted = match.index

			if (!matches.push(base + walker.to(match.index), lines + 1)) {
				return "capped"
			}
		}

		lines += countChar(text, newline, counted, text.length)

		if (last) {
			break
		}

		if (lastBreak !== -1) {
			carry = bytes.slice(cut)
		} else {
			// The units a match across the cut could start in; never the low half of a surrogate pair.
			let keep = Math.max(0, text.length - (query.length - 1))

			if (keep > 0 && keep < text.length && (text.charCodeAt(keep) & 0xfc00) === 0xdc00) {
				keep--
			}

			carry = bytes.slice(walker.to(keep))
		}

		at = end
		options.onProgress?.(end)
	}

	return matches.capped ? "capped" : "done"
}
