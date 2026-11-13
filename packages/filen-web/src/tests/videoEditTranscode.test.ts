import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioSample, type AudioSampleSource, type VideoSample, type VideoSampleSource } from "mediabunny"
import { outputGeometry } from "@/features/preview/videoEdit/lib/plan"
import { gainFactor, RangeAudio, transcodeAudio, type TimeStretchLike } from "@/features/preview/videoEdit/worker/audio"
import { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"
import {
	createFrameStage,
	frameStageKind,
	pipelineRecipe,
	transcodeVideo,
	type DecodedFrame,
	type FramePipelineLike
} from "@/features/preview/videoEdit/worker/transcode"
import type { TimeRange } from "@/features/preview/videoEdit/types"
import { recipeFor, sourceInfo } from "@/tests/support/videoEditRecipe"

// The transcode path's frame and sample handling, with WebCodecs stubbed: a VideoFrame stand-in that records how it
// was made and whether it was closed.

class FakeVideoFrame {
	public static made: FakeVideoFrame[] = []
	public readonly format = "I420"
	public readonly codedWidth: number
	public readonly codedHeight: number
	public readonly displayWidth: number
	public readonly displayHeight: number
	public readonly visibleRect: { x: number; y: number; width: number; height: number }
	public readonly timestamp: number
	public readonly duration: number
	public readonly colorSpace = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false }
	public readonly from: FakeVideoFrame | null
	public closed = false

	public constructor(
		source: FakeVideoFrame | { width: number; height: number; timestamp: number },
		init: { visibleRect?: { x: number; y: number; width: number; height: number }; displayWidth?: number; displayHeight?: number } = {}
	) {
		const parent = source instanceof FakeVideoFrame ? source : null
		const width = parent?.codedWidth ?? (source as { width: number }).width
		const height = parent?.codedHeight ?? (source as { height: number }).height

		this.from = parent
		this.codedWidth = width
		this.codedHeight = height
		this.visibleRect = init.visibleRect ?? parent?.visibleRect ?? { x: 0, y: 0, width, height }
		this.displayWidth = init.displayWidth ?? this.visibleRect.width
		this.displayHeight = init.displayHeight ?? this.visibleRect.height
		this.timestamp = parent?.timestamp ?? (source as { timestamp: number }).timestamp
		this.duration = 0
		FakeVideoFrame.made.push(this)
	}

	public close(): void {
		this.closed = true
	}
}

function frame(timestamp = 0): VideoFrame {
	return new FakeVideoFrame({ width: 1920, height: 1080, timestamp }) as unknown as VideoFrame
}

