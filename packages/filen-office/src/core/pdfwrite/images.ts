import { PdfWriteError } from "./errors"

// Image XObjects (ISO 32000-1 §8.9.5). JPEG goes in as is (/DCTDecode, §7.4.8); PNG without alpha and not
// interlaced goes in as its own zlib data (/FlateDecode with the PNG predictors, §7.4.4.4); everything else is
// decoded by the platform to straight RGBA and written as RGB plus a /SMask (§11.6.5.3). Passthrough data is
// written from Blob slices or views, never copied.

// The part of Blob this module uses (the core has no DOM typings).
export interface PdfBlobLike {
	readonly size: number
	slice(start?: number, end?: number): PdfBlobLike
	arrayBuffer(): Promise<ArrayBuffer>
}

export type PdfImageData = Uint8Array | PdfBlobLike

export type PdfImageFormat = "png" | "jpeg" | "gif" | "bmp" | "tiff" | "webp"

export interface PdfDecodedImage {
	readonly width: number
	readonly height: number
	// width × height × 4 bytes, not premultiplied.
	readonly rgba: Uint8Array
	// The pixels are upright (the decoder applied the EXIF orientation), so the writer does not apply it again.
	readonly oriented?: boolean
}

// Decodes what PDF cannot take as is. Refusals throw PdfWriteError ("imageUnsupported", "imageTooLarge").
export interface PdfImageDecoder {
	decode(data: PdfImageData, format: PdfImageFormat, maxPixels: number): Promise<PdfDecodedImage>
}

export const DEFAULT_MAX_IMAGE_PIXELS = 50_000_000

// A source read in windows, so walking a PNG's chunks or a JPEG's segments reads headers, not pixel data.
export class ByteSource {
	private window = new Uint8Array(0)
	private windowStart = 0

	readonly data: PdfImageData

	constructor(data: PdfImageData) {
		this.data = data
	}

	get size(): number {
		return this.data instanceof Uint8Array ? this.data.length : this.data.size
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		const end = Math.min(this.size, offset + length)

		if (this.data instanceof Uint8Array) return this.data.subarray(offset, end)
		if (offset >= this.windowStart && end <= this.windowStart + this.window.length) {
			return this.window.subarray(offset - this.windowStart, end - this.windowStart)
		}

		const windowEnd = Math.min(this.size, Math.max(end, offset + 65536))

		this.window = new Uint8Array(await this.data.slice(offset, windowEnd).arrayBuffer())
		this.windowStart = offset

		return this.window.subarray(0, end - offset)
	}

	// The bytes from `start` to `end` as a passthrough part: a view or a Blob slice.
	part(start: number, end: number): Uint8Array | PdfBlobLike {
		return this.data instanceof Uint8Array ? this.data.subarray(start, end) : this.data.slice(start, end)
	}
}

// A cheap fingerprint for dedupe: the size plus two FNV-1a hashes over the whole source when small, else over
// the head, the tail and 32 evenly spaced samples. A match is only a candidate: sameBytes confirms it.
export async function sampledHash(source: ByteSource): Promise<string> {
	const size = source.size
	let h1 = 0x811c9dc5
	let h2 = 0x050c5d1f
	const feed = (bytes: Uint8Array): void => {
		for (const byte of bytes) {
			h1 = Math.imul(h1 ^ byte, 0x01000193) >>> 0
			h2 = Math.imul(h2 ^ byte, 0x01000193) >>> 0
		}

		h2 = Math.imul(h2 ^ bytes.length, 0x01000193) >>> 0
	}

	if (size <= SMALL_SOURCE) {
		feed(await source.read(0, size))
	} else {
		feed(await source.read(0, 4096))

		for (let sample = 1; sample <= 32; sample++) feed(await source.read(Math.floor((size * sample) / 33), 64))

		feed(await source.read(size - 1024, 1024))
	}

	return `${size}:${h1.toString(36)}:${h2.toString(36)}`
}

const SMALL_SOURCE = 64 * 1024
const COMPARE_CHUNK = 1024 * 1024

// Byte-exact equality of two sources, read in chunks.
export async function sameBytes(a: ByteSource, b: ByteSource): Promise<boolean> {
	if (a.size !== b.size) return false

	for (let offset = 0; offset < a.size; offset += COMPARE_CHUNK) {
		const x = await a.read(offset, COMPARE_CHUNK)
		const y = await b.read(offset, COMPARE_CHUNK)

		if (x.length !== y.length) return false

		for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return false
	}

	return true
}

function u16(b: Uint8Array, at: number): number {
	return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
}

