import CharLS from "@cornerstonejs/codec-charls/decodewasmjs"
import OpenJPEG from "@cornerstonejs/codec-openjpeg/decodewasmjs"
import OpenJPH from "@cornerstonejs/codec-openjph/wasmjs"
import { Decoder as LosslessDecoder } from "jpeg-lossless-decoder-js"
// Emitted by Vite as hashed assets of this build, fetched from 'self'; CSP's 'wasm-unsafe-eval' admits the compile.
import charlsWasmUrl from "@cornerstonejs/codec-charls/decodewasm?url"
import openjpegWasmUrl from "@cornerstonejs/codec-openjpeg/decodewasm?url"
import openjphWasmUrl from "@cornerstonejs/codec-openjph/wasm?url"
import {
	declaredPixels,
	jpeg2000Header,
	jpegFrameHeader,
	jpegLsHeader,
	losslessJpegHeader,
	matchesTags,
	reducedSize,
	reductionWithin,
	type CodestreamHeader
} from "@/features/preview/lib/dicom/codestream.logic"
import { DicomFrameFailure, type CompressedDecoder } from "@/features/preview/lib/dicom/frameDecode"
import { DICOM_CODEC_INITIAL_HEAP } from "@/features/preview/lib/dicom/budget.logic"
import type { DicomDecoder } from "@/features/preview/lib/dicom/transferSyntax"
import type { FrameSamples, SampleColor } from "@/features/preview/lib/dicom/pixels.logic"
import type { PixelModule } from "@/features/preview/lib/dicom/pixelModule"

// The DICOM worker's decoders of compressed frames: the browser's JPEG decoder for baseline JPEG, jpeg-lossless-decoder-js,
// CharLS (JPEG-LS), OpenJPEG (JPEG 2000) and OpenJPH (HTJ2K). Each frame's codestream header is read first and must
// match the tags; the larger declaration is checked against the pixel budget before the decoder is called. A JPEG 2000
// frame over the budget is decoded at the fewest reductions that fit. Each wasm module loads on first use, from 'self';
// a decode that failed may have left it unusable, so it starts afresh next time. Nothing is printed.

const quiet = (): void => undefined

interface Loader<T> {
	readonly get: () => Promise<T>
	// The module's heap now, or the one it starts with.
	readonly heap: () => number
	// Lets the module go: its heap is reclaimed with it, and the next frame loads it afresh.
	readonly drop: () => void
}

function loader<T extends { readonly HEAPU8: Uint8Array }>(load: () => Promise<T>): Loader<T> {
	let module: Promise<T> | null = null
	let loaded: T | null = null

	return {
		get: () => {
			module ??= load().then(
				ready => {
					loaded = ready

					return ready
				},
				(error: unknown) => {
					module = null

					throw error
				}
			)

			return module
		},
		heap: () => loaded?.HEAPU8.byteLength ?? DICOM_CODEC_INITIAL_HEAP,
		drop: () => {
			module = null
			loaded = null
		}
	}
}

// Each Emscripten module takes options of its own: it writes its runtime onto them.
const charls = loader(() => CharLS({ locateFile: () => charlsWasmUrl, print: quiet, printErr: quiet }))
const openjpeg = loader(() => OpenJPEG({ locateFile: () => openjpegWasmUrl, print: quiet, printErr: quiet }))
const openjph = loader(() => OpenJPH({ locateFile: () => openjphWasmUrl, print: quiet, printErr: quiet }))

// The frame's bytes over a plain ArrayBuffer (a read copies into one; never a shared one).
function plain(encoded: Uint8Array): Uint8Array<ArrayBuffer> {
	const { buffer } = encoded

	if (!(buffer instanceof ArrayBuffer)) throw new DicomFrameFailure("unreadable", "a shared frame buffer")

	return new Uint8Array(buffer, encoded.byteOffset, encoded.length)
}

function mismatch(): never {
	throw new DicomFrameFailure("mismatch", "the codestream header does not match the tags")
}

function checked(header: CodestreamHeader | null, module: PixelModule, pixels: number): CodestreamHeader {
	if (header === null || !matchesTags(header, module)) mismatch()

	if (declaredPixels(header, module) > pixels) {
		throw new DicomFrameFailure("tooLarge", "the frame is larger than the decode budget")
	}

	return header
}

// Decoded samples, two bytes each when `wide`, right-aligned (no High Bit shift).
function samples(
	data: Uint8Array,
	rows: number,
	columns: number,
	module: PixelModule,
	color: SampleColor,
	planar: boolean,
	wide: boolean
): FrameSamples {
	return {
		data: wide ? new Uint16Array(data.buffer, data.byteOffset, data.length / 2) : data,
		rows,
		columns,
		samplesPerPixel: module.samplesPerPixel,
		color,
		planar,
		shift: 0
	}
}

// Copies the decoder's output out of the wasm heap once its size is the one expected; frees the decoder either way.
function decodedCopy(decoder: { getDecodedBuffer: () => Uint8Array }, expected: number): Uint8Array {
	const out = decoder.getDecodedBuffer()

	if (out.length !== expected) mismatch()

	return out.slice()
}

