/// <reference lib="webworker" />
import * as Comlink from "comlink"
import {
	BlockReadError,
	BlockSource,
	OutOfFileReadError,
	ReadBudgetError,
	type ReadRange,
	MalformedError,
	openKeyframeIndex,
	readKeyframe,
	type DecoderSetup,
	type KeyframeIndex,
	type KeyframeRef
} from "@filen/shared/videos"
import { rangePortReader } from "@/lib/media/rangePort"
import {
	FRAME_POSITIONS,
	SAMPLE_HEIGHT,
	SAMPLE_WIDTH,
	displaySize,
	fitInBox,
	nextFramePosition,
	sampleOf,
	type FrameSample,
	type Rgb,
	type Size
} from "@/lib/media/framePick.logic"
import { encodeCanvasThumb } from "@/features/drive/lib/thumbGenerators.logic"
import { frameBitmapSize, planFrameBatch } from "@/features/videos/lib/frameBatch.logic"

// Makes one still of a video from a single keyframe: the probe's walkers find the keyframe (reading only
// index bytes), one packet is decoded with a flush, and the picture is drawn at the art size. Its own small
// worker, torn down when idle: the remux worker would do the same work, but its bundle carries the
// demuxer and the audio codecs' wasm, megabytes parsed on every start for a job that needs none of it.
//
// captureMany makes a filmstrip's stills the same way, many at once: the index is opened once, one decoder
// is configured once, the keyframes are decoded in file order (the next one read while the current one
// decodes), and each frame becomes a resized ImageBitmap (no image encode) the moment it is out, the frame
// closed right after. Budgeted (keyframes per call, block reads) and cancellable between keyframes.

export type FrameMissReason = "noIndex" | "unsupported" | "decode" | "budget"

export interface FrameCaptureParams {
	// Serves the file's ranges (sdk.worker's openRangePort).
	port: MessagePort
	size: number
	maxReads: number
	// The keyframe a previous capture chose: read and decoded with nothing else.
	known: (KeyframeRef & { decoder: DecoderSetup }) | null
	// Display geometry from the probe.
	par: number
	rotation: number
	box: Size
}

export type FrameCaptureResult =
	| {
			type: "frame"
			bytes: Uint8Array
			width: number
			height: number
			dominant: Rgb
			key: KeyframeRef & { decoder: DecoderSetup }
			reads: number
	  }
	| { type: "miss"; reason: FrameMissReason; reads: number }

export interface FrameBatchParams {
	// Names the batch for cancelBatch.
	id: number
	port: MessagePort
	size: number
	maxReads: number
	// Seconds into the video.
	positions: readonly number[]
	// Distinct keyframes to decode at most (capped at FRAME_BATCH_MAX_FRAMES).
	maxFrames: number
	par: number
	rotation: number
	// Each bitmap fits this box once turned by `rotation`; it is made unturned (see frameBitmapSize).
	box: Size
}

export interface FrameBatchFrame {
	// The keyframe's own time, and the requested positions (indexes) it stands for.
	timeSec: number
	positions: number[]
	bitmap: ImageBitmap
}

export type FrameBatchResult =
	// `skipped`: positions not served (no keyframe, past the cap, the read budget spent); ask again later.
	| { type: "frames"; frames: FrameBatchFrame[]; skipped: number[]; reads: number }
	| { type: "miss"; reason: FrameMissReason; reads: number }
	| { type: "cancelled"; reads: number }

class DecodeFailedError extends Error {
	public constructor(cause: unknown) {
		super("keyframe did not decode", { cause })
		this.name = "DecodeFailedError"
	}
}

function chunkConfig(setup: DecoderSetup): VideoDecoderConfig {
	return {
		codec: setup.codec,
		codedWidth: setup.codedWidth,
		codedHeight: setup.codedHeight,
		optimizeForLatency: true,
		...(setup.description === null ? {} : { description: setup.description })
	}
}

async function decodeOne(setup: DecoderSetup, packet: Uint8Array, timeSec: number): Promise<VideoFrame> {
	const decoder = new KeyframeDecoder(setup)

	try {
		return await decoder.decode(packet, timeSec)
	} finally {
		decoder.close()
	}
}

const sampleCanvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true })

function sample(frame: VideoFrame): FrameSample {
	if (sampleContext === null) {
		throw new Error("no 2D context")
	}

	sampleContext.drawImage(frame, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)

	return sampleOf(sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)
}

