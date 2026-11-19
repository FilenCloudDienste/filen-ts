import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioSample, type AudioSampleSource, type VideoSample, type VideoSampleSource } from "mediabunny"
import { outputGeometry } from "@/features/preview/videoEdit/lib/plan"
import {
	decodedAudioFormat,
	gainFactor,
	RangeAudio,
	transcodeAudio,
	type PlanarSampleLike,
	type TimeStretchLike
} from "@/features/preview/videoEdit/worker/audio"
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
		const kind = (overrides: Parameters<typeof recipeFor>[1], hdr: "toSdr" | "hevc10" | null = null): string => {
			const recipe = recipeFor(60, overrides)

			return frameStageKind({ recipe, geometry: outputGeometry(recipe, source), hdr })
		}

		expect(kind({})).toBe("pass")
		expect(kind({ rotate: 90 })).toBe("pass")
		expect(kind({ keep: [{ start: 1, end: 2 }], speed: 2 })).toBe("pass")
		expect(kind({ audio: { mute: true, gainDb: 3, keepTracks: [1] } })).toBe("pass")
		expect(kind({ flipH: true })).toBe("gpu")
		expect(kind({ output: { resolution: "original", quality: "low" } })).toBe("pass")
		expect(kind({ crop: { x: 0, y: 0, width: 960, height: 540 } })).toBe("crop")
		expect(kind({ crop: { x: 0, y: 0, width: 960, height: 540 }, rotate: 270 })).toBe("crop")
		expect(kind({ flipV: true })).toBe("gpu")
		expect(kind({ output: { resolution: 720, quality: "high" } })).toBe("gpu")
		expect(kind({}, "toSdr")).toBe("gpu")
		expect(kind({}, "hevc10")).toBe("pass")
		expect(kind({ filter: "vivid" })).toBe("gpu")
		expect(
			kind({ text: [{ id: "t", text: "Hi", startSec: 0, endSec: 1, x: 0.5, y: 0.5, size: 0.1, color: "#fff", background: false }] })
		).toBe("gpu")
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

	it("crops by a view onto the decoded frame and closes the original", async () => {
		const recipe = recipeFor(60, { crop: { x: 100, y: 50, width: 640, height: 360 } })
		const stage = createFrameStage({ kind: "crop", recipe, geometry: outputGeometry(recipe, source), hdr: null, pipeline: null })
		const input = frame()
		const output = (await stage(input, 0)) as unknown as FakeVideoFrame

		expect(output.from).toBe(input)
		expect(output.visibleRect).toEqual({ x: 100, y: 50, width: 640, height: 360 })
		expect([output.displayWidth, output.displayHeight]).toEqual([640, 360])
		expect((input as unknown as FakeVideoFrame).closed).toBe(true)
	})

	it("crops an anamorphic source in coded pixels and keeps its square-pixel display size", async () => {
		const anamorphic = sourceInfo({ width: 854, height: 480, codedWidth: 720, codedHeight: 480 })
		const recipe = recipeFor(60, { crop: { x: 100, y: 0, width: 400, height: 480 } })
		const stage = createFrameStage({ kind: "crop", recipe, geometry: outputGeometry(recipe, anamorphic), hdr: null, pipeline: null })
		const input = new FakeVideoFrame({ width: 720, height: 480, timestamp: 0 }) as unknown as VideoFrame
		const output = (await stage(input, 0)) as unknown as FakeVideoFrame

		expect(output.visibleRect).toEqual({ x: 84, y: 0, width: 336, height: 480 })
		expect([output.displayWidth, output.displayHeight]).toEqual([399, 480])
	})

	it("labels a whole anamorphic frame with its square-pixel size where the decoder reports the coded one", async () => {
		const anamorphic = sourceInfo({ width: 854, height: 480, codedWidth: 720, codedHeight: 480 })
		const recipe = recipeFor(60)
		const stage = createFrameStage({ kind: "pass", recipe, geometry: outputGeometry(recipe, anamorphic), hdr: null, pipeline: null })
		const input = new FakeVideoFrame({ width: 720, height: 480, timestamp: 0 }) as unknown as VideoFrame
		const output = (await stage(input, 0)) as unknown as FakeVideoFrame

		expect([output.displayWidth, output.displayHeight]).toEqual([854, 480])
		expect(output.visibleRect).toEqual({ x: 0, y: 0, width: 720, height: 480 })
		expect((input as unknown as FakeVideoFrame).closed).toBe(true)
	})

	it("never sends kept HDR through the GPU pass", () => {
		const recipe = recipeFor(60, { flipH: true })
		const pipeline: FramePipelineLike = { renderAsync: vi.fn(), dispose: vi.fn() }

		expect(() => createFrameStage({ kind: "gpu", recipe, geometry: outputGeometry(recipe, source), hdr: "hevc10", pipeline })).toThrow()
	})

	it("passes an untouched frame through", async () => {
		const recipe = recipeFor(60)
		const stage = createFrameStage({ kind: "pass", recipe, geometry: outputGeometry(recipe, source), hdr: null, pipeline: null })
		const input = frame()

		expect(await stage(input, 0)).toBe(input)
	})

	it("renders through the GPU pass and closes the decoded frame", async () => {
		const recipe = recipeFor(60, { flipH: true, output: { resolution: 720, quality: "high" } })
		const geometry = outputGeometry(recipe, source)
		const rendered = frame()
		const render = vi.fn(() => Promise.resolve(rendered))
		const pipeline: FramePipelineLike = {
			renderAsync: render,
			dispose: vi.fn()
		}
		const stage = createFrameStage({ kind: "gpu", recipe, geometry, hdr: "toSdr", pipeline })
		const input = frame()

		expect(await stage(input, 1.5)).toBe(rendered)
		expect(render).toHaveBeenCalledWith(input, pipelineRecipe(recipe, geometry), 1280, 720, 1.5, "toSdr")
		expect((input as unknown as FakeVideoFrame).closed).toBe(true)
	})

	it("closes the decoded frame even when the GPU pass throws", async () => {
		const recipe = recipeFor(60, { flipH: true })
		const pipeline: FramePipelineLike = {
			renderAsync: () => Promise.reject(new Error("context lost")),
			dispose: () => undefined
		}
		const stage = createFrameStage({ kind: "gpu", recipe, geometry: outputGeometry(recipe, source), hdr: null, pipeline })
		const input = frame()

		await expect(stage(input, 0)).rejects.toThrow("context lost")
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
			stage: decodedFrame => Promise.resolve(decodedFrame),
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
			stage: decodedFrame => Promise.resolve(decodedFrame),
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
				stage: decodedFrame => Promise.resolve(decodedFrame),
				output,
				gate,
				lane: "video",
				signal: controller.signal
			})
		).rejects.toMatchObject({ name: "ExportCancelledError" })
	})

	it("stops when cancelled mid-run and closes every frame it made", async () => {
		const { output, samples } = recordingVideoOutput()
		const gate = new InterleaveGate(1)
		const controller = new AbortController()
		let staged = 0

		gate.addLane("video")

		await expect(
			transcodeVideo({
				decode: decodedAt(30, 10),
				ranges: [{ start: 0, end: 2 }],
				speed: 1,
				maxFrameRate: 30,
				stage: decodedFrame => {
					staged++

					if (staged === 3) {
						controller.abort()
					}

					return Promise.resolve(decodedFrame)
				},
				output,
				gate,
				lane: "video",
				signal: controller.signal
			})
		).rejects.toMatchObject({ name: "ExportCancelledError" })

		expect(staged).toBe(3)
		expect(samples.length).toBeLessThan(3)
		expect(FakeVideoFrame.made.length).toBeGreaterThanOrEqual(3)
		expect(FakeVideoFrame.made.every(made => made.closed)).toBe(true)
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

// A decoded sample over `planes`, copying out as AudioSample.copyTo does; counts the frames it copied.
function planarOf(planes: readonly Float32Array[], timestamp: number, copied = { frames: 0 }): PlanarSampleLike {
	return {
		timestamp,
		numberOfFrames: planes[0]?.length ?? 0,
		numberOfChannels: planes.length,
		copyTo: (destination, options) => {
			const plane = planes[options.planeIndex] ?? new Float32Array(0)

			copied.frames += options.frameCount
			destination.set(plane.subarray(options.frameOffset, options.frameOffset + options.frameCount))
		}
	}
}

describe("RangeAudio", () => {
	it("copies only the kept frames, into one buffer reused across samples", () => {
		const audio = new RangeAudio({ sampleRate: 1000, channels: 2, gainDb: 0, speed: 1, createStretch: null })
		const copied = { frames: 0 }

		audio.begin({ start: 0.25, end: 1.75 })

		const first = audio.push(planarOf([new Float32Array(1000), new Float32Array(1000)], 0, copied))
		const second = audio.push(planarOf([new Float32Array(1000), new Float32Array(1000)], 1, copied))

		expect(copied.frames).toBe(2 * 750 + 2 * 750)
		expect(first?.[0]?.length).toBe(750)
		expect(second?.[0]?.buffer).toBe(second?.[1]?.buffer)
		expect(second?.[0]?.buffer).toBe(first?.[0]?.buffer)
	})

	it("cuts sample-exactly at the range's edges", () => {
		const audio = new RangeAudio({ sampleRate: 1000, channels: 1, gainDb: 0, speed: 1, createStretch: null })
		const plane = Float32Array.from({ length: 1000 }, (_, index) => index)

		audio.begin({ start: 0.25, end: 0.75 })

		const kept = audio.push(planarOf([plane], 0))

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
				audio.push(planarOf([new Float32Array(1024), new Float32Array(1024)], at / sampleRate))
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

		const out = audio.push(planarOf([Float32Array.from([0.1, -0.2, 0.9, -0.9, 0, 0, 0, 0, 0, 0])], 0))

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

		const out = audio.push(planarOf([new Float32Array(10).fill(0.3)], 0))

		expect(out?.[1]?.[0]).toBeCloseTo(0.3)
	})
})

describe("RangeAudio gaps", () => {
	// Runs `samples` (timestamp, frames) of ones through one range, as transcodeAudio does: each sample's gap, then the
	// sample, then the range's end. Returns what came out, a 0 for silence and a 1 for audio per frame.
	function lay(audio: RangeAudio, range: TimeRange, samples: readonly [number, number][]): { out: number[]; trailing: number } {
		const out: number[] = []
		let trailing = 0

		audio.begin(range)

		for (const [timestamp, count] of samples) {
			const sample = planarOf([new Float32Array(count).fill(1)], timestamp)

			for (const planes of audio.gap(sample)) {
				out.push(...(planes[0] ?? []))
			}

			out.push(...(audio.push(sample)?.[0] ?? []))
		}

		for (const planes of audio.end()) {
			trailing += planes[0]?.length ?? 0
			out.push(...(planes[0] ?? []))
		}

		return { out, trailing }
	}

	const mono = (): RangeAudio => new RangeAudio({ sampleRate: 1000, channels: 1, gainDb: 0, speed: 1, createStretch: null })

	it("lays a track that starts late after that much silence, with no pad at the end", () => {
		const samples = Array.from({ length: 15 }, (_, index): [number, number] => [0.5 + index * 0.1, 100])
		const { out, trailing } = lay(mono(), { start: 0, end: 2 }, samples)

		expect(out).toHaveLength(2000)
		expect(out.slice(0, 500).every(value => value === 0)).toBe(true)
		expect(out.slice(500).every(value => value === 1)).toBe(true)
		expect(trailing).toBe(0)
	})

	it("keeps a hole in the middle in place", () => {
		const before = Array.from({ length: 10 }, (_, index): [number, number] => [index * 0.1, 100])
		const after = Array.from({ length: 5 }, (_, index): [number, number] => [1.5 + index * 0.1, 100])
		const { out } = lay(mono(), { start: 0, end: 2 }, [...before, ...after])

		expect(out).toHaveLength(2000)
		expect(out.slice(0, 1000).every(value => value === 1)).toBe(true)
		expect(out.slice(1000, 1500).every(value => value === 0)).toBe(true)
		expect(out.slice(1500).every(value => value === 1)).toBe(true)
	})

	it("inserts nothing for a gap under a packet, as AAC priming and timestamp jitter make", () => {
		const { out, trailing } = lay(mono(), { start: 0, end: 1 }, [
			[0.05, 100],
			[0.2, 100],
			[0.3, 100]
		])

		expect(out.slice(0, 300).every(value => value === 1)).toBe(true)
		expect(trailing).toBe(700)
	})

	it("feeds a gap's silence through the stretch, keeping the range's frame count exact", () => {
		const sampleRate = 48_000
		const audio = new RangeAudio({ sampleRate, channels: 2, gainDb: 0, speed: 1.5, createStretch: () => lossyStretch(1.5) })
		const pushed: number[] = []
		const stretch = lossyStretch(1.5)
		const spy: TimeStretchLike = {
			push: planar => {
				pushed.push(planar[0]?.length ?? 0)

				return stretch.push(planar)
			},
			flush: () => stretch.flush()
		}
		const spied = new RangeAudio({ sampleRate, channels: 2, gainDb: 0, speed: 1.5, createStretch: () => spy })

		for (const target of [audio, spied]) {
			target.begin({ start: 0, end: 3 })

			for (let at = 1; at < 3; at += 1024 / sampleRate) {
				const sample = planarOf([new Float32Array(1024), new Float32Array(1024)], at)

				for (const planes of target.gap(sample)) {
					expect(planes).toHaveLength(2)
				}

				target.push(sample)
			}

			for (const planes of target.end()) {
				expect(planes).toHaveLength(2)
			}

			expect(target.written).toBe(Math.round((3 / 1.5) * sampleRate))
		}

		// The second's silence went through the stretch before the audio did.
		expect(pushed.slice(0, 6).reduce((total, frames) => total + frames, 0)).toBe(sampleRate)
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

	it("encodes at the decoder's rate and channels where the track declares others (implicit HE-AAC v2)", async () => {
		const added: { sampleRate: number; channels: number; frames: number }[] = []
		const output = {
			add: (sample: AudioSample) => {
				added.push({ sampleRate: sample.sampleRate, channels: sample.numberOfChannels, frames: sample.numberOfFrames })

				return Promise.resolve()
			}
		} as unknown as AudioSampleSource
		// The track says 24 kHz mono; every decoded sample is 48 kHz stereo, 2048 frames.
		const decodedRate = 48_000
		const closed: boolean[] = []
		const decode = async function* (range: TimeRange): AsyncGenerator<AudioSample> {
			const step = 2048 / decodedRate

			for (let at = Math.floor(range.start / step) * step; at < range.end; at += step) {
				await Promise.resolve()

				const sample = new AudioSample({
					data: new Float32Array(2048 * 2).fill(0.25),
					format: "f32-planar",
					numberOfChannels: 2,
					sampleRate: decodedRate,
					timestamp: at
				})
				const close = sample.close.bind(sample)

				closed.push(false)

				const index = closed.length - 1

				sample.close = () => {
					closed[index] = true
					close()
				}

				yield sample
			}
		}
		const range = { start: 0.5, end: 2 }
		const format = await decodedAudioFormat(decode, [range], { sampleRate: 24_000, channels: 1 })

		expect(format).toEqual({ sampleRate: decodedRate, channels: 2 })
		expect(closed).toEqual([true])

		const gate = new InterleaveGate(1)

		gate.addLane("audio1")

		await transcodeAudio({
			decode,
			bounds: [range],
			audio: new RangeAudio({ ...format, gainDb: 0, speed: 1, createStretch: null }),
			sampleRate: format.sampleRate,
			output,
			gate,
			lane: "audio1",
			signal: new AbortController().signal
		})

		expect(added.every(sample => sample.sampleRate === decodedRate && sample.channels === 2)).toBe(true)
		// The whole range, at the decoded rate.
		expect(added.reduce((total, sample) => total + sample.frames, 0)).toBe(Math.round(1.5 * decodedRate))
	})

	it("keeps the declared format where nothing decodes in the range", async () => {
		const decode = async function* (): AsyncGenerator<AudioSample> {
			await Promise.resolve()
			yield* []
		}

		expect(await decodedAudioFormat(decode, [{ start: 0, end: 1 }], { sampleRate: 44_100, channels: 1 })).toEqual({
			sampleRate: 44_100,
			channels: 1
		})
	})

	it("reads the format from the first kept range that decodes a sample", async () => {
		const asked: number[] = []
		const decode = async function* (range: TimeRange): AsyncGenerator<AudioSample> {
			await Promise.resolve()
			asked.push(range.start)

			// The track starts after the first range: nothing decodes there.
			if (range.start < 5) {
				return
			}

			yield new AudioSample({
				data: new Float32Array(1024 * 2),
				format: "f32-planar",
				numberOfChannels: 2,
				sampleRate: 48_000,
				timestamp: range.start
			})
		}
		const bounds = [
			{ start: 0, end: 1 },
			{ start: 5, end: 6 },
			{ start: 8, end: 9 }
		]

		expect(await decodedAudioFormat(decode, bounds, { sampleRate: 24_000, channels: 1 })).toEqual({
			sampleRate: 48_000,
			channels: 2
		})
		expect(asked).toEqual([0, 5])
	})

	it("starts a track that begins late with silence, encoded at output 0", async () => {
		const added: { timestamp: number; frames: number; silent: boolean }[] = []
		const output = {
			add: (sample: AudioSample) => {
				const data = new Float32Array(sample.numberOfFrames)

				sample.copyTo(data, { planeIndex: 0, format: "f32-planar" })
				added.push({ timestamp: sample.timestamp, frames: sample.numberOfFrames, silent: data.every(value => value === 0) })

				return Promise.resolve()
			}
		} as unknown as AudioSampleSource
		const sampleRate = 8000
		const decode = async function* (range: TimeRange): AsyncGenerator<AudioSample> {
			for (let at = Math.max(4, Math.floor(range.start * 8)); at < range.end * 8; at++) {
				await Promise.resolve()

				yield new AudioSample({
					data: new Float32Array(1000).fill(0.5),
					format: "f32-planar",
					numberOfChannels: 1,
					sampleRate,
					timestamp: at / 8
				})
			}
		}
		const gate = new InterleaveGate(1)

		gate.addLane("audio1")

		await transcodeAudio({
			decode,
			bounds: [{ start: 0, end: 1 }],
			audio: new RangeAudio({ sampleRate, channels: 1, gainDb: 0, speed: 1, createStretch: null }),
			sampleRate,
			output,
			gate,
			lane: "audio1",
			signal: new AbortController().signal
		})

		expect(added[0]).toEqual({ timestamp: 0, frames: 4000, silent: true })
		expect(added.slice(1).every(sample => !sample.silent)).toBe(true)
		expect(added.reduce((total, sample) => total + sample.frames, 0)).toBe(sampleRate)
	})
})