function u32(b: Uint8Array, at: number): number {
	return (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0
}

export function sniffFormat(head: Uint8Array): PdfImageFormat | undefined {
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg"
	if (u32(head, 0) === 0x89504e47 && u32(head, 4) === 0x0d0a1a0a) return "png"
	if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return "gif"
	if (head[0] === 0x42 && head[1] === 0x4d) return "bmp"
	if (
		(head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
		(head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)
	) {
		return "tiff"
	}
	if (u32(head, 0) === 0x52494646 && u32(head, 8) === 0x57454250) return "webp"

	return undefined
}

export interface JpegInfo {
	readonly width: number
	readonly height: number
	readonly components: number
	// An Adobe APP14 marker: four-component data is then stored inverted (as Photoshop writes CMYK).
	readonly adobe: boolean
	// EXIF orientation 1-8.
	readonly orientation: number
	// DCTDecode takes it (8-bit baseline, extended or progressive Huffman).
	readonly passthrough: boolean
}

// Walks the segments up to the frame header (ITU T.81 §B.1.1.3).
export async function readJpeg(source: ByteSource): Promise<JpegInfo | undefined> {
	let at = 2
	let adobe = false
	let orientation = 1

	while (at + 4 <= source.size) {
		const head = await source.read(at, 4)

		if (head[0] !== 0xff) return undefined

		const marker = head[1] ?? 0

		if (marker === 0xff) {
			at++
			continue
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2
			continue
		}
		if (marker === 0xd9 || marker === 0xda) return undefined

		const length = u16(head, 2)

		if (length < 2) return undefined

		const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

		if (isFrame) {
			const frame = await source.read(at + 4, 6)
			const precision = frame[0] ?? 0
			const height = u16(frame, 1)
			const width = u16(frame, 3)
			const components = frame[5] ?? 0

			if (width === 0 || (components !== 1 && components !== 3 && components !== 4)) return undefined

			return {
				width,
				height,
				components,
				adobe,
				orientation,
				passthrough: precision === 8 && height > 0 && (marker === 0xc0 || marker === 0xc1 || marker === 0xc2)
			}
		}

		if (marker === 0xee && length >= 14) {
			const segment = await source.read(at + 4, 5)

			adobe = segment[0] === 0x41 && segment[1] === 0x64 && segment[2] === 0x6f && segment[3] === 0x62 && segment[4] === 0x65
		} else if (marker === 0xe1 && length >= 16) {
			const segment = await source.read(at + 4, Math.min(length - 2, 4096))

			if (u32(segment, 0) === 0x45786966 && u16(segment, 4) === 0) orientation = exifOrientation(segment, 6)
		}

		at += 2 + length
	}

	return undefined
}

// The orientation tag (0x0112) of a TIFF header at `at`, or 1.
function exifOrientation(b: Uint8Array, at: number): number {
	const little = b[at] === 0x49
	const r16 = (offset: number): number => (little ? (b[at + offset] ?? 0) | ((b[at + offset + 1] ?? 0) << 8) : u16(b, at + offset))
	const r32 = (offset: number): number => (little ? (r16(offset) | (r16(offset + 2) << 16)) >>> 0 : u32(b, at + offset))
	const ifd = r32(4)

	if (at + ifd + 2 > b.length) return 1

	for (let index = 0, count = r16(ifd); index < count; index++) {
		const entry = ifd + 2 + index * 12

		if (at + entry + 12 > b.length) return 1
		if (r16(entry) === 0x0112) {
			const value = r16(entry + 8)

			return value >= 1 && value <= 8 ? value : 1
		}
	}

	return 1
}

export interface PngInfo {
	readonly width: number
	readonly height: number
	readonly bitDepth: number
	readonly colorType: number
	readonly interlaced: boolean
	readonly palette: Uint8Array | undefined
	readonly transparency: Uint8Array | undefined
	// The IDAT payloads in order (the zlib stream split across chunks).
	readonly data: readonly (readonly [number, number])[]
}

// Walks the chunks (PNG §5.3): only headers are read, plus PLTE and tRNS.
export async function readPng(source: ByteSource): Promise<PngInfo | undefined> {
	let at = 8
	let header: Uint8Array | undefined
	let palette: Uint8Array | undefined
	let transparency: Uint8Array | undefined
	const data: [number, number][] = []

	while (at + 8 <= source.size) {
		const head = await source.read(at, 8)
		const length = u32(head, 0)
		const type = u32(head, 4)
		const start = at + 8
		const end = start + length

		if (end + 4 > source.size) return undefined

		if (type === 0x49484452) header = (await source.read(start, 13)).slice()
		else if (type === 0x504c5445) palette = (await source.read(start, Math.min(length, 768))).slice()
		else if (type === 0x74524e53) transparency = (await source.read(start, Math.min(length, 256))).slice()
		else if (type === 0x49444154) data.push([start, end])
		else if (type === 0x49454e44) break

		at = end + 4
	}

	if (header === undefined || data.length === 0) return undefined

	const width = u32(header, 0)
	const height = u32(header, 4)

	if (width === 0 || height === 0) return undefined

	return {
		width,
		height,
		bitDepth: header[8] ?? 0,
		colorType: header[9] ?? 0,
		interlaced: header[12] === 1,
		palette,
		transparency,
		data
	}
}

// The colour key (/Mask, §8.9.6.4) of a passthrough PNG's tRNS, null when it needs none, undefined when only a
// soft mask can show it (partial alpha, or several transparent palette entries).
export function pngColorKey(png: PngInfo): number[] | null | undefined {
	const t = png.transparency

	if (t === undefined) return null
	if (png.colorType === 0 && t.length >= 2) {
		const gray = u16(t, 0)

		return [gray, gray]
	}
	if (png.colorType === 2 && t.length >= 6) {
		const r = u16(t, 0)
		const g = u16(t, 2)
		const b = u16(t, 4)

		return [r, r, g, g, b, b]
	}
	if (png.colorType === 3) {
		let index = -1

		for (let entry = 0; entry < t.length; entry++) {
			const alpha = t[entry] ?? 255

			if (alpha === 255) continue
			if (alpha !== 0 || index !== -1) return undefined

			index = entry
		}

		return index === -1 ? null : [index, index]
	}

	return undefined
}

// Whether the PNG's own zlib data can be the stream (§7.4.4.4 Predictor 15 is the PNG filters): no alpha
// channel, no interlacing, and a transparency PDF can show as a colour key.
export function pngPassthrough(png: PngInfo): boolean {
	if (png.interlaced) return false

	const depthOk =
		png.colorType === 0
			? [1, 2, 4, 8, 16].includes(png.bitDepth)
			: png.colorType === 2
				? png.bitDepth === 8 || png.bitDepth === 16
				: png.colorType === 3
					? [1, 2, 4, 8].includes(png.bitDepth) && png.palette !== undefined && png.palette.length >= 3
					: false

	return depthOk && pngColorKey(png) !== undefined
}

interface DecoderGlobals {
	readonly createImageBitmap: (
		blob: unknown,
		options: { readonly premultiplyAlpha: "none"; readonly colorSpaceConversion: "none" }
	) => Promise<{ readonly width: number; readonly height: number; close(): void }>
	readonly OffscreenCanvas: new (
		width: number,
		height: number
	) => {
		width: number
		height: number
		getContext(type: "2d"): {
			drawImage(image: unknown, x: number, y: number): void
			getImageData(x: number, y: number, width: number, height: number): { readonly data: Uint8ClampedArray }
		} | null
	}
	readonly Blob: new (parts: readonly unknown[], options: { readonly type: string }) => PdfBlobLike
}

const MIME: Record<PdfImageFormat, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
	webp: "image/webp"
}

// WebCodecs' ImageDecoder, as the PNG decoders below use it.
export interface PngFrameDecoder {
	new (init: {
		readonly type: string
		readonly data: Uint8Array
		readonly premultiplyAlpha?: "none"
		readonly colorSpaceConversion?: "none"
	}): {
		decode(): Promise<{ readonly image: { readonly displayWidth?: number; readonly displayHeight?: number; close(): void } }>
		close(): void
	}
}

// Firefox decodes the Blob a worker's createImageBitmap is given on the page's main thread (hundreds of milliseconds
// for a large PNG; its JPEGs and other engines' decodes stay off the page). There a PNG is decoded through
// ImageDecoder instead, whose frame is drawn without decoding again; elsewhere undefined.
export function geckoPngDecoder(scope: object): PngFrameDecoder | undefined {
	const decoder: unknown = Reflect.get(scope, "ImageDecoder")
	const navigator: unknown = Reflect.get(scope, "navigator")
	const agent: unknown = typeof navigator === "object" && navigator !== null ? Reflect.get(navigator, "userAgent") : undefined

	return typeof decoder === "function" && typeof agent === "string" && /\bFirefox\//u.test(agent)
		? (decoder as PngFrameDecoder)
		: undefined
}

// The platform decoder of browsers and workers: createImageBitmap without premultiplying or colour
// conversion, read back through an OffscreenCanvas. Undefined where either is missing.
export function platformImageDecoder(): PdfImageDecoder | undefined {
	const globals: { readonly [K in keyof DecoderGlobals]: unknown } = {
		createImageBitmap: Reflect.get(globalThis, "createImageBitmap"),
		OffscreenCanvas: Reflect.get(globalThis, "OffscreenCanvas"),
		Blob: Reflect.get(globalThis, "Blob")
	}

	if (
		typeof globals.createImageBitmap !== "function" ||
		typeof globals.OffscreenCanvas !== "function" ||
		typeof globals.Blob !== "function"
	) {
		return undefined
	}

	// createImageBitmap is a method of the global scope: called through another object it throws.
	const platform: DecoderGlobals = {
		...(globals as DecoderGlobals),
		createImageBitmap: (globals.createImageBitmap as DecoderGlobals["createImageBitmap"]).bind(globalThis)
	}

	const frames = geckoPngDecoder(globalThis)

	return {
		async decode(data, format, maxPixels) {
			const frame = format === "png" && frames !== undefined ? await decodedFrame(frames, data) : undefined
			const blob = data instanceof Uint8Array ? new platform.Blob([data], { type: MIME[format] }) : data
			let bitmap: { readonly width: number; readonly height: number; close(): void }

			try {
				bitmap = frame ?? (await platform.createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }))
			} catch {
				throw new PdfWriteError("imageUnsupported", `The platform cannot decode this ${format} image`)
			}

			try {
				const { width, height } = bitmap

				if (width * height > maxPixels) throw new PdfWriteError("imageTooLarge", `The image has ${width * height} pixels`)

				const canvas = new platform.OffscreenCanvas(width, height)
				const context = canvas.getContext("2d")

				if (context === null) throw new PdfWriteError("imageUnsupported", "No 2D canvas")

				context.drawImage(bitmap, 0, 0)

				const pixels = context.getImageData(0, 0, width, height).data

				canvas.width = 0
				canvas.height = 0

				// createImageBitmap always applies EXIF orientation ("none" is gone from the standard and treated as
				// "from-image"); ImageDecoder frames only serve PNG, which carries none here.
				return { width, height, rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length), oriented: true }
			} finally {
				bitmap.close()
			}
		}
	}
}