// The frame as displayed (pixel aspect ratio, rotation), fitted inside the box and encoded.
async function render(frame: VideoFrame, params: FrameCaptureParams): Promise<{ bytes: Uint8Array; width: number; height: number }> {
	// The visible picture stretched by the container's aspect ratio, as a demuxer's canvas sink draws it; a
	// decoder's own display size may already carry the bitstream's, which would apply it twice.
	const visible = frame.visibleRect ?? { width: frame.codedWidth, height: frame.codedHeight }
	const display = displaySize({ width: visible.width, height: visible.height, par: params.par, rotation: params.rotation })
	const out = fitInBox(display, params.box)
	const canvas = new OffscreenCanvas(out.width, out.height)
	const context = canvas.getContext("2d")

	if (context === null) {
		throw new Error("no 2D context")
	}

	const turned = params.rotation % 180 !== 0
	const drawWidth = turned ? out.height : out.width
	const drawHeight = turned ? out.width : out.height

	context.translate(out.width / 2, out.height / 2)
	context.rotate((params.rotation * Math.PI) / 180)
	context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)

	const blob = await encodeCanvasThumb(canvas)

	return { bytes: new Uint8Array(await blob.arrayBuffer()), width: out.width, height: out.height }
}

interface Candidate {
	frame: VideoFrame
	sample: FrameSample
	key: KeyframeRef & { decoder: DecoderSetup }
}

async function decodeAt(source: BlockSource, key: KeyframeRef & { decoder: DecoderSetup }): Promise<Candidate> {
	const frame = await decodeOne(key.decoder, await readKeyframe(source, key), key.timeSec)

	try {
		return { frame, sample: sample(frame), key }
	} catch (error) {
		frame.close()

		throw error
	}
}

// Errors that say something about the file (or the read budget), as opposed to a failed download.
function isFileMiss(error: unknown): boolean {
	return (
		error instanceof ReadBudgetError ||
		error instanceof DecodeFailedError ||
		error instanceof MalformedError ||
		error instanceof OutOfFileReadError
	)
}

// The brightest of the positions tried, stopping at the first that is not dark.
async function pick(source: BlockSource): Promise<Candidate | FrameMissReason> {
	const index = await openKeyframeIndex(source)
	const duration = index?.durationSec ?? null

	if (index === null || duration === null || duration <= 0) {
		return "noIndex"
	}

	const support = await VideoDecoder.isConfigSupported(chunkConfig(index.decoder)).catch(() => null)

	if (support?.supported !== true) {
		return "unsupported"
	}

	const tried = new Set<number>()
	let best: Candidate | null = null

	try {
		for (let attempt = 0, position: number | null = FRAME_POSITIONS[0] ?? null; position !== null; attempt++) {
			const ref = await index.keyframeAt(duration * position)

			if (ref === null) {
				return best ?? "noIndex"
			}

			let luma = best?.sample.luma ?? 0

			if (!tried.has(ref.offset)) {
				tried.add(ref.offset)

				const candidate = await decodeAt(source, { ...ref, decoder: index.decoder })

				luma = candidate.sample.luma

				if (best === null || candidate.sample.luma > best.sample.luma) {
					best?.frame.close()
					best = candidate
				} else {
					candidate.frame.close()
				}
			}

			position = nextFramePosition(attempt, luma)
		}

		return best ?? "noIndex"
	} catch (error) {
		// A dark frame already in hand beats nothing when a later position cannot be had.
		if (best !== null && isFileMiss(error)) {
			return best
		}

		best?.frame.close()

		throw error
	}
}

// One configured decoder fed key packets one at a time; each decode is flushed, so its frame is out (and
// handed over) before the next packet goes in, and at most one VideoFrame is ever held.
class KeyframeDecoder {
	private readonly decoder: VideoDecoder
	private frame: VideoFrame | null = null
	private failure: unknown = null

	public constructor(setup: DecoderSetup) {
		this.decoder = new VideoDecoder({
			output: output => {
				if (this.frame === null) {
					this.frame = output
				} else {
					output.close()
				}
			},
			error: error => {
				this.failure = error
			}
		})

		try {
			this.decoder.configure(chunkConfig(setup))
		} catch (error) {
			// Surfaces from the first decode, as a DecodeFailedError.
			this.failure = error
		}
	}

