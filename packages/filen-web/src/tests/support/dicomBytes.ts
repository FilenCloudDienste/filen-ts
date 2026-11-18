import { deflateSync } from "fflate"

// Small DICOM files written from scratch (PS3.10 part 10 files, PS3.5 encodings) for the DICOM viewer's unit tests and
// the e2e fixtures: a preamble and meta group, then the data set in the transfer syntax asked for, native or
// encapsulated pixel data, optionally deflated.

export const EXPLICIT_LE = "1.2.840.10008.1.2.1"
export const IMPLICIT_LE = "1.2.840.10008.1.2"
export const EXPLICIT_BE = "1.2.840.10008.1.2.2"
export const DEFLATED = "1.2.840.10008.1.2.1.99"
export const RLE = "1.2.840.10008.1.2.5"
export const JPEG_BASELINE = "1.2.840.10008.1.2.4.50"
export const JPEG_LOSSLESS = "1.2.840.10008.1.2.4.70"
export const JPEG_LS = "1.2.840.10008.1.2.4.80"
export const JPEG_2000 = "1.2.840.10008.1.2.4.90"
export const HTJ2K = "1.2.840.10008.1.2.4.201"

export interface DicomElement {
	// 0xGGGGEEEE
	readonly tag: number
	readonly vr: string
	readonly value: Uint8Array
	// Items of a sequence (vr SQ), each a list of elements.
	readonly items?: readonly (readonly DicomElement[])[]
	// Written with an undefined length (encapsulated pixel data).
	readonly undefinedLength?: boolean
	// US values, written in the data set's byte order.
	readonly shorts?: readonly number[]
}

const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UR", "UT", "UN"])

function padded(bytes: Uint8Array, pad: number): Uint8Array {
	if (bytes.length % 2 === 0) return bytes

	const out = new Uint8Array(bytes.length + 1)

	out.set(bytes)
	out[bytes.length] = pad

	return out
}

export function text(tag: number, vr: string, value: string): DicomElement {
	return { tag, vr, value: padded(new TextEncoder().encode(value), vr === "UI" ? 0 : 0x20) }
}

export function us(tag: number, ...values: number[]): DicomElement {
	return { tag, vr: "US", value: new Uint8Array(values.length * 2), shorts: values }
}

export function binary(tag: number, vr: string, value: Uint8Array): DicomElement {
	return { tag, vr, value: padded(value, 0) }
}

export function sequence(tag: number, items: readonly (readonly DicomElement[])[]): DicomElement {
	return { tag, vr: "SQ", value: new Uint8Array(0), items }
}

class Writer {
	private readonly chunks: Uint8Array[] = []
	private readonly littleEndian: boolean
	private readonly explicit: boolean

	constructor(littleEndian: boolean, explicit: boolean) {
		this.littleEndian = littleEndian
		this.explicit = explicit
	}

	u16(value: number): void {
		const bytes = new Uint8Array(2)

		new DataView(bytes.buffer).setUint16(0, value, this.littleEndian)
		this.chunks.push(bytes)
	}

	u32(value: number): void {
		const bytes = new Uint8Array(4)

		new DataView(bytes.buffer).setUint32(0, value, this.littleEndian)
		this.chunks.push(bytes)
	}

	raw(bytes: Uint8Array): void {
		this.chunks.push(bytes)
	}

	header(tag: number, vr: string, length: number): void {
		this.u16(tag >>> 16)
		this.u16(tag & 0xffff)

		if (!this.explicit) {
			this.u32(length)

			return
		}

		this.raw(new TextEncoder().encode(vr))

		if (LONG_VRS.has(vr)) {
			this.u16(0)
			this.u32(length)
		} else {
			this.u16(length)
		}
	}

	element(element: DicomElement): void {
		if (element.items !== undefined) {
			this.header(element.tag, "SQ", 0xffffffff)

			for (const item of element.items) {
				const inner = new Writer(this.littleEndian, this.explicit)

				for (const child of [...item].sort((a, b) => a.tag - b.tag)) inner.element(child)

				const body = inner.bytes()

				this.u16(0xfffe)
				this.u16(0xe000)
				this.u32(body.length)
				this.raw(body)
			}

			this.u16(0xfffe)
			this.u16(0xe0dd)
			this.u32(0)

			return
		}

		this.header(element.tag, element.vr, element.undefinedLength === true ? 0xffffffff : element.value.length)

		if (element.shorts === undefined) {
			this.raw(element.value)
		} else {
			for (const value of element.shorts) this.u16(value)
		}
	}

	bytes(): Uint8Array {
		const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
		const out = new Uint8Array(total)
		let at = 0

		for (const chunk of this.chunks) {
			out.set(chunk, at)
			at += chunk.length
		}

		return out
	}
}

// Encapsulated pixel data (PS3.5 A.4): the Basic Offset Table (empty unless `offsets`), the fragments, the delimiter.
export function encapsulated(fragments: readonly Uint8Array[], offsets: readonly number[] | null = null): Uint8Array {
	const writer = new Writer(true, true)

	writer.u16(0xfffe)
	writer.u16(0xe000)
	writer.u32((offsets?.length ?? 0) * 4)

	for (const offset of offsets ?? []) writer.u32(offset)

	for (const fragment of fragments) {
		const body = padded(fragment, 0)

		writer.u16(0xfffe)
		writer.u16(0xe000)
		writer.u32(body.length)
		writer.raw(body)
	}

	writer.u16(0xfffe)
	writer.u16(0xe0dd)
	writer.u32(0)

	return writer.bytes()
}