beforeEach(() => {
	FakeVideoFrame.made = []
	vi.stubGlobal("VideoFrame", FakeVideoFrame)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("frame stages", () => {
	const source = sourceInfo()

	it("picks the cheapest stage the recipe allows", () => {
		const kind = (overrides: Parameters<typeof recipeFor>[1], hdr: "toSdr" | "hevc10" | null = null, wants = false): string => {
			const recipe = recipeFor(60, overrides)

			return frameStageKind({ recipe, geometry: outputGeometry(recipe, source), hdr, pipelineWants: wants })
		}

		expect(kind({})).toBe("pass")
		expect(kind({ rotate: 90 })).toBe("pass")
		expect(kind({ output: { resolution: "original", quality: "low" } })).toBe("pass")
		expect(kind({ crop: { x: 0, y: 0, width: 960, height: 540 } })).toBe("crop")
		expect(kind({ crop: { x: 0, y: 0, width: 960, height: 540 }, rotate: 270 })).toBe("crop")
		expect(kind({ flipV: true })).toBe("gpu")
		expect(kind({ output: { resolution: 720, quality: "high" } })).toBe("gpu")
		expect(kind({}, "toSdr")).toBe("gpu")
		expect(kind({}, "hevc10")).toBe("pass")
		expect(kind({}, null, true)).toBe("gpu")
	})

	it("hands the pipeline coded-space geometry with the source's rotation folded in", () => {
		const rotated = sourceInfo({ rotation: 90, width: 1080, height: 1920 })
		const recipe = recipeFor(60, { rotate: 90, crop: { x: 0, y: 0, width: 1080, height: 960 } })
		const geometry = outputGeometry(recipe, rotated)
		const handed = pipelineRecipe(recipe, geometry)

		expect(handed.rotate).toBe(180)
		expect(handed.crop).toEqual({ x: 0, y: 0, width: 960, height: 1080 })
		expect(handed.flipH).toBe(recipe.flipH)
	})

	it("crops by a view onto the decoded frame and closes the original", () => {
		const recipe = recipeFor(60, { crop: { x: 100, y: 50, width: 640, height: 360 } })
		const stage = createFrameStage({ kind: "crop", recipe, geometry: outputGeometry(recipe, source), hdr: null, pipeline: null })
		const input = frame()
		const output = stage(input, 0) as unknown as FakeVideoFrame

		expect(output.from).toBe(input)
		expect(output.visibleRect).toEqual({ x: 100, y: 50, width: 640, height: 360 })
		expect([output.displayWidth, output.displayHeight]).toEqual([640, 360])
		expect((input as unknown as FakeVideoFrame).closed).toBe(true)
	})

	it("passes an untouched frame through", () => {
		const recipe = recipeFor(60)
		const stage = createFrameStage({ kind: "pass", recipe, geometry: outputGeometry(recipe, source), hdr: null, pipeline: null })
		const input = frame()

		expect(stage(input, 0)).toBe(input)
	})

	it("renders through the GPU pass and closes the decoded frame", () => {
		const recipe = recipeFor(60, { flipH: true, output: { resolution: 720, quality: "high" } })
		const geometry = outputGeometry(recipe, source)
		const rendered = frame()
		const render = vi.fn(() => rendered)
		const pipeline: FramePipelineLike = {
			render,
			needsGpu: () => true,
			dispose: vi.fn()
		}
		const stage = createFrameStage({ kind: "gpu", recipe, geometry, hdr: "toSdr", pipeline })
		const input = frame()

		expect(stage(input, 1.5)).toBe(rendered)
		expect(render).toHaveBeenCalledWith(input, pipelineRecipe(recipe, geometry), 1280, 720, 1.5, "toSdr")
		expect((input as unknown as FakeVideoFrame).closed).toBe(true)
	})

	it("closes the decoded frame even when the GPU pass throws", () => {
		const recipe = recipeFor(60, { flipH: true })
		const pipeline: FramePipelineLike = {
			render: () => {
				throw new Error("context lost")
			},
			needsGpu: () => true,
			dispose: () => undefined
		}
		const stage = createFrameStage({ kind: "gpu", recipe, geometry: outputGeometry(recipe, source), hdr: null, pipeline })
		const input = frame()

		expect(() => stage(input, 0)).toThrow("context lost")
		expect((input as unknown as FakeVideoFrame).closed).toBe(true)
	})
})

function decodedAt(fps: number, until: number): (range: TimeRange) => AsyncIterable<DecodedFrame> {
	return async function* (range) {
		// As VideoSampleSink.samples: from the frame showing at the start, up to the end.
		const first = Math.floor(range.start * fps + 1e-9)

		for (let index = first; index / fps < Math.min(range.end, until); index++) {
			// A decoder answers asynchronously.
			await Promise.resolve()

			const decoded = frame(index / fps)

			yield {
				timestamp: index / fps,
				duration: 1 / fps,
				take: () => decoded,
				close: () => {
					decoded.close()
				}
			}
		}
	}
}

function recordingVideoOutput(): { output: VideoSampleSource; samples: { timestamp: number; duration: number }[] } {
	const samples: { timestamp: number; duration: number }[] = []

	return {
		samples,
		output: {
			add: (sample: VideoSample) => {
				samples.push({ timestamp: sample.timestamp, duration: sample.duration })

				return Promise.resolve()
			}
		} as unknown as VideoSampleSource
	}
}

describe("transcodeVideo", () => {
	it("lays the kept ranges end to end and closes every frame", async () => {
		const { output, samples } = recordingVideoOutput()
		const gate = new InterleaveGate(1)

		gate.addLane("video")

		const result = await transcodeVideo({
			decode: decodedAt(10, 10),
			ranges: [
				{ start: 1.05, end: 2 },
				{ start: 5, end: 5.5 }
			],
			speed: 1,
			maxFrameRate: 10,
			stage: decodedFrame => decodedFrame,
			output,
			gate,
			lane: "video",
			signal: new AbortController().signal
		})

		// The frame showing at 1.05 (1.0) starts the output; 2.0 and 5.5 were cut.
		expect(samples.map(sample => Math.round(sample.timestamp * 100) / 100)).toEqual([
			0, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.15, 1.25, 1.35
		])
		expect(result.frames).toBe(15)
		expect(FakeVideoFrame.made.every(made => made.closed)).toBe(true)
	})

	it("speeds up by dropping frames above the source's rate", async () => {
		const { output, samples } = recordingVideoOutput()
		const gate = new InterleaveGate(1)

		gate.addLane("video")

		const result = await transcodeVideo({
			decode: decodedAt(30, 10),
			ranges: [{ start: 0, end: 2 }],
			speed: 2,
			maxFrameRate: 30,
			stage: decodedFrame => decodedFrame,
			output,
			gate,
			lane: "video",
			signal: new AbortController().signal
		})

		expect(samples.length).toBe(30)
		expect(result.dropped).toBe(30)
		expect(samples[1]?.timestamp).toBeCloseTo(1 / 30)
		expect(samples.at(-1)?.timestamp).toBeLessThan(1)
		expect(FakeVideoFrame.made.every(made => made.closed)).toBe(true)
	})

	it("stops on cancel", async () => {
		const { output } = recordingVideoOutput()
		const gate = new InterleaveGate(1)
		const controller = new AbortController()

		gate.addLane("video")
		controller.abort()

		await expect(
			transcodeVideo({
				decode: decodedAt(30, 10),
				ranges: [{ start: 0, end: 2 }],
				speed: 1,
				maxFrameRate: 30,
				stage: decodedFrame => decodedFrame,
				output,
				gate,
				lane: "video",
				signal: controller.signal
			})
		).rejects.toMatchObject({ name: "ExportCancelledError" })
	})
})

// A stretch that returns a little less than speed says (as WSOLA's windows do) and keeps a tail for flush().
function lossyStretch(speed: number): TimeStretchLike {
	let carry = 0

	return {
		push: planar => {
			const length = planar[0]?.length ?? 0
			const out = Math.floor((length + carry) / speed) - 3

			carry = (length + carry) % speed

			return planar.map(() => new Float32Array(Math.max(0, out)).fill(0.5))
		},
		flush: () => [new Float32Array(5).fill(0.25), new Float32Array(5).fill(0.25)]
	}
}

describe("RangeAudio", () => {
	it("cuts sample-exactly at the range's edges", () => {
		const audio = new RangeAudio({ sampleRate: 1000, channels: 1, gainDb: 0, speed: 1, createStretch: null })
		const plane = Float32Array.from({ length: 1000 }, (_, index) => index)

		audio.begin({ start: 0.25, end: 0.75 })

		const kept = audio.push([plane], 0)

		expect(kept?.[0]?.length).toBe(500)
		expect(kept?.[0]?.[0]).toBe(250)
		expect(kept?.[0]?.at(-1)).toBe(749)
		expect([...audio.end()]).toEqual([])
		expect(audio.written).toBe(500)
	})

	it("matches the video's running length to the sample over many joins, padding and trimming the stretch", () => {
		const sampleRate = 48_000
		const audio = new RangeAudio({ sampleRate, channels: 2, gainDb: 0, speed: 1.5, createStretch: () => lossyStretch(1.5) })
		const ranges = Array.from({ length: 12 }, (_, index) => ({ start: index * 3 + 0.013 * index, end: index * 3 + 1 + 0.071 * index }))
		let elapsed = 0

		for (const range of ranges) {
			audio.begin(range)

			// Decoded in 1024-frame blocks covering the range.
			for (let at = Math.floor((range.start * sampleRate) / 1024) * 1024; at < range.end * sampleRate; at += 1024) {
				audio.push([new Float32Array(1024), new Float32Array(1024)], at / sampleRate)
			}

			for (const planes of audio.end()) {
				expect(planes.length).toBe(2)
			}

			elapsed += range.end - range.start

			expect(audio.written).toBe(Math.round((elapsed / 1.5) * sampleRate))
		}
	})

	it("fills a range whose source audio ran out with silence", () => {
		const audio = new RangeAudio({ sampleRate: 100, channels: 1, gainDb: 0, speed: 1, createStretch: null })

		audio.begin({ start: 0, end: 200 })

		const blocks = [...audio.end()]

		expect(blocks.reduce((total, planes) => total + (planes[0]?.length ?? 0), 0)).toBe(20_000)
		expect(blocks.every(planes => (planes[0]?.length ?? 0) <= 8192)).toBe(true)
	})

	it("applies the gain and clips at full scale", () => {
		const audio = new RangeAudio({ sampleRate: 10, channels: 1, gainDb: 6, speed: 1, createStretch: null })

		audio.begin({ start: 0, end: 1 })

		const out = audio.push([Float32Array.from([0.1, -0.2, 0.9, -0.9, 0, 0, 0, 0, 0, 0])], 0)

		expect(out?.[0]?.[0]).toBeCloseTo(0.1 * gainFactor(6))
		expect(out?.[0]?.[1]).toBeCloseTo(-0.2 * gainFactor(6))
		expect(out?.[0]?.[2]).toBe(1)
		expect(out?.[0]?.[3]).toBe(-1)
		expect(gainFactor(0)).toBe(1)
		expect(gainFactor(-6)).toBeCloseTo(0.501, 3)
	})

	it("stands the first plane in for a channel the decoder did not return", () => {
		const audio = new RangeAudio({ sampleRate: 10, channels: 2, gainDb: 0, speed: 1, createStretch: null })

		audio.begin({ start: 0, end: 1 })

		const out = audio.push([new Float32Array(10).fill(0.3)], 0)

		expect(out?.[1]?.[0]).toBeCloseTo(0.3)
	})
})

describe("transcodeAudio", () => {
	it("encodes contiguous samples whose total matches the kept duration", async () => {
		const added: { timestamp: number; frames: number }[] = []
		const output = {
			add: (sample: AudioSample) => {
				added.push({ timestamp: sample.timestamp, frames: sample.numberOfFrames })

				return Promise.resolve()
			}
		} as unknown as AudioSampleSource
		const sampleRate = 8000
		const decode = async function* (range: TimeRange): AsyncGenerator<AudioSample> {
			for (let at = Math.floor(range.start * 8); at < range.end * 8; at++) {
				await Promise.resolve()

				yield new AudioSample({
					data: new Float32Array(1000 * 2),
					format: "f32-planar",
					numberOfChannels: 2,
					sampleRate,
					timestamp: at / 8
				})
			}
		}
		const gate = new InterleaveGate(1)

		gate.addLane("audio1")

		const ranges = [
			{ start: 0.3, end: 1.1 },
			{ start: 4, end: 4.55 }
		]

		await transcodeAudio({
			decode,
			bounds: ranges,
			audio: new RangeAudio({ sampleRate, channels: 2, gainDb: 0, speed: 1, createStretch: null }),
			sampleRate,
			output,
			gate,
			lane: "audio1",
			signal: new AbortController().signal
		})

		let expected = 0

		for (const sample of added) {
			expect(sample.timestamp).toBeCloseTo(expected / sampleRate, 9)
			expected += sample.frames
		}

		expect(expected).toBe(Math.round((0.8 + 0.55) * sampleRate))
	})
})
