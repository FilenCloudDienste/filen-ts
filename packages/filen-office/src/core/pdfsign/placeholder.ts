import type { ByteRange } from "./byteRange"
import { asciiBytes, indexOf, isWhite } from "./syntax"

// The placeholder a signature is written with and patched in place afterwards. /ByteRange holds 10-digit sentinels,
// so the patched values (offsets in a file under 10 GB) always fit in the space they leave; /Contents is a hex string
// of zeros sized for the signature. Both are found in the revision the signing save appended, inside the signature
// dictionary's own object, and exactly once: anything else (an encrypted /Contents, a sentinel elsewhere) is refused.

// One sentinel value; a writer prints it as is (it fits a 32-bit integer).
export const BYTE_RANGE_SENTINEL = 1234567890

export interface SignaturePlaceholder {
	// Offsets in the file: the `[` and the `]` (exclusive end) of /ByteRange's array.
	readonly byteRangeStart: number
	readonly byteRangeEnd: number
	// The `<` of /Contents and the offset after its `>`: the bytes the signature leaves out.
	readonly contentsStart: number
	readonly contentsEnd: number
}

export class PdfPlaceholderError extends Error {
	override readonly name = "PdfPlaceholderError"
}

const OBJ = asciiBytes(" obj")
const ENDOBJ = asciiBytes("endobj")
const CONTENTS = asciiBytes("/Contents")
const BYTE_RANGE = asciiBytes("/ByteRange")

function isDigit(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x30 && byte <= 0x39
}

function skipWhite(bytes: Uint8Array, at: number, end: number): number {
	let i = at

	while (i < end && isWhite(bytes[i] ?? 0)) i++

	return i
}

// Index of the start of "<num> <gen> obj" for the last definition of object `num` at or after `from`, or -1.
function objectStart(bytes: Uint8Array, num: number, from: number): number {
	const header = asciiBytes(String(num))
	let found = -1
	let at = from

	for (;;) {
		const obj = indexOf(bytes, OBJ, at)

		if (obj < 0) return found

		// Back over " <gen>" and "<num>".
		let i = obj

		while (i > from && isDigit(bytes[i - 1])) i--

		const genStart = i

		while (i > from && isWhite(bytes[i - 1] ?? 0)) i--

		const numEnd = i

		while (i > from && isDigit(bytes[i - 1])) i--

		if (genStart < obj && numEnd < genStart && numEnd - i === header.length && header.every((byte, k) => bytes[i + k] === byte)) {
			if (i === from || isWhite(bytes[i - 1] ?? 0)) found = i
		}

		at = obj + OBJ.length
	}
}

// The /ByteRange array `[0 S S S]` (S the sentinel) at `at`, returning the offset after its `]`, else -1.
function sentinelArray(bytes: Uint8Array, at: number, end: number): number {
	let i = skipWhite(bytes, at, end)

	if (bytes[i] !== 0x5b) return -1

	i = skipWhite(bytes, i + 1, end)

	if (bytes[i] !== 0x30 || isDigit(bytes[i + 1])) return -1

	i++

	const sentinel = asciiBytes(String(BYTE_RANGE_SENTINEL))

	for (let n = 0; n < 3; n++) {
		const next = skipWhite(bytes, i, end)

		if (next === i || !sentinel.every((byte, k) => bytes[next + k] === byte) || isDigit(bytes[next + sentinel.length])) return -1

		i = next + sentinel.length
	}

	i = skipWhite(bytes, i, end)

	return bytes[i] === 0x5d ? i + 1 : -1
}

// Every occurrence of `key` in [start, end) followed by a delimiter (a whole name).
function keyOffsets(bytes: Uint8Array, key: Uint8Array, start: number, end: number): number[] {
	const out: number[] = []
	let at = start

	for (;;) {
		const found = indexOf(bytes, key, at)

		if (found < 0 || found >= end) return out

		const next = bytes[found + key.length] ?? 0

		if (isWhite(next) || next === 0x3c || next === 0x5b || next === 0x2f || next === 0x28) out.push(found)

		at = found + key.length
	}
}

// Finds the placeholder of signature dictionary object `num` in the revision starting at `revisionStart`, whose
// /Contents must be exactly `contentsBytes` zero bytes in hex.
export function locatePlaceholder(bytes: Uint8Array, num: number, revisionStart: number, contentsBytes: number): SignaturePlaceholder {
	const start = objectStart(bytes, num, revisionStart)

	if (start < 0) throw new PdfPlaceholderError("signature object not in the appended revision")

	const end = indexOf(bytes, ENDOBJ, start)

	if (end < 0) throw new PdfPlaceholderError("signature object not closed")

	const ranges = keyOffsets(bytes, BYTE_RANGE, start, end)
	const contents = keyOffsets(bytes, CONTENTS, start, end)

	if (ranges.length !== 1 || contents.length !== 1) throw new PdfPlaceholderError("signature dictionary keys")

	const byteRangeStart = skipWhite(bytes, (ranges[0] ?? 0) + BYTE_RANGE.length, end)
	const byteRangeEnd = sentinelArray(bytes, byteRangeStart, end)

	if (byteRangeEnd < 0) throw new PdfPlaceholderError("ByteRange placeholder")

	const contentsStart = skipWhite(bytes, (contents[0] ?? 0) + CONTENTS.length, end)

	if (bytes[contentsStart] !== 0x3c) throw new PdfPlaceholderError("Contents is not a hex string")

	const hexEnd = contentsStart + 1 + contentsBytes * 2

	// An encrypted or rewritten /Contents is neither all zeros nor this long.
	for (let i = contentsStart + 1; i < hexEnd; i++) if (bytes[i] !== 0x30) throw new PdfPlaceholderError("Contents placeholder")

	if (bytes[hexEnd] !== 0x3e) throw new PdfPlaceholderError("Contents placeholder length")

	return { byteRangeStart, byteRangeEnd, contentsStart, contentsEnd: hexEnd + 1 }
}

export function placeholderRange(placeholder: SignaturePlaceholder, fileLength: number): ByteRange {
	return [0, placeholder.contentsStart, placeholder.contentsEnd, fileLength - placeholder.contentsEnd]
}

// Writes the real /ByteRange over the sentinels, padded with spaces inside the brackets to the same length.
export function patchByteRange(bytes: Uint8Array, placeholder: SignaturePlaceholder): ByteRange {
	const range = placeholderRange(placeholder, bytes.length)
	const width = placeholder.byteRangeEnd - placeholder.byteRangeStart
	const text = `[${range.join(" ")}`

	if (text.length + 1 > width) throw new PdfPlaceholderError("ByteRange does not fit")

	bytes.set(asciiBytes(`${text.padEnd(width - 1, " ")}]`), placeholder.byteRangeStart)

	return range
}

const HEX = asciiBytes("0123456789ABCDEF")

// Writes the signature's DER into /Contents (the rest stays zero padding); false when it does not fit.
export function patchContents(bytes: Uint8Array, placeholder: SignaturePlaceholder, der: Uint8Array): boolean {
	const capacity = (placeholder.contentsEnd - placeholder.contentsStart - 2) >> 1

	if (der.length > capacity) return false

	let at = placeholder.contentsStart + 1

	for (const byte of der) {
		bytes[at++] = HEX[byte >> 4] ?? 0x30
		bytes[at++] = HEX[byte & 15] ?? 0x30
	}

	return true
}