// A PNG's first frame through ImageDecoder, as a drawable of its size; undefined when it fails (the caller decodes
// the Blob).
async function decodedFrame(
	Decoder: PngFrameDecoder,
	data: PdfImageData
): Promise<{ readonly width: number; readonly height: number; close(): void } | undefined> {
	let decoder: InstanceType<PngFrameDecoder> | undefined

	try {
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())

		decoder = new Decoder({ type: "image/png", data: bytes, premultiplyAlpha: "none", colorSpaceConversion: "none" })

		const { image } = await decoder.decode()
		const width = image.displayWidth ?? 0
		const height = image.displayHeight ?? 0

		if (!(width > 0 && height > 0)) {
			image.close()

			return undefined
		}

		return Object.assign(image, { width, height })
	} catch {
		return undefined
	} finally {
		decoder?.close()
	}
}

// Splits straight RGBA into RGB and alpha; alpha is null when every pixel is opaque.
export function splitAlpha(rgba: Uint8Array, pixels: number): { readonly rgb: Uint8Array; readonly alpha: Uint8Array | null } {
	const rgb = new Uint8Array(pixels * 3)
	let alpha: Uint8Array | null = null

	for (let pixel = 0, from = 0, to = 0; pixel < pixels; pixel++, from += 4, to += 3) {
		rgb[to] = rgba[from] ?? 0
		rgb[to + 1] = rgba[from + 1] ?? 0
		rgb[to + 2] = rgba[from + 2] ?? 0

		const a = rgba[from + 3] ?? 255

		if (a !== 255 && alpha === null) {
			alpha = new Uint8Array(pixels).fill(255)
		}
		if (alpha !== null) alpha[pixel] = a
	}

	return { rgb, alpha }
}

// The unit square's matrix that draws an image upright for its EXIF orientation, in the y-down space the
// page uses: [a b c d e f] mapping image (u, v) in 0..1 (v down) to the box (0..1 each).
export function orientationMatrix(orientation: number): readonly [number, number, number, number, number, number] {
	switch (orientation) {
		case 2:
			return [-1, 0, 0, 1, 1, 0]
		case 3:
			return [-1, 0, 0, -1, 1, 1]
		case 4:
			return [1, 0, 0, -1, 0, 1]
		case 5:
			return [0, 1, 1, 0, 0, 0]
		case 6:
			return [0, 1, -1, 0, 1, 0]
		case 7:
			return [0, -1, -1, 0, 1, 1]
		case 8:
			return [0, -1, 1, 0, 0, 1]
		default:
			return [1, 0, 0, 1, 0, 0]
	}
}
