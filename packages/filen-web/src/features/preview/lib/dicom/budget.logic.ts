import type { DicomDecoder } from "@/features/preview/lib/dicom/transferSyntax"

// What decoding one frame costs, per decoder, read from the decoders' sources: the samples and copies in JS, the codec's
// working set inside its wasm heap, the encoded frame's copies, and the RGBA drawn from it. A frame's pixels are what
// is left of the worker's budget once all of that and what the worker already holds are counted. A codec's heap only
// grows, so its size is held too: a frame may reuse it, never shrink it.

const MIB = 1024 * 1024

// Each cornerstone codec module starts with a 50 MiB heap (measured; INITIAL_MEMORY of the 1.2.7/1.3.6/2.4.11 builds).
export const DICOM_CODEC_INITIAL_HEAP = 50 * MIB

// A heap past both this and twice a frame's need is let go after the decode (unless cine is playing), so the next
// frame starts from a fresh module rather than holding the high water mark of the largest.
export const DICOM_CODEC_HEAP_KEEP = 256 * MIB

// How far past a requested size an Emscripten heap may grow: by up to 20% of itself a step (at most 96 MiB).
export const DICOM_CODEC_GROWTH = 1.2

// The RGBA drawn from a frame: the ImageData and the canvas it is put into, at most the backing side squared.
const DRAWN_BYTES_PER_PIXEL = 8

const KIB = 1024

// The smallest code block decoded: OpenJPH sets aside state for code blocks of its smallest size whatever the frame's
// (measured: 4 × 4 blocks grow its heap to 430 MiB from a 199-byte stream, 8 × 8 to 108 MiB), and nothing encodes
// smaller than 16 × 16 for medical images.
export const DICOM_MIN_CODE_BLOCK = 16

// What each tile costs in a codec's heap, measured on 255 × 256 frames of 65,280 one-pixel tiles: OpenJPEG grew to
// 604 MiB with one component and 796 MiB with three (its per-tile coding parameters, allocated at SIZ), OpenJPH to
// 1.30 GiB with one.
const OPENJPEG_TILE_BYTES = 9 * KIB
const OPENJPEG_TILE_COMPONENT_BYTES = 3 * KIB
const OPENJPH_TILE_COMPONENT_BYTES = 24 * KIB
// OpenJPH's code-block state, inversely as a code block's area: 430 MiB at 4 × 4 (27 MiB at 16 × 16).
const OPENJPH_CODE_BLOCK_AREA_BYTES = 430 * MIB * 16
// Each code block's own state, in either codec, over every resolution (a third more than the full one).
const CODE_BLOCK_BYTES = 256

export interface Jpeg2000Structure {
	readonly rows: number
	readonly columns: number
	readonly components: number
	readonly tiles: number
	readonly codeBlock: number
}

// The heap a JPEG 2000 codestream's tiles and code blocks take in its decoder, apart from its pixels.
export function structureBytes(decoder: "jpeg2000" | "htj2k", header: Jpeg2000Structure): number {
	const { rows, columns, components, tiles, codeBlock } = header
	// Every tile cuts the code blocks it crosses: at most one more of each a tile.
	const perBlock = (Math.ceil(rows / codeBlock) * Math.ceil(columns / codeBlock) + tiles) * components * (4 / 3) * CODE_BLOCK_BYTES

	if (decoder === "jpeg2000") return tiles * (OPENJPEG_TILE_BYTES + components * OPENJPEG_TILE_COMPONENT_BYTES) + perBlock

	return tiles * components * OPENJPH_TILE_COMPONENT_BYTES + OPENJPH_CODE_BLOCK_AREA_BYTES / (codeBlock * codeBlock) + perBlock
}

export interface DecoderCost {
	// Bytes a decoded pixel costs in JS: the samples the worker keeps and every copy the decode makes on the way.
	readonly js: number
	// Bytes a decoded pixel costs inside the codec's wasm heap (0 without one).
	readonly wasm: number
	// Copies of the encoded frame held in JS while it decodes (the read, a Blob), and inside the codec's heap.
	readonly encodedJs: number
	readonly encodedWasm: number
	// Whether the decoder works in a wasm heap of its own.
	readonly heap: boolean
}

export interface CostInput {
	readonly decoder: DicomDecoder
	readonly samplesPerPixel: number
	// Bytes per stored sample as decoded: Bits Allocated / 8 for native and RLE data, 2 for a compressed sample wider
	// than 8 bits, else 1.
	readonly sampleBytes: number
	// The frame's samples are a view of bytes already held (native data in memory, little-endian and aligned).
	readonly samplesInPlace: boolean
	// The encoded frame is a view of bytes already held (one fragment of a file in memory).
	readonly encodedInPlace: boolean
	readonly gray: boolean
}

