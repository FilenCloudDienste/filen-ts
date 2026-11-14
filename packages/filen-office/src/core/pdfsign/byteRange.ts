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
// but padding.
export function trimDer(bytes: Uint8Array): Uint8Array | null {
	if (bytes[0] !== 0x30 || bytes.length < 2) return null

	const first = bytes[1] ?? 0
	let length: number
	let header: number

	if (first < 0x80) {
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
