import { startsWith, viewOf } from "@/features/preview/lib/imageSniff/bytes"

// JPEG XL (ISO/IEC 18181): a bare codestream starts FF 0A; the container (18181-2) starts with the 12-byte "JXL "
// signature box and carries the codestream in one "jxlc" box or split over "jxlp" boxes (each led by a 4-byte index).
// The codestream's SizeHeader (18181-1 Annex A) follows its signature.

export interface JxlHeader {
	readonly width: number
	readonly height: number
}

// What the image metadata after the size says: the Exif-style orientation (1 when not given), whether the image is an
// animation, and whether one of its extra channels is alpha (an edited copy keeps it as PNG).
export interface JxlImage extends JxlHeader {
	readonly orientation: number
	readonly animated: boolean
	readonly hasAlpha: boolean
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

// U32(BitsOffset(…), …): a 2-bit selector, then that distribution's bits plus its offset.
function readU32(read: BitReader, distributions: readonly (readonly [bits: number, offset: number])[]): number | null {
	const selector = read(2)
	const distribution = selector === null ? undefined : distributions[selector]

	if (distribution === undefined) {
		return null
	}

	const value = read(distribution[0])

	return value === null ? null : value + distribution[1]
}

// SizeHeader (18181-1 A.2): the image's size as coded, before its orientation turns it.
function readSize(read: BitReader): JxlHeader | null {
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

const PREVIEW_DIV8: readonly (readonly [number, number])[] = [
	[0, 16],
	[0, 32],
	[5, 1],
	[9, 33]
]
// PreviewHeader's ysize/xsize (18181-1 A.6): BitsOffset(6, 1), BitsOffset(8, 65), BitsOffset(10, 321), BitsOffset(12, 1065).
export const JXL_PREVIEW_SIZE: readonly (readonly [number, number])[] = [
	[6, 1],
	[8, 65],
	[10, 321],
	[12, 1065]
]

// PreviewHeader (18181-1 A.6): read only to step past it.
function skipPreview(read: BitReader): boolean {
	const div8 = read(1)

	if (div8 === null) {
		return false
	}

	const distributions = div8 === 1 ? PREVIEW_DIV8 : JXL_PREVIEW_SIZE

	if (readU32(read, distributions) === null) {
		return false
	}

	const ratio = read(3)

	return ratio !== null && (ratio !== 0 || readU32(read, distributions) !== null)
}

const BITS_PER_SAMPLE: readonly (readonly [number, number])[] = [
	[0, 8],
	[0, 10],
	[0, 12],
	[6, 1]
]
const FLOAT_BITS: readonly (readonly [number, number])[] = [
	[0, 32],
	[0, 16],
	[0, 24],
	[6, 1]
]
const EXTRA_CHANNELS: readonly (readonly [number, number])[] = [
	[0, 0],
	[0, 1],
	[4, 2],
	[12, 1]
]

// Enum (18181-1 A.3): U32(Val(0), Val(1), BitsOffset(4, 2), BitsOffset(6, 18)).
const ENUM: readonly (readonly [number, number])[] = [
	[0, 0],
	[0, 1],
	[4, 2],
	[6, 18]
]
const DIM_SHIFT: readonly (readonly [number, number])[] = [
	[0, 0],
	[0, 3],
	[0, 4],
	[3, 1]
]
const NAME_LENGTH: readonly (readonly [number, number])[] = [
	[0, 0],
	[4, 0],
	[5, 16],
	[10, 48]
]
const CFA_CHANNEL: readonly (readonly [number, number])[] = [
	[0, 1],
	[2, 0],
	[4, 3],
	[8, 19]
]
const EXTRA_CHANNEL_ALPHA = 0
const EXTRA_CHANNEL_SPOT_COLOUR = 2
const EXTRA_CHANNEL_CFA = 5
// More extra channels than any image a person edits carries: past this the answer is left unknown.
export const MAX_JXL_EXTRA_CHANNELS = 64

// Steps past `bits` bits; false when the head ends first.
function skip(read: BitReader, bits: number): boolean {
	for (let left = bits; left > 0; left -= 16) {
		if (read(Math.min(16, left)) === null) {
			return false
		}
	}

	return true
}

// BitDepth (18181-1 A.7).
function skipBitDepth(read: BitReader): boolean {
	const float = read(1)

	if (float === null || readU32(read, float === 1 ? FLOAT_BITS : BITS_PER_SAMPLE) === null) {
		return false
	}

	return float === 0 || read(4) !== null
}

// One ExtraChannelInfo (18181-1 A.8): its type, every other field stepped past. Null when the head ends inside it.
function readExtraChannelType(read: BitReader): number | null {
	const defaultAlpha = read(1)

	if (defaultAlpha === null) {
		return null
	}

	if (defaultAlpha === 1) {
		return EXTRA_CHANNEL_ALPHA
	}

	const type = readU32(read, ENUM)

	if (type === null || !skipBitDepth(read) || readU32(read, DIM_SHIFT) === null) {
		return null
	}

	const nameLength = readU32(read, NAME_LENGTH)

	if (nameLength === null || !skip(read, 8 * nameLength)) {
		return null
	}

	switch (type) {
		case EXTRA_CHANNEL_ALPHA:
			// alpha_associated
			return read(1) === null ? null : type
		case EXTRA_CHANNEL_SPOT_COLOUR:
			// red, green, blue and solidity as F16
			return skip(read, 64) ? type : null
		case EXTRA_CHANNEL_CFA:
			return readU32(read, CFA_CHANNEL) === null ? null : type
		default:
			return type
	}
}

// BitDepth and modular_16bit_buffer_sufficient, then the extra channels (18181-1 A.6, A.8): whether one is alpha (a
// depth map or a spot colour is not). Null when the head ends first or there are too many to read.
function readHasAlpha(read: BitReader): boolean | null {
	if (!skipBitDepth(read) || read(1) === null) {
		return null
	}

	const count = readU32(read, EXTRA_CHANNELS)

	if (count === null || count > MAX_JXL_EXTRA_CHANNELS) {
		return null
	}

	let alpha = false

	for (let channel = 0; channel < count; channel++) {
		const type = readExtraChannelType(read)

		if (type === null) {
			return null
		}

		alpha ||= type === EXTRA_CHANNEL_ALPHA
	}

	return alpha
}

// ImageMetadata's leading fields (18181-1 A.6): all_default, then extra_fields with the orientation, an intrinsic size,
// a preview and the animation flag, then the bit depth and the extra channels. An animation's own header is not read:
// its frames are not edited.
function readImage(read: BitReader, size: JxlHeader): JxlImage | null {
	const allDefault = read(1)

	if (allDefault === null) {
		return null
	}

	if (allDefault === 1) {
		return { ...size, orientation: 1, animated: false, hasAlpha: false }
	}

	const extraFields = read(1)
	let orientation = 1

	if (extraFields === null) {
		return null
	}

	if (extraFields === 1) {
		const stored = read(3)
		const intrinsic = read(1)

		if (stored === null || intrinsic === null || (intrinsic === 1 && readSize(read) === null)) {
			return null
		}

		const preview = read(1)

		if (preview === null || (preview === 1 && !skipPreview(read))) {
			return null
		}

		const animation = read(1)

		if (animation === null) {
			return null
		}

		orientation = stored + 1

		if (animation === 1) {
			return { ...size, orientation, animated: true, hasAlpha: false }
		}
	}

	const hasAlpha = readHasAlpha(read)

	return hasAlpha === null ? null : { ...size, orientation, animated: false, hasAlpha }
}

function readHeaders(bytes: Uint8Array, start: number): { size: JxlHeader; read: BitReader } | null {
	if (!startsWith(bytes, CODESTREAM_SIGNATURE, start)) {
		return null
	}

	const read = bitReader(bytes, start + 2)
	const size = readSize(read)

	return size === null ? null : { size, read }
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

// Where the codestream starts in `head`, or -1.
function codestreamStart(head: Uint8Array, fileSize: number): number {
	if (startsWith(head, CODESTREAM_SIGNATURE)) {
		return 0
	}

	return startsWith(head, CONTAINER_SIGNATURE) ? codestreamOffset(head, fileSize) : -1
}

export function sniffJxl(head: Uint8Array, fileSize: number): JxlHeader | null {
	const start = codestreamStart(head, fileSize)

	return start < 0 ? null : (readHeaders(head, start)?.size ?? null)
}

// The size as shown: turned by its orientation (5–8 swap the axes), as every decoder of ours and the browser's draw
// it. As coded when the head ends before the orientation.
export function sniffJxlUpright(head: Uint8Array, fileSize: number): JxlHeader | null {
	const image = sniffJxlImage(head, fileSize)

	if (image === null) {
		return sniffJxl(head, fileSize)
	}

	return image.orientation >= 5 ? { width: image.height, height: image.width } : { width: image.width, height: image.height }
}

// The size and the metadata the editor needs (orientation, animation); null when the head ends before them.
export function sniffJxlImage(head: Uint8Array, fileSize: number): JxlImage | null {
	const start = codestreamStart(head, fileSize)
	const headers = start < 0 ? null : readHeaders(head, start)

	return headers === null ? null : readImage(headers.read, headers.size)
}
