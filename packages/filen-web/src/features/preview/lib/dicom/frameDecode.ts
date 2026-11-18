import type { DicomDecoder, TransferSyntax } from "@/features/preview/lib/dicom/transferSyntax"
import {
	FragmentIndex,
	joinSpans,
	nativeFrameBytes,
	nativeFrameSpan,
	spansLength,
	DicomFrameError,
	type Span
} from "@/features/preview/lib/dicom/frames.logic"
import { jpeg2000Header, matchesTags, reductionWithin } from "@/features/preview/lib/dicom/codestream.logic"
import { decodeRle, DicomRleError } from "@/features/preview/lib/dicom/rle.logic"
import { decoderCost, framePixels, heapNeed, type DecoderCost } from "@/features/preview/lib/dicom/budget.logic"
import { MAX_BACKING_SIDE } from "@/features/preview/components/canvasViewerShell.logic"
import type { FrameSamples, SampleColor } from "@/features/preview/lib/dicom/pixels.logic"
import type { PixelModule } from "@/features/preview/lib/dicom/pixelModule"
import { DicomOpenError, type DicomSource } from "@/features/preview/lib/dicom/dicomFile"
import type { FrameFailure } from "@/features/preview/lib/dicom/protocol"

// One frame of a file, decoded into samples, every check made before anything is allocated for it: the frame's size
// from the tags against the pixel budget left once its encoded bytes, its decoder's working set and what the worker
// holds are counted (budget.logic.ts), and, for a compressed frame, its codestream header against the tags (the codecs,
// codestream.logic.ts). Worker-only.

export class DicomFrameFailure extends Error {
	override readonly name = "DicomFrameFailure"
	readonly reason: FrameFailure

	constructor(reason: FrameFailure, message: string) {
		super(message)
		this.reason = reason
	}
}

export interface DecodeBudget {
	readonly decodeBytes: number
	// What the worker holds while a frame decodes, apart from the frame and its codec: the file or its inflated data set,
	// the parsed header, the bridge's blocks, the frames kept.
	readonly held: () => number
	// The decoder's wasm heap as it is, or as it will start; 0 for a decoder without one.
	readonly heap: (decoder: DicomDecoder) => number
	// Once a frame has decoded (or failed to): the heap its decoder needed, so a grown heap may be let go.
	readonly settle: (decoder: DicomDecoder, need: number) => void
}

// A decoder of compressed frames (the codecs): the frame's codestream into samples. `pixels` is the budget left for
// this frame; the decoder checks its codestream header against the tags and against it before decoding.
export type CompressedDecoder = (
	encoded: Uint8Array,
	module: PixelModule,
	color: SampleColor,
	decoder: DicomDecoder,
	pixels: number
) => Promise<FrameSamples>

export interface FrameContext {
	readonly module: PixelModule
	readonly syntax: TransferSyntax
	readonly color: SampleColor
	readonly source: DicomSource
	readonly budget: DecodeBudget
	readonly compressed: CompressedDecoder | null
}

function samplesView(bytes: Uint8Array, bitsAllocated: number, littleEndian: boolean): Uint8Array | Uint16Array | Uint32Array {
	const width = bitsAllocated / 8

	if (width === 1) return bytes

	const count = bytes.length / width
	const aligned = littleEndian && bytes.byteOffset % width === 0 ? bytes : bytes.slice()

	if (!littleEndian) {
		for (let at = 0; at + width <= aligned.length; at += width) aligned.subarray(at, at + width).reverse()
	}

	return width === 2
		? new Uint16Array(aligned.buffer, aligned.byteOffset, count)
		: new Uint32Array(aligned.buffer, aligned.byteOffset, count)
}

// JPEG 2000 frames decode at a reduced resolution when the full one is over the budget.
const REDUCIBLE: ReadonlySet<DicomDecoder> = new Set(["jpeg2000", "htj2k"])

// What is read of a JPEG 2000 frame's first fragment before the rest: its main header (SIZ, COD, COC), whatever its
// size but for packed packet headers (PPM), which a frame this viewer reads does not need.
export const DICOM_J2K_HEAD_BYTES = 64 * 1024

function tooLarge(): never {
	throw new DicomFrameFailure("tooLarge", "the frame is larger than the decode budget")
}

interface Budgeted {
	readonly cost: DecoderCost
	readonly pixels: number
}

