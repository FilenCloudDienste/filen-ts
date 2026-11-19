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

// Makes one still of a video from a single keyframe: the probe's walkers find the keyframe (reading only
// index bytes), one packet is decoded with a flush, and the picture is drawn at the art size. Its own small
// worker, torn down when idle: the remux worker would do the same work, but its bundle carries the
// demuxer and the audio codecs' wasm, megabytes parsed on every start for a job that needs none of it.

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

const api = {
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
