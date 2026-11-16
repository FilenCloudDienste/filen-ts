import { startsWith, viewOf } from "@/features/preview/lib/imageSniff/bytes"

// JPEG XL (ISO/IEC 18181): a bare codestream starts FF 0A; the container (18181-2) starts with the 12-byte "JXL "
// signature box and carries the codestream in one "jxlc" box or split over "jxlp" boxes (each led by a 4-byte index).
// The codestream's SizeHeader (18181-1 Annex A) follows its signature.

export interface JxlHeader {
	readonly width: number
	readonly height: number
}

export const MAX_JXL_BOXES = 256

const CODESTREAM_SIGNATURE = [0xff, 0x0a]
const CONTAINER_SIGNATURE = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]
const BOX_JXLC = 0x6a786c63
const BOX_JXLP = 0x6a786c70

// Width over height for SizeHeader.ratio 1..7.
const RATIOS: readonly (readonly [number, number])[] = [
	[1, 1],
	[12, 10],
	[4, 3],
	[3, 2],
	[16, 9],
	[5, 4],
	[2, 1]
]

// Least significant bit first within each byte (18181-1 §A.2). The reader returns null once the bytes run out.
type BitReader = (bits: number) => number | null

function bitReader(bytes: Uint8Array, start: number): BitReader {
	let at = 0

	return bits => {
		let value = 0

		for (let i = 0; i < bits; i++) {
			const position = at + i
			const byte = bytes[start + (position >> 3)]

			if (byte === undefined) {
				return null
			}

			value += ((byte >> (position & 7)) & 1) * 2 ** i
		}

		at += bits

		return value
	}
}

// One dimension: 8 × (1 + u(5)) for a small image, else 1 + U32(u(9), u(13), u(18), u(30)).
function readDimension(read: BitReader, small: boolean): number | null {
	if (small) {
		const div8 = read(5)

		return div8 === null ? null : (div8 + 1) * 8
	}

	const selector = read(2)
	const value = selector === null ? null : read([9, 13, 18, 30][selector] ?? 0)

	return value === null ? null : value + 1
}

function readSizeHeader(bytes: Uint8Array, start: number): JxlHeader | null {
	if (!startsWith(bytes, CODESTREAM_SIGNATURE, start)) {
		return null
	}

	const read = bitReader(bytes, start + 2)
	const small = read(1)

	if (small === null) {
		return null
	}

	const height = readDimension(read, small === 1)
	const ratio = read(3)

	if (height === null || ratio === null) {
		return null
	}

	const fixed = RATIOS[ratio - 1]
	const width = fixed === undefined ? readDimension(read, small === 1) : Math.floor((height * fixed[0]) / fixed[1])

	return width === null || width === 0 ? null : { width, height }
}

// The offset of the codestream within the container's boxes, or -1.
function codestreamOffset(head: Uint8Array, fileSize: number): number {
	const view = viewOf(head)
	let at = CONTAINER_SIGNATURE.length

	for (let boxes = 1; boxes < MAX_JXL_BOXES && at + 8 <= head.length; boxes++) {
		const size32 = view.getUint32(at)
		const type = view.getUint32(at + 4)
		let header = 8
		let size = size32

		if (size32 === 1) {
			if (at + 16 > head.length) {
				return -1
			}

			header = 16
			size = Number(view.getBigUint64(at + 8))
		} else if (size32 === 0) {
			// The last box, to the end of the file.
			size = fileSize - at
		}

		if (size < header || at + size > fileSize) {
			return -1
		}

		if (type === BOX_JXLC) {
			return at + header
		}

		if (type === BOX_JXLP) {
			return at + header + 4
		}

		if (size32 === 0) {
			return -1
		}

		at += size
	}

	return -1
}

export function sniffJxl(head: Uint8Array, fileSize: number): JxlHeader | null {
	if (startsWith(head, CODESTREAM_SIGNATURE)) {
		return readSizeHeader(head, 0)
	}

	if (!startsWith(head, CONTAINER_SIGNATURE)) {
		return null
	}

	const offset = codestreamOffset(head, fileSize)

	return offset < 0 ? null : readSizeHeader(head, offset)
}
