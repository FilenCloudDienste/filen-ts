import { describe, expect, it, vi } from "vitest"
import { BufferTarget } from "mediabunny"
import {
	outputGeometry,
	planExport,
	transcodeBitrate,
	transcodeFrameRate,
	transcodeVideoBitrate,
	transcodeVideoCodec
} from "@/features/preview/videoEdit/lib/plan"
import { runExport } from "@/features/preview/videoEdit/worker/engine"
import { ALL_ENCODERS, recipeFor } from "@/tests/support/videoEditRecipe"
import { openInput, sourceFixture, sourceInfoOf } from "@/tests/support/videoEditFixtures"

// The export encodes the video at the bitrate the plan estimated with: the encoder's settings are caught where the
// engine builds its video source (no encoder exists here), and the run stops there.

const caught = vi.hoisted(() => ({ bitrates: [] as number[] }))

class StopHere extends Error {}

vi.mock("mediabunny", async importOriginal => {
	const actual = await importOriginal<typeof import("mediabunny")>()

	// The real Quality, its bitrate noted; a video source that stops the run where the engine builds it.
	class RecordingQuality extends actual.Quality {
		public constructor(init: { bitrate: number }) {
			super(init.bitrate)
			caught.bitrates.push(init.bitrate)
		}
	}

	const StoppingVideoSource = vi.fn(function stop(): never {
		throw new StopHere()
	})

	return { ...actual, Quality: RecordingQuality, VideoSampleSource: StoppingVideoSource }
})

describe("transcode bitrate", () => {
	it("hands the encoder the plan's bitrate for a low-bitrate source with several audio tracks", async () => {
		const bytes = await sourceFixture({ seconds: 6, gop: 48, bframes: false, audio: true })
		// 1.2 Mbit/s for the whole file, three audio tracks: little of it is the video's.
		const info = await sourceInfoOf(bytes, {
			width: 1920,
			height: 1080,
			codedWidth: 1920,
			codedHeight: 1080,
			bytes: 900_000,
			audio: [1, 2, 3].map(number => ({ number, codec: "aac", channels: 2, language: null }))
		})
		const recipe = recipeFor(info.duration, { output: { resolution: "original", quality: "medium" } })
		const plan = planExport(recipe, info, ALL_ENCODERS)

		expect(plan.mode).toBe("transcode")
		caught.bitrates = []

		await expect(
			runExport({
				input: openInput(bytes),
				info,
				recipe,
				caps: ALL_ENCODERS,
				context: {},
				target: new BufferTarget(),
				signal: new AbortController().signal,
				fallbackCreationTime: null,
				deps: {
					createPipeline: () => {
						throw new Error("no pixel pass for a quality change")
					},
					createTimeStretch: () => {
						throw new Error("no stretch")
					},
					ios: false
				}
			})
		).rejects.toBeInstanceOf(StopHere)

		const codec = transcodeVideoCodec(ALL_ENCODERS, plan.hdr) ?? "avc"
		const frameRate = transcodeFrameRate(info, recipe.speed)
		const planned = transcodeVideoBitrate(recipe, info, outputGeometry(recipe, info), codec, frameRate)
		const wholeFile = transcodeBitrate({
			width: 1920,
			height: 1080,
			frameRate,
			quality: "medium",
			codec,
			sourceVideoBitrate: (info.bytes * 8) / info.duration,
			sourcePixels: 1920 * 1080
		})

		expect(caught.bitrates).toEqual([planned])
		// The whole file's bitrate (audio included) would have encoded the video larger than the estimate.
		expect(wholeFile).toBeGreaterThan(planned)
	})
})
