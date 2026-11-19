import { readExactly, type PdfByteSource } from "./source"
import { asciiBytes, decodeHex, isWhite } from "./syntax"

// The integrity rules of a signature's /ByteRange, checked on the raw bytes. They close the known gaps between what a
// signature covers and what a reader shows (signature wrapping, shadowed dictionaries): the only bytes left out are
// the hex string of /Contents, and the signed bytes end where a revision ends.

export type ByteRange = readonly [number, number, number, number]

// Largest /Contents accepted: real signatures with chains and timestamps stay far below it.
const MAX_CONTENTS_BYTES = 1024 * 1024
const CONTENTS_KEY = asciiBytes("/Contents")
const KEY_WINDOW = 64

// Exactly four integers: 0, the gap's start, the gap's end, and what follows it, all inside the file.
export function parseByteRange(values: readonly unknown[], fileLength: number): ByteRange | null {
	if (values.length !== 4) return null

	const numbers: number[] = []

	for (const value of values) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null

		numbers.push(value)
	}

	const [start = -1, length1 = 0, start2 = 0, length2 = 0] = numbers

	if (start !== 0 || length1 < 1 || start2 <= length1 + 1 || length2 < 1 || start2 + length2 > fileLength) return null

	return [start, length1, start2, length2]
}

// The signed revision ends where the second range ends.
export function signedEnd(range: ByteRange): number {
	return range[2] + range[3]
}

// The DER-encoded signature from the gap, when the gap is exactly `<hex>` following the /Contents key; otherwise null.
export async function readContentsGap(source: PdfByteSource, range: ByteRange): Promise<Uint8Array | null> {
	const gapStart = range[1]
	const gapEnd = range[2]

	if (gapEnd - gapStart - 2 > MAX_CONTENTS_BYTES * 2) return null

	const before = Math.max(0, gapStart - KEY_WINDOW)
	const bytes = await readExactly(source, before, gapEnd - before)
	const lt = gapStart - before

	if (bytes[lt] !== 0x3c || bytes[bytes.length - 1] !== 0x3e) return null

	let key = lt

	while (key > 0 && isWhite(bytes[key - 1] ?? 0)) key--

	if (key < CONTENTS_KEY.length) return null

	for (let i = 0; i < CONTENTS_KEY.length; i++) if (bytes[key - CONTENTS_KEY.length + i] !== CONTENTS_KEY[i]) return null

	// The key itself starts after whitespace or a delimiter, so it is a whole name.
	const previous = bytes[key - CONTENTS_KEY.length - 1]

	if (
		previous !== undefined &&
		!isWhite(previous) &&
		previous !== 0x3c &&
		previous !== 0x3e &&
		previous !== 0x2f &&
		previous !== 0x5d &&
		previous !== 0x29
	)
		return null

	const hex = decodeHex(bytes.subarray(lt + 1, bytes.length - 1))

	return hex === null ? null : trimDer(hex)
}

// The DER object at the start of the zero-padded /Contents value, or null when it is malformed or followed by anything
// but padding. An indefinite-length (BER) object, as BouncyCastle-based signers write, is walked to the end-of-contents
// octets that close it: the padding cannot be told apart from those octets, so its end is never searched for.
export function trimDer(bytes: Uint8Array): Uint8Array | null {
	if (bytes[0] !== 0x30 || bytes.length < 2) return null

	const first = bytes[1] ?? 0
	let length: number
	let header: number

	if (first === 0x80) {
		const end = indefiniteEnd(bytes)

		if (end === null) return null

		for (let i = end; i < bytes.length; i++) if (bytes[i] !== 0) return null

		return bytes.subarray(0, end)
	} else if (first < 0x80) {
		length = first
		header = 2
	} else {
		const count = first & 0x7f

		if (count === 0 || count > 4 || bytes.length < 2 + count) return null

		length = 0

		for (let i = 0; i < count; i++) length = length * 256 + (bytes[2 + i] ?? 0)

		header = 2 + count
	}

	const end = header + length

	if (end > bytes.length) return null

	for (let i = end; i < bytes.length; i++) if (bytes[i] !== 0) return null

	return bytes.subarray(0, end)
}

// Deepest nesting of indefinite-length objects walked; CMS needs a handful.
const MAX_BER_DEPTH = 32

// The end of the indefinite-length object at the start of `bytes`: definite-length children are skipped by their
// length, indefinite ones entered, until the end-of-contents octets that close the outer object. Null when anything
// runs past the buffer.
function indefiniteEnd(bytes: Uint8Array): number | null {
	let at = 0
	let depth = 0

	for (;;) {
		if (depth > 0 && bytes[at] === 0 && bytes[at + 1] === 0) {
			at += 2
			depth--

			if (depth === 0) return at

			continue
		}

		const tag = bytes[at]

		if (tag === undefined) return null

		at++

		// High tag numbers continue while the top bit is set.
		if ((tag & 0x1f) === 0x1f) {
			let octets = 0

			do {
				if (at >= bytes.length || ++octets > 4) return null
			} while (((bytes[at++] ?? 0) & 0x80) !== 0)
		}

		const first = bytes[at]

		if (first === undefined) return null

		at++

		if (first === 0x80) {
			// Only constructed encodings may be indefinite.
			if ((tag & 0x20) === 0 || ++depth > MAX_BER_DEPTH) return null

			continue
		}

		let length = first

		if (first > 0x80) {
			const count = first & 0x7f

			if (count > 4 || at + count > bytes.length) return null

			length = 0

			for (let i = 0; i < count; i++) length = length * 256 + (bytes[at + i] ?? 0)

			at += count
		}

		at += length

		if (at > bytes.length) return null
		if (depth === 0) return at
	}
}