	// The decoded frame, owned by the caller.
	public async decode(packet: Uint8Array, timeSec: number): Promise<VideoFrame> {
		try {
			this.decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: Math.round(timeSec * 1e6), data: packet }))
			await this.decoder.flush()
		} catch (error) {
			this.failure ??= error
		}

		const frame = this.frame

		this.frame = null

		if (frame === null) {
			throw new DecodeFailedError(this.failure)
		}

		return frame
	}

	public close(): void {
		this.frame?.close()
		this.frame = null

		if (this.decoder.state !== "closed") {
			this.decoder.close()
		}
	}
}

// Only for a browser whose createImageBitmap ignores the resize options (the bitmap comes back full size).
let resizeCanvas: OffscreenCanvas | null = null

async function frameBitmap(frame: VideoFrame, size: Size): Promise<ImageBitmap> {
	const bitmap = await createImageBitmap(frame, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "medium" })

	if (bitmap.width === size.width && bitmap.height === size.height) {
		return bitmap
	}

	bitmap.close()
	resizeCanvas ??= new OffscreenCanvas(size.width, size.height)
	resizeCanvas.width = size.width
	resizeCanvas.height = size.height

	const context = resizeCanvas.getContext("2d")

	if (context === null) {
		throw new Error("no 2D context")
	}

	context.drawImage(frame, 0, 0, size.width, size.height)

	return resizeCanvas.transferToImageBitmap()
}

// Running batches by id, with what aborts their reads.
const batches = new Map<number, AbortController>()

class BatchCancelledError extends Error {
	public constructor() {
		super("frame batch cancelled")
		this.name = "BatchCancelledError"
	}
}

// Each position's keyframe, looked up in time order so neighbouring positions share index reads (a moof, a
// run of sample sizes). Positions past a spent read budget stay null.
async function keyframesAt(index: KeyframeIndex, positions: readonly number[], signal: AbortSignal): Promise<(KeyframeRef | null)[]> {
	const refs = new Array<KeyframeRef | null>(positions.length).fill(null)
	const order = positions.map((_, i) => i).sort((a, b) => (positions[a] ?? 0) - (positions[b] ?? 0))

	for (const i of order) {
		if (signal.aborted) {
			throw new BatchCancelledError()
		}

		try {
			refs[i] = await index.keyframeAt(positions[i] ?? 0)
		} catch (error) {
			if (error instanceof ReadBudgetError) {
				break
			}

			throw error
		}
	}

	return refs
}

async function batchFrames(
	source: BlockSource,
	params: FrameBatchParams,
	signal: AbortSignal
): Promise<{ frames: FrameBatchFrame[]; skipped: number[] } | FrameMissReason> {
	const index = await openKeyframeIndex(source)

	if (index === null) {
		return "noIndex"
	}

	const support = await VideoDecoder.isConfigSupported(chunkConfig(index.decoder)).catch(() => null)

	if (support?.supported !== true) {
		return "unsupported"
	}

	const plan = planFrameBatch(await keyframesAt(index, params.positions, signal), params.maxFrames)
	const frames: FrameBatchFrame[] = []
	const decoder = new KeyframeDecoder(index.decoder)
	// Reads run one keyframe ahead of the decoder; a failed read is only reported once its turn comes.
	const read = (at: number): Promise<Uint8Array> | null => {
		const slot = plan.slots[at]

		if (slot === undefined) {
			return null
		}

		const pending = readKeyframe(source, slot.ref)

		pending.catch(() => undefined)

		return pending
	}
	const unserved = (): number[] => {
		const served = new Set(frames.flatMap(frame => frame.positions))

		return params.positions.map((_, i) => i).filter(i => !served.has(i))
	}

	try {
		let next = read(0)

		for (let at = 0; at < plan.slots.length && next !== null; at++) {
			if (signal.aborted) {
				throw new BatchCancelledError()
			}

			let packet: Uint8Array

			try {
				packet = await next
			} catch (error) {
				// Out of reads: what is made stands, the rest is asked for again.
				if (error instanceof ReadBudgetError && frames.length > 0) {
					break
				}

				throw error
			}

			const slot = plan.slots[at]

			next = read(at + 1)

			if (slot === undefined) {
				break
			}

			const frame = await decoder.decode(packet, slot.ref.timeSec)

			try {
				const visible = frame.visibleRect ?? { width: frame.codedWidth, height: frame.codedHeight }
				const bitmap = await frameBitmap(frame, frameBitmapSize(visible, params.par, params.rotation, params.box))

				frames.push({ timeSec: slot.ref.timeSec, positions: slot.positions, bitmap })
			} finally {
				frame.close()
			}
		}
	} catch (error) {
		// A keyframe the file could not give (it did not decode, its bytes were not where the index said)
		// ends the batch with what was made; a cancel or a failed download drops it all.
		if (
			frames.length > 0 &&
			(error instanceof DecodeFailedError || error instanceof MalformedError || error instanceof OutOfFileReadError)
		) {
			return { frames, skipped: unserved() }
		}

		for (const frame of frames) {
			frame.bitmap.close()
		}

		throw error
	} finally {
		decoder.close()
	}

	return { frames, skipped: unserved() }
}