// The Basic Offset Table for `fragments`, one fragment a frame.
export function frameOffsets(fragments: readonly Uint8Array[]): number[] {
	const offsets: number[] = []
	let at = 0

	for (const fragment of fragments) {
		offsets.push(at)
		at += 8 + fragment.length + (fragment.length % 2)
	}

	return offsets
}

export interface DicomFileOptions {
	readonly transferSyntax: string
	readonly elements: readonly DicomElement[]
	// Native: the value; encapsulated: encapsulated(…)'s bytes.
	readonly pixelData?: Uint8Array
	// No preamble and no meta group (an older file).
	readonly raw?: boolean
}

export const PIXEL_DATA = 0x7fe00010

export function dicomFile(options: DicomFileOptions): Uint8Array {
	const { transferSyntax } = options
	const encapsulatedPixels = ![EXPLICIT_LE, IMPLICIT_LE, EXPLICIT_BE, DEFLATED].includes(transferSyntax)
	const body = new Writer(transferSyntax !== EXPLICIT_BE, transferSyntax !== IMPLICIT_LE)

	for (const element of [...options.elements].sort((a, b) => a.tag - b.tag)) body.element(element)

	if (options.pixelData !== undefined) {
		body.element({
			tag: PIXEL_DATA,
			vr: encapsulatedPixels ? "OB" : "OW",
			value: options.pixelData,
			undefinedLength: encapsulatedPixels
		})
	}

	const dataSet = body.bytes()

	if (options.raw === true) return dataSet

	const meta = new Writer(true, true)

	meta.element(binary(0x00020001, "OB", new Uint8Array([0, 1])))
	meta.element(text(0x00020010, "UI", transferSyntax))

	const metaBytes = meta.bytes()
	const group = new Writer(true, true)

	group.element({ tag: 0x00020000, vr: "UL", value: new Uint8Array(new Uint32Array([metaBytes.length]).buffer) })

	const head = new Uint8Array(132)

	head.set(new TextEncoder().encode("DICM"), 128)

	const rest = transferSyntax === DEFLATED ? deflateSync(dataSet) : dataSet
	const parts = [head, group.bytes(), metaBytes, rest]
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// The Image Pixel module of a grey image.
export function grayModule(options: {
	rows: number
	columns: number
	bitsAllocated: number
	bitsStored: number
	highBit: number
	signed: boolean
	frames?: number
	photometric?: string
}): DicomElement[] {
	return [
		us(0x00280002, 1),
		text(0x00280004, "CS", options.photometric ?? "MONOCHROME2"),
		...(options.frames === undefined ? [] : [text(0x00280008, "IS", String(options.frames))]),
		us(0x00280010, options.rows),
		us(0x00280011, options.columns),
		us(0x00280100, options.bitsAllocated),
		us(0x00280101, options.bitsStored),
		us(0x00280102, options.highBit),
		us(0x00280103, options.signed ? 1 : 0)
	]
}

// One RLE frame (PS3.5 G) from byte planes, each PackBits-encoded as literal runs of up to 128 bytes.
export function rleFrame(planes: readonly Uint8Array[]): Uint8Array {
	const segments = planes.map(plane => {
		const out: number[] = []

		for (let at = 0; at < plane.length; at += 128) {
			const run = plane.subarray(at, at + 128)

			out.push(run.length - 1, ...run)
		}

		return Uint8Array.from(out)
	})
	const header = new Uint8Array(64)
	const view = new DataView(header.buffer)

	view.setUint32(0, segments.length, true)

	let offset = 64

	segments.forEach((segment, i) => {
		view.setUint32(4 + i * 4, offset, true)
		offset += segment.length
	})

	const out = new Uint8Array(offset)

	out.set(header)

	let at = 64

	for (const segment of segments) {
		out.set(segment, at)
		at += segment.length
	}

	return out
}

const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff]
const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]

export interface J2kMainHeader {
	// The image's origin on the reference grid (XOsiz, YOsiz); the image is `columns` × `rows` from it.
	readonly x0?: number
	readonly y0?: number
	readonly subsampled?: boolean
	// COC segments: a component's own decomposition levels.
	readonly componentLevels?: readonly { readonly component: number; readonly levels: number }[]
}

// A JPEG 2000 codestream's main header (SOC, SIZ, COD, any COCs), up to the first tile part's SOT marker.
export function siz(
	columns: number,
	rows: number,
	components: number,
	depth: number,
	levels: number,
	options: J2kMainHeader = {}
): Uint8Array {
	const x0 = options.x0 ?? 0
	const y0 = options.y0 ?? 0

	return Uint8Array.from([
		0xff,
		0x4f,
		0xff,
		0x51,
		...be16(38 + components * 3),
		0,
		0,
		...be32(x0 + columns),
		...be32(y0 + rows),
		...be32(x0),
		...be32(y0),
		...be32(x0 + columns),
		...be32(y0 + rows),
		...be32(0),
		...be32(0),
		...be16(components),
		...Array.from({ length: components }, (_, i) => [depth - 1, options.subsampled === true && i > 0 ? 2 : 1, 1]).flat(),
		0xff,
		0x52,
		...be16(12),
		0,
		0,
		0,
		1,
		0,
		levels,
		4,
		4,
		0,
		0,
		...(options.componentLevels ?? []).flatMap(({ component, levels: own }) => [0xff, 0x53, ...be16(9), component, 0, own, 4, 4, 0, 0]),
		0xff,
		0x90
	])
}
