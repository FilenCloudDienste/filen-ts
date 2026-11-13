import { VideoSample, type VideoSampleSource } from "mediabunny"
import type { OutputGeometry } from "@/features/preview/videoEdit/lib/plan"
import type { HdrHandling, TimeRange, VideoEditRecipe } from "@/features/preview/videoEdit/types"
import { throwIfCancelled } from "@/features/preview/videoEdit/worker/errors"
import type { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"

// The transcode path's video: every kept frame decoded, changed as little as the recipe needs, and encoded.
// - A recipe with colour, text, a flip, a resize or a tone map goes through the one WebGL pass (gl/pipeline.ts).
// - A crop alone is a view onto the decoded frame (VideoFrame visibleRect): no pixel is copied.
// - Otherwise the decoded frame is encoded as it is.
// Rotation never touches pixels outside the GPU pass: the output track carries it as metadata.

// The frame pipeline (gl/pipeline.ts): see exportApi.ts for the orientation contract.
export interface FramePipelineLike {
	render(
		frame: VideoFrame,
		recipe: VideoEditRecipe,
		outWidth: number,
		outHeight: number,
		outputTimeSec: number,
		hdr: HdrHandling | null
	): VideoFrame
	needsGpu(recipe: VideoEditRecipe): boolean
	dispose(): void
}

// Turns one decoded frame into the frame to encode; takes ownership of `frame` (closes it, or returns it).
export type FrameStage = (frame: VideoFrame, outputTime: number) => VideoFrame

export type FrameStageKind = "gpu" | "crop" | "pass"

// Which stage a recipe needs. `pipelineWants`: the pipeline's own answer for the recipe (colour, text).
export function frameStageKind(params: {
	recipe: VideoEditRecipe
	geometry: OutputGeometry
	hdr: HdrHandling | null
	pipelineWants: boolean
}): FrameStageKind {
	const { recipe, geometry, hdr, pipelineWants } = params

	if (pipelineWants || recipe.flipH || recipe.flipV || geometry.scaled || hdr === "toSdr") {
		return "gpu"
	}

	return geometry.codedCrop === null ? "pass" : "crop"
}

// The recipe the pipeline renders: the crop in the source's coded space and the source's rotation folded into the
// user's, since decoded frames arrive unrotated (exportApi.ts).
export function pipelineRecipe(recipe: VideoEditRecipe, geometry: OutputGeometry): VideoEditRecipe {
	return { ...recipe, crop: geometry.codedCrop, rotate: geometry.rotation }
}

export function createFrameStage(params: {
	kind: FrameStageKind
	recipe: VideoEditRecipe
	geometry: OutputGeometry
	hdr: HdrHandling | null
	pipeline: FramePipelineLike | null
}): FrameStage {
	const { kind, geometry, hdr, pipeline } = params

	if (kind === "gpu") {
		if (pipeline === null) {
			throw new Error("the GPU pass is needed but no pipeline was made")
		}

		const recipe = pipelineRecipe(params.recipe, geometry)

		return (frame, outputTime) => {
			try {
				return pipeline.render(frame, recipe, geometry.width, geometry.height, outputTime, hdr)
			} finally {
				frame.close()
			}
		}
	}

	const crop = geometry.codedCrop

	if (kind === "crop" && crop !== null) {
		return frame => {
			try {
				return new VideoFrame(frame, {
					visibleRect: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
					displayWidth: crop.width,
					displayHeight: crop.height
				})
			} finally {
				frame.close()
			}
		}
	}

	return frame => frame
}

// Decoded frames of a range, in presentation order (mediabunny VideoSampleSink.samples).
export interface DecodedFrame {
	timestamp: number
	duration: number
	// Hands the frame over (the caller closes it); the sample's own hold is released.
	take(): VideoFrame
	// Drops it without taking it.
	close(): void
}

export interface TranscodeVideoParams {
	decode: (range: TimeRange) => AsyncIterable<DecodedFrame>
	ranges: readonly TimeRange[]
	speed: number
	// Frames closer together than this on the output timeline are dropped (a speed-up keeps the source's rate).
	maxFrameRate: number
	stage: FrameStage
	output: VideoSampleSource
	gate: InterleaveGate
	lane: string
	signal: AbortSignal
}

const EPSILON = 0.000_5

export async function transcodeVideo(params: TranscodeVideoParams): Promise<{ frames: number; dropped: number }> {
	const { ranges, speed, stage, output, gate, lane, signal } = params
	const minGap = 1 / params.maxFrameRate - EPSILON
	let offset = 0
	let last = Number.NEGATIVE_INFINITY
	let frames = 0
	let dropped = 0

	for (const range of ranges) {
		const end = offset + (range.end - range.start) / speed

		for await (const decoded of params.decode(range)) {
			throwIfCancelled(signal)

			// The frame showing at the range's start begins there; frames at or past its end belong to what was cut. The
			// rate is judged on the unclamped times, so that first frame never crowds out the next.
			const unclamped = offset + (decoded.timestamp - range.start) / speed
			const time = Math.max(offset, unclamped)

			if (decoded.timestamp >= range.end - EPSILON || unclamped - last < minGap) {
				decoded.close()
				dropped++

				continue
			}

			const frame = stage(decoded.take(), time)
			const duration = Math.max(EPSILON, Math.min(decoded.duration / speed, end - time))
			const sample = new VideoSample(frame, { timestamp: time, duration })

			try {
				await gate.advance(lane, time)
				throwIfCancelled(signal)
				await output.add(sample)
			} finally {
				sample.close()
				frame.close()
			}

			last = unclamped
			frames++
		}

		offset = end
	}

	gate.finish(lane)

	return { frames, dropped }
}