const api = {
	async captureMany(params: FrameBatchParams): Promise<FrameBatchResult> {
		const reader = rangePortReader(params.port)
		const controller = new AbortController()
		let reads = 0
		const readRange: ReadRange = (start, end) => {
			reads++

			return reader.readRange(start, end, controller.signal)
		}
		const source = new BlockSource(params.size, readRange, { maxBlockReads: params.maxReads, cachedBlocks: 4 })

		batches.set(params.id, controller)

		try {
			const result = await batchFrames(source, params, controller.signal)

			if (typeof result === "string") {
				return { type: "miss", reason: result === "noIndex" && source.blockReads >= params.maxReads ? "budget" : result, reads }
			}

			return Comlink.transfer(
				{ type: "frames", ...result, reads },
				result.frames.map(frame => frame.bitmap)
			)
		} catch (error) {
			if (controller.signal.aborted) {
				return { type: "cancelled", reads }
			}

			if (error instanceof ReadBudgetError) {
				return { type: "miss", reason: "budget", reads }
			}

			if (error instanceof DecodeFailedError) {
				return { type: "miss", reason: "decode", reads }
			}

			if (error instanceof MalformedError || error instanceof OutOfFileReadError) {
				return { type: "miss", reason: "noIndex", reads }
			}

			// A failed download says nothing about the file.
			throw error instanceof BlockReadError ? error : new Error("frame batch failed", { cause: error })
		} finally {
			batches.delete(params.id)
			controller.abort()
			reader.close()
		}
	},

	// Stops a running batch between keyframes and aborts its reads: it resolves as cancelled, stills closed.
	cancelBatch(id: number): void {
		batches.get(id)?.abort()
	},

	async capture(params: FrameCaptureParams): Promise<FrameCaptureResult> {
		const reader = rangePortReader(params.port)
		const controller = new AbortController()
		let reads = 0
		const readRange: ReadRange = (start, end) => {
			reads++

			return reader.readRange(start, end, controller.signal)
		}
		const source = new BlockSource(params.size, readRange, { maxBlockReads: params.maxReads, cachedBlocks: 4 })
		let chosen: Candidate | null = null

		try {
			const picked = params.known === null ? await pick(source) : await decodeAt(source, params.known)

			if (typeof picked === "string") {
				// A walk cut short by the budget finds no index either.
				return { type: "miss", reason: picked === "noIndex" && source.blockReads >= params.maxReads ? "budget" : picked, reads }
			}

			chosen = picked

			const rendered = await render(chosen.frame, params)

			return Comlink.transfer({ type: "frame", ...rendered, dominant: chosen.sample.dominant, key: chosen.key, reads }, [
				rendered.bytes.buffer
			])
		} catch (error) {
			if (error instanceof ReadBudgetError) {
				return { type: "miss", reason: "budget", reads }
			}

			if (error instanceof DecodeFailedError) {
				return { type: "miss", reason: "decode", reads }
			}

			if (error instanceof MalformedError || error instanceof OutOfFileReadError) {
				return { type: "miss", reason: "noIndex", reads }
			}

			// A failed download says nothing about the file.
			throw error instanceof BlockReadError ? error : new Error("frame capture failed", { cause: error })
		} finally {
			chosen?.frame.close()
			controller.abort()
			reader.close()
		}
	}
}

export type FrameWorkerApi = typeof api

Comlink.expose(api)