async function jpegBaseline(encoded: Uint8Array, module: PixelModule, color: SampleColor, pixels: number): Promise<FrameSamples> {
	const { rows, columns } = checked(jpegFrameHeader(encoded), module, pixels)
	const bitmap = await createImageBitmap(new Blob([plain(encoded)], { type: "image/jpeg" }), {
		colorSpaceConversion: "none",
		premultiplyAlpha: "none"
	})

	try {
		if (bitmap.width !== columns || bitmap.height !== rows) mismatch()

		const canvas = new OffscreenCanvas(columns, rows)
		const context = canvas.getContext("2d")

		if (context === null) throw new DicomFrameFailure("unreadable", "no 2D context")

		context.drawImage(bitmap, 0, 0)

		const rgba = context.getImageData(0, 0, columns, rows).data

		if (color !== "gray") {
			return { data: new Uint8Array(rgba.buffer), rows, columns, samplesPerPixel: 4, color: "rgba", planar: false, shift: 0 }
		}

		// A grey JPEG decodes to equal channels: its red is the grey level.
		const grey = new Uint8Array(rows * columns)

		for (let i = 0; i < grey.length; i++) grey[i] = rgba[i * 4] ?? 0

		return samples(grey, rows, columns, module, color, false, false)
	} finally {
		bitmap.close()
	}
}

function jpegLossless(encoded: Uint8Array, module: PixelModule, color: SampleColor, pixels: number): FrameSamples {
	const { rows, columns, components } = checked(losslessJpegHeader(encoded), module, pixels)
	const bytes = module.bitsAllocated > 8 ? 2 : 1

	// The decoder writes wider samples for one component only.
	if (components > 1 && bytes > 1) {
		throw new DicomFrameFailure("unsupported", "16-bit colour lossless JPEG")
	}

	const decoded = new LosslessDecoder().decode(plain(encoded).buffer, encoded.byteOffset, encoded.length, bytes)

	if (decoded.length !== rows * columns * components) mismatch()

	return samples(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength), rows, columns, module, color, false, bytes > 1)
}

async function jpegLs(encoded: Uint8Array, module: PixelModule, color: SampleColor, pixels: number): Promise<FrameSamples> {
	const { rows, columns, components, bits } = checked(jpegLsHeader(encoded), module, pixels)
	const wide = bits > 8
	const codec = await charls.get()
	const decoder = new codec.JpegLSDecoder()

	try {
		decoder.getEncodedBuffer(encoded.length).set(encoded)
		decoder.decode()

		const info = decoder.getFrameInfo()

		if (info.width !== columns || info.height !== rows || info.componentCount !== components) mismatch()

		const data = decodedCopy(decoder, rows * columns * components * (wide ? 2 : 1))

		return samples(data, rows, columns, module, color, components > 1 && decoder.getInterleaveMode() === 0, wide)
	} catch (error) {
		if (!(error instanceof DicomFrameFailure)) charls.drop()

		throw error
	} finally {
		decoder.delete()
	}
}

async function jpeg2000(
	encoded: Uint8Array,
	module: PixelModule,
	color: SampleColor,
	pixels: number,
	high: boolean
): Promise<FrameSamples> {
	const header = jpeg2000Header(encoded)

	if (header === null || !matchesTags(header, module)) mismatch()

	const level = reductionWithin(header, pixels)

	if (level === null) throw new DicomFrameFailure("tooLarge", "the frame is larger than the decode budget at every resolution")

	const loaded = high ? openjph : openjpeg
	const codec = await loaded.get()
	const decoder = "HTJ2KDecoder" in codec ? new codec.HTJ2KDecoder() : new codec.J2KDecoder()
	const size = reducedSize(header.rows, header.columns, level)

	try {
		decoder.getEncodedBuffer(encoded.length).set(encoded)

		if (level === 0) decoder.decode()
		else decoder.decodeSubResolution(level, 0)

		const info = decoder.getFrameInfo()

		if (info.width !== header.columns || info.height !== header.rows || info.componentCount !== header.components) mismatch()

		const wide = header.bits > 8
		const data = decodedCopy(decoder, size.rows * size.columns * header.components * (wide ? 2 : 1))

		return samples(data, size.rows, size.columns, module, color, false, wide)
	} catch (error) {
		if (!(error instanceof DicomFrameFailure)) loaded.drop()

		throw error
	} finally {
		decoder.delete()
	}
}

function codecOf(decoder: DicomDecoder): Loader<unknown> | null {
	switch (decoder) {
		case "jpegLs":
			return charls
		case "jpeg2000":
			return openjpeg
		case "htj2k":
			return openjph
		default:
			return null
	}
}

// The wasm heap the decoder of `decoder` holds (or will start with once loaded); 0 for a decoder without one.
export function codecHeap(decoder: DicomDecoder): number {
	return codecOf(decoder)?.heap() ?? 0
}

export function releaseCodec(decoder: DicomDecoder): void {
	codecOf(decoder)?.drop()
}

export const decodeCompressed: CompressedDecoder = async (encoded, module, color, decoder, pixels) => {
	switch (decoder) {
		case "jpegBaseline":
			return await jpegBaseline(encoded, module, color, pixels)
		case "jpegLossless":
			return jpegLossless(encoded, module, color, pixels)
		case "jpegLs":
			return await jpegLs(encoded, module, color, pixels)
		case "jpeg2000":
			return await jpeg2000(encoded, module, color, pixels, false)
		case "htj2k":
			return await jpeg2000(encoded, module, color, pixels, true)
		case "native":
		case "rle":
			throw new DicomFrameFailure("unsupported", "not a compressed syntax")
	}
}
