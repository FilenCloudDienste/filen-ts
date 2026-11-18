// Where a DICOM file's frames lie. Native pixel data is one value cut into fixed-size frames (PS3.5 §8.1.1);
// encapsulated pixel data is a sequence of items (PS3.5 A.4): a Basic Offset Table, then fragments, each frame one or
// more of them. Frame offsets come from the Extended Offset Table, else the Basic Offset Table, else a walk of the
// 8-byte item headers through the reader (whose blocks it keeps), never reading a fragment's body to find the next.

export class DicomFrameError extends Error {
	override readonly name = "DicomFrameError"
}

// Past this many fragments in one file the item walk stops: the index is 16 bytes a fragment.
export const MAX_FRAGMENTS = 1 << 20

const ITEM = 0xe000
const SEQUENCE_DELIMITER = 0xe0dd
const ITEM_GROUP = 0xfffe
const ITEM_HEADER_BYTES = 8

export interface NativeLayout {
	readonly rows: number
	readonly columns: number
	readonly samplesPerPixel: number
	readonly bitsAllocated: number
	// YBR_FULL_422 stores two luma samples per chroma pair: two bytes a pixel.
	readonly subsampled: boolean
}

export interface Span {
	readonly offset: number
	readonly length: number
}

// A native frame's size in bytes; null for a layout the viewer does not read (1-bit frames are bit-packed across frame
// boundaries).
export function nativeFrameBytes(layout: NativeLayout): number | null {
	const { rows, columns, samplesPerPixel, bitsAllocated, subsampled } = layout

	if (bitsAllocated !== 8 && bitsAllocated !== 16 && bitsAllocated !== 32) return null

	if (subsampled) {
		return bitsAllocated === 8 && samplesPerPixel === 3 && columns % 2 === 0 ? rows * columns * 2 : null
	}

	return rows * columns * samplesPerPixel * (bitsAllocated / 8)
}

// Frame `index` of a native value at `dataOffset`, `length` bytes long (as declared), in a file of `fileSize` bytes.
// The declared length must hold every frame, and the file the declared length.
export function nativeFrameSpan(
	dataOffset: number,
	length: number,
	frameBytes: number,
	frames: number,
	index: number,
	fileSize: number
): Span {
	if (index < 0 || index >= frames) {
		throw new DicomFrameError(`frame ${String(index)} of ${String(frames)}`)
	}

	if (frameBytes * frames > length || dataOffset + length > fileSize) {
		throw new DicomFrameError("the pixel data is shorter than its frames")
	}

	return { offset: dataOffset + index * frameBytes, length: frameBytes }
}

// Reads `length` bytes at `offset`, all of them, or throws.
export type ByteRead = (offset: number, length: number) => Uint8Array

// The start markers of the codestreams a fragment may begin a frame with: JPEG and JPEG-LS SOI, JPEG 2000 SOC.
function startsCodestream(head: Uint8Array): boolean {
	return head.length >= 2 && head[0] === 0xff && (head[1] === 0xd8 || head[1] === 0x4f)
}

export interface FrameOffsets {
	// Byte offsets of each frame's first item, from the first fragment's item.
	readonly offsets: readonly number[]
}

export interface FragmentIndexOptions {
	readonly read: ByteRead
	// The pixel data value's first byte (the Basic Offset Table's item).
	readonly start: number
	// Where the value can end at the latest (the file's size).
	readonly end: number
	readonly frames: number
	// One frame per fragment, whatever the fragment begins with (RLE: PS3.5 G.2).
	readonly fragmentPerFrame: boolean
	// The Extended Offset Table's offsets (7FE0,0001), when the file has one.
	readonly extendedOffsets: readonly number[] | null
}

// The fragments of an encapsulated value, found as far as they are asked for.
export class FragmentIndex {
	private readonly options: FragmentIndexOptions
	// Per fragment: its item's offset, its body's length.
	private items = new Float64Array(64)
	private count = 0
	// The next item to read, or -1 once the delimiter (or the value's end) is reached.
	private next = -1
	private first = -1
	private offsets: readonly number[] | null = null
	// The fragment each frame starts at, as far as the walk has found them (no offset table).
	private readonly frameStarts: number[] = []

	constructor(options: FragmentIndexOptions) {
		this.options = options
	}

	// The fragments of frame `index`, as spans of their bodies.
	frame(index: number): readonly Span[] {
		const { frames } = this.options

		if (index < 0 || index >= frames) {
			throw new DicomFrameError(`frame ${String(index)} of ${String(frames)}`)
		}

		this.open()

		const offsets = this.offsets

		if (offsets !== null) {
			return this.fromOffsets(offsets, index)
		}

		if (frames === 1) {
			while (this.walk()) {
				// every fragment is the one frame's
			}

			return this.spans(0, this.count)
		}

		while (this.frameStarts.length <= index + 1 && this.walk()) {
			// until the frame after this one has begun, or the value ends
		}

		const from = this.frameStarts[index]

		if (from === undefined) {
			throw new DicomFrameError(`the pixel data holds fewer than ${String(index + 1)} frames`)
		}

		return this.spans(from, this.frameStarts[index + 1] ?? this.count)
	}