// The decoded pixels left for a frame of `encodedBytes`, checked before any of them is read: none left refuses the
// frame whatever its decoder, and so does a tags' frame that does not fit them when the decoder cannot reduce it.
function checkBudget(context: FrameContext, encodedBytes: number, encodedInPlace: boolean): Budgeted {
	const { module, syntax, source, budget } = context
	const { rows, columns, samplesPerPixel, bitsAllocated } = module
	const { decoder } = syntax
	const compressed = decoder !== "native" && decoder !== "rle"
	const cost = decoderCost({
		decoder,
		samplesPerPixel,
		sampleBytes: compressed ? (bitsAllocated > 8 ? 2 : 1) : bitsAllocated / 8,
		samplesInPlace: source.inMemory && syntax.littleEndian && bitsAllocated <= 16,
		encodedInPlace,
		gray: context.color === "gray"
	})
	const pixels = framePixels(cost, {
		decodeBytes: budget.decodeBytes,
		held: budget.held(),
		heap: budget.heap(decoder),
		encodedBytes,
		drawnPixels: MAX_BACKING_SIDE * MAX_BACKING_SIDE
	})

	if (pixels < 1 || (rows * columns > pixels && !REDUCIBLE.has(decoder))) tooLarge()

	return { cost, pixels }
}

// A JPEG 2000 frame's main header, read from the head of its first fragment, against the tags and the budget before
// the frame itself is read: refused when even its most reduced resolution does not fit.
function checkReducible(context: FrameContext, spans: readonly Span[], pixels: number): void {
	const [first] = spans

	if (first === undefined) throw new DicomFrameFailure("damaged", "a frame without fragments")

	const header = jpeg2000Header(context.source.read(first.offset, Math.min(first.length, DICOM_J2K_HEAD_BYTES)))

	if (header === null) throw new DicomFrameFailure("damaged", "the codestream header could not be read")
	if (!matchesTags(header, context.module)) throw new DicomFrameFailure("mismatch", "the codestream header does not match the tags")

	if (reductionWithin(header, pixels) === null) tooLarge()
}

function rethrow(error: unknown): never {
	if (error instanceof DicomFrameFailure) throw error
	if (error instanceof DicomFrameError || error instanceof DicomRleError) throw new DicomFrameFailure("damaged", error.message)
	if (error instanceof DicomOpenError)
		throw new DicomFrameFailure(error.reason === "unreadable" ? "unreadable" : "damaged", error.message)

	throw new DicomFrameFailure("unreadable", "the frame could not be read")
}

export function nativeFrame(context: FrameContext, index: number): FrameSamples {
	const { module, syntax, source, color } = context
	const { rows, columns, samplesPerPixel, bitsAllocated, highBit, bitsStored, frames } = module
	const frameBytes = nativeFrameBytes({ rows, columns, samplesPerPixel, bitsAllocated, subsampled: color === "ybrFull422" })

	if (frameBytes === null || module.pixelData === null) throw new DicomFrameFailure("unsupported", "no native layout")

	try {
		const span = nativeFrameSpan(module.pixelData.offset, module.pixelData.length, frameBytes, frames, index, source.size)

		checkBudget(context, span.length, source.inMemory)

		return {
			data: samplesView(source.read(span.offset, span.length), bitsAllocated, syntax.littleEndian),
			rows,
			columns,
			samplesPerPixel,
			color,
			planar: module.planar && color !== "ybrFull422",
			shift: highBit + 1 - bitsStored
		}
	} catch (error) {
		return rethrow(error)
	}
}

export function fragmentIndex(context: Pick<FrameContext, "module" | "syntax" | "source">): FragmentIndex | null {
	const { module, syntax, source } = context

	if (!syntax.encapsulated || module.pixelData === null) return null

	return new FragmentIndex({
		read: (offset, length) => source.read(offset, length),
		start: module.pixelData.offset,
		end: source.size,
		frames: module.frames,
		fragmentPerFrame: syntax.decoder === "rle",
		extendedOffsets: module.extendedOffsets
	})
}

export async function encapsulatedFrame(context: FrameContext, fragments: FragmentIndex, index: number): Promise<FrameSamples> {
	const { module, syntax, source, color } = context
	const { rows, columns, samplesPerPixel, bitsAllocated, highBit, bitsStored } = module

	try {
		const spans = fragments.frame(index)
		const encodedBytes = spansLength(spans)
		const { cost, pixels } = checkBudget(context, encodedBytes, source.inMemory && spans.length === 1)

		if (REDUCIBLE.has(syntax.decoder)) checkReducible(context, spans, pixels)

		const encoded = joinSpans((offset, length) => source.read(offset, length), spans)

		if (syntax.decoder === "rle") {
			const decoded = decodeRle(encoded, { rows, columns, samplesPerPixel, bytesPerSample: bitsAllocated / 8 })

			return {
				data: samplesView(decoded, bitsAllocated, true),
				rows,
				columns,
				samplesPerPixel,
				color,
				planar: false,
				shift: highBit + 1 - bitsStored
			}
		}

		if (context.compressed === null) throw new DicomFrameFailure("unsupported", "no decoder for this transfer syntax")

		const decoding = context.compressed
		let decodedPixels = pixels

		try {
			const decoded = await decoding(encoded, module, color, syntax.decoder, pixels)

			decodedPixels = decoded.rows * decoded.columns

			return decoded
		} finally {
			if (cost.heap) context.budget.settle(syntax.decoder, heapNeed(cost, decodedPixels, encodedBytes))
		}
	} catch (error) {
		return rethrow(error)
	}
}