export function decoderCost(input: CostInput): DecoderCost {
	const { decoder, samplesPerPixel, sampleBytes, encodedInPlace, gray } = input
	const samples = samplesPerPixel * sampleBytes
	const read = encodedInPlace ? 0 : 1

	switch (decoder) {
		case "native":
			// The frame's bytes are its samples: counted as the encoded frame, and again when they are swapped or realigned.
			return { js: input.samplesInPlace ? 0 : samples, wasm: 0, encodedJs: read, encodedWasm: 0, heap: false }
		case "rle":
			return { js: samples, wasm: 0, encodedJs: read, encodedWasm: 0, heap: false }
		case "jpegBaseline":
			// The browser's decoded bitmap, the canvas it is drawn into and the ImageData read back (a grey frame's red
			// channel copied out of it); the Blob copies the frame, once more when its Exif segment is cut out.
			return { js: 12 + (gray ? 1 : 0), wasm: 0, encodedJs: read + 2, encodedWasm: 0, heap: false }
		case "jpegLossless":
			// jpeg-lossless-decoder-js writes the samples into one array of its own, kept as they are.
			return { js: samples, wasm: 0, encodedJs: read, encodedWasm: 0, heap: false }
		case "jpegLs":
			// CharLS: the decoded samples in its heap, copied out; the encoded frame copied in.
			return { js: samples, wasm: samples, encodedJs: read, encodedWasm: 1, heap: true }
		case "jpeg2000":
			// OpenJPEG: an int32 a sample in its image and again in the tile component, plus the decoded samples.
			return { js: samples, wasm: samplesPerPixel * (8 + sampleBytes), encodedJs: read, encodedWasm: 1, heap: true }
		case "htj2k":
			// OpenJPH: the decoded samples and half a byte more a sample (measured: 2.33 B a 16-bit grey pixel, 4.0 a
			// 3 × 8-bit one), and code-block state of about twice the encoded frame.
			return { js: samples, wasm: samplesPerPixel * (sampleBytes + 0.5), encodedJs: read, encodedWasm: 3, heap: true }
	}
}

export interface BudgetInput {
	readonly decodeBytes: number
	// What the worker holds apart from the codec's heap: the file or its header, the bridge's blocks, cached frames.
	readonly held: number
	// The codec's heap now (or the one it will start with), 0 for a decoder without one.
	readonly heap: number
	readonly encodedBytes: number
	// The heap the codestream's structure takes in the codec (structureBytes), apart from its pixels.
	readonly structure?: number
	// The most pixels drawn: the backing side squared.
	readonly drawnPixels: number
}

// What a frame of `pixels` decoded pixels costs on top of what is held.
export function frameCost(cost: DecoderCost, input: BudgetInput, pixels: number): number {
	const need = heapNeed(cost, pixels, input.encodedBytes, input.structure ?? 0)
	// A heap that has to grow for it grows past what is asked: Emscripten adds up to a fifth of the heap at a time.
	const wasm = need > input.heap ? need * DICOM_CODEC_GROWTH : input.heap

	return (
		input.held +
		cost.js * pixels +
		DRAWN_BYTES_PER_PIXEL * Math.min(pixels, input.drawnPixels) +
		cost.encodedJs * input.encodedBytes +
		(cost.heap ? wasm : input.heap)
	)
}

// The most decoded pixels a frame may have within the budget; 0 when not even its encoded bytes fit.
export function framePixels(cost: DecoderCost, input: BudgetInput): number {
	if (frameCost(cost, input, 0) > input.decodeBytes) return 0

	// The cost rises with the pixels, piecewise linearly: the largest that fits, by bisection.
	let low = 0
	let high = 2 ** 32

	while (low < high) {
		const middle = Math.ceil((low + high) / 2)

		if (frameCost(cost, input, middle) <= input.decodeBytes) low = middle
		else high = middle - 1
	}

	return low
}

// The heap a frame's decode needs inside the codec.
export function heapNeed(cost: DecoderCost, pixels: number, encodedBytes: number, structure = 0): number {
	return cost.wasm * pixels + cost.encodedWasm * encodedBytes + structure
}

// Whether to let the codec's heap go once a frame is decoded: grown past what the next frame needs, cine not playing.
export function releasesHeap(heap: number, need: number, playing: boolean): boolean {
	return !playing && heap > Math.max(DICOM_CODEC_HEAP_KEEP, 2 * need)
}