	// Reads the Basic Offset Table item once.
	private open(): void {
		if (this.first !== -1) return

		const { read, start, end, frames, extendedOffsets } = this.options
		const header = this.itemHeader(start)

		if (header.tag !== ITEM) {
			throw new DicomFrameError("the pixel data does not begin with its offset table")
		}

		const tableEnd = start + ITEM_HEADER_BYTES + header.length

		if (tableEnd > end) {
			throw new DicomFrameError("the offset table runs past the file")
		}

		this.first = tableEnd
		this.next = tableEnd

		if (extendedOffsets !== null && extendedOffsets.length === frames) {
			this.offsets = extendedOffsets
		} else if (header.length > 0 && header.length === frames * 4) {
			const table = read(start + ITEM_HEADER_BYTES, header.length)
			const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
			const offsets: number[] = []

			for (let i = 0; i < frames; i++) offsets.push(view.getUint32(i * 4, true))

			this.offsets = offsets
		}

		// A table that does not rise is no guide; the items are walked instead.
		const table = this.offsets

		if (table?.some((offset, i) => i > 0 && offset <= (table[i - 1] ?? 0)) === true) {
			this.offsets = null
		}
	}

	private fromOffsets(offsets: readonly number[], index: number): readonly Span[] {
		const at = this.first + (offsets[index] ?? 0)
		const until = index + 1 < offsets.length ? this.first + (offsets[index + 1] ?? 0) : this.options.end
		const spans: Span[] = []

		for (let item = at; item < until;) {
			const header = this.itemHeader(item)

			if (header.tag === SEQUENCE_DELIMITER) break

			if (header.tag !== ITEM) {
				throw new DicomFrameError("a frame's offset does not point at an item")
			}

			const body = item + ITEM_HEADER_BYTES

			if (body + header.length > this.options.end) {
				throw new DicomFrameError("a fragment runs past the file")
			}

			spans.push({ offset: body, length: header.length })
			item = body + header.length

			if (spans.length > MAX_FRAGMENTS) {
				throw new DicomFrameError("too many fragments in one frame")
			}
		}

		if (spans.length === 0) {
			throw new DicomFrameError(`frame ${String(index)} has no fragments`)
		}

		return spans
	}

	// Reads the next item header: false once the value has ended.
	private walk(): boolean {
		if (this.next === -1) return false

		const { end, fragmentPerFrame, read } = this.options
		const header = this.itemHeader(this.next)

		if (header.tag === SEQUENCE_DELIMITER) {
			this.next = -1

			return false
		}

		if (header.tag !== ITEM) {
			throw new DicomFrameError("an item in the pixel data is not a fragment")
		}

		const body = this.next + ITEM_HEADER_BYTES

		if (body + header.length > end) {
			throw new DicomFrameError("a fragment runs past the file")
		}

		if (this.count >= MAX_FRAGMENTS) {
			throw new DicomFrameError("too many fragments")
		}

		const begins = fragmentPerFrame || this.count === 0 || startsCodestream(header.length >= 2 ? read(body, 2) : new Uint8Array(0))

		if (begins) this.frameStarts.push(this.count)

		this.push(body, header.length)
		this.next = body + header.length

		return true
	}

	private push(offset: number, length: number): void {
		if (this.count * 2 === this.items.length) {
			const grown = new Float64Array(this.items.length * 2)

			grown.set(this.items)
			this.items = grown
		}

		this.items[this.count * 2] = offset
		this.items[this.count * 2 + 1] = length
		this.count++
	}

	private spans(from: number, to: number): readonly Span[] {
		const spans: Span[] = []

		for (let i = from; i < to; i++) spans.push({ offset: this.items[i * 2] ?? 0, length: this.items[i * 2 + 1] ?? 0 })

		return spans
	}

	// The tag (element of group FFFE) and length at `offset`; past the value's end, as if it ended there.
	private itemHeader(offset: number): { tag: number; length: number } {
		if (offset + ITEM_HEADER_BYTES > this.options.end) return { tag: SEQUENCE_DELIMITER, length: 0 }

		const bytes = this.options.read(offset, ITEM_HEADER_BYTES)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		if (view.getUint16(0, true) !== ITEM_GROUP) {
			throw new DicomFrameError("the pixel data's items are malformed")
		}

		const length = view.getUint32(4, true)

		// An item of undefined length has no place among fragments.
		if (length === 0xffffffff) {
			throw new DicomFrameError("a fragment has no length")
		}

		return { tag: view.getUint16(2, true), length }
	}
}

// The bytes of `spans` in one buffer, read through `read`.
export function joinSpans(read: ByteRead, spans: readonly Span[]): Uint8Array {
	if (spans.length === 1) {
		const [only] = spans

		return only === undefined ? new Uint8Array(0) : read(only.offset, only.length)
	}

	const total = spans.reduce((sum, span) => sum + span.length, 0)
	const joined = new Uint8Array(total)
	let at = 0

	for (const span of spans) {
		joined.set(read(span.offset, span.length), at)
		at += span.length
	}

	return joined
}

export function spansLength(spans: readonly Span[]): number {
	return spans.reduce((sum, span) => sum + span.length, 0)
}
