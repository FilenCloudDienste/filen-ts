import { describe, expect, it } from "vitest"
import {
	copyRanges,
	copySpeedFits,
	codedToSquareCrop,
	displayToCoded,
	sourceFrame,
	squareToCodedCrop,
	editAbilities,
	exactRanges,
	exportBlockers,
	IOS_GOP_BYTE_CAP,
	keptAudioTracks,
	levelMaxFrameRate,
	outputGeometry,
	planExport,
	plannedRanges,
	sourceToOutputTime,
	transcodeBitrate,
	transcodeFrameRate,
	unavailableOptions,
	videoCodecId
} from "@/features/preview/videoEdit/lib/plan"
import { containerMime, inPlaceVideoContainerByName, videoSaveTargets } from "@/features/preview/videoEdit/lib/targets"
import { ALL_ENCODERS, FIREFOX_DESKTOP, NO_WEBCODECS, recipeFor, sourceInfo } from "@/tests/support/videoEditRecipe"

const KEYS = Float64Array.from([0, 2, 4, 6, 8, 10])

describe("copyRanges (shrink-only snapping)", () => {
	it("moves each start to the first key frame at or after it and leaves the end", () => {
		const { ranges, snapped } = copyRanges(
			[
				{ start: 0, end: 3 },
				{ start: 4.5, end: 7 }
			],
			KEYS,
			30
		)

		expect(ranges).toEqual([
			{ start: 0, end: 3 },
			{ start: 6, end: 7 }
		])
		expect(snapped).toEqual([{ requested: 4.5, actual: 6 }])
	})

	it("never moves a start earlier (a removed GOP never comes back)", () => {
		const { ranges } = copyRanges([{ start: 3.9, end: 9 }], KEYS, 30)

		expect(ranges[0]?.start).toBe(4)
		expect(ranges[0]?.start).toBeGreaterThanOrEqual(3.9)
	})

	it("drops a range with no key frame before its end", () => {
		const { ranges, snapped } = copyRanges(
			[
				{ start: 2.1, end: 3.9 },
				{ start: 6, end: 8 }
			],
			KEYS,
			30
		)

		expect(ranges).toEqual([{ start: 6, end: 8 }])
		expect(snapped).toEqual([{ requested: 2.1, actual: 3.9 }])
	})

	it("treats a start within half a frame of a key frame as on it", () => {
		const { ranges, snapped } = copyRanges([{ start: 1.99, end: 5 }], KEYS, 30)

		expect(ranges).toEqual([{ start: 2, end: 5 }])
		expect(snapped).toEqual([])
	})

	it("drops every range when there are no key frames", () => {
		expect(copyRanges([{ start: 0, end: 5 }], new Float64Array(), 30).ranges).toEqual([])
	})
})

describe("time mapping", () => {
	const ranges = [
		{ start: 2, end: 4 },
		{ start: 10, end: 12 }
	]

	it("maps kept source times through cuts and speed", () => {
		expect(sourceToOutputTime(ranges, 1, 3)).toBe(1)
		expect(sourceToOutputTime(ranges, 1, 11)).toBe(3)
		expect(sourceToOutputTime(ranges, 2, 11)).toBe(1.5)
	})

	it("answers null for a cut time", () => {
		expect(sourceToOutputTime(ranges, 1, 1)).toBeNull()
		expect(sourceToOutputTime(ranges, 1, 6)).toBeNull()
		expect(sourceToOutputTime(ranges, 1, 13)).toBeNull()
	})

	it("clamps exact ranges to the source", () => {
		expect(exactRanges([{ start: -1, end: 70 }], 60)).toEqual([{ start: 0, end: 60 }])
	})
})

describe("outputGeometry", () => {
	it("maps a display crop into the coded frame of a rotated source", () => {
		// A portrait phone clip: coded 1920x1080, shown rotated 90° as 1080x1920.
		const crop = { x: 100, y: 200, width: 400, height: 600 }

		expect(displayToCoded(crop, 0, 1920, 1080)).toEqual(crop)
		expect(displayToCoded(crop, 90, 1920, 1080)).toEqual({ x: 200, y: 1080 - 100 - 400, width: 600, height: 400 })
		expect(displayToCoded(crop, 180, 1920, 1080)).toEqual({ x: 1920 - 100 - 400, y: 1080 - 200 - 600, width: 400, height: 600 })
		expect(displayToCoded(crop, 270, 1920, 1080)).toEqual({ x: 1920 - 200 - 600, y: 100, width: 600, height: 400 })
	})

	it("folds the source's rotation into the metadata rotation", () => {
		const geometry = outputGeometry(recipeFor(60, { rotate: 270 }), sourceInfo({ rotation: 90, width: 1080, height: 1920 }))

		expect(geometry.rotation).toBe(0)
		expect(geometry.codedWidth).toBe(1920)
		expect(geometry.codedHeight).toBe(1080)
		expect(geometry.codedCrop).toBeNull()
		expect([geometry.width, geometry.height]).toEqual([1920, 1080])
	})

	it("scales the short side to the preset and keeps sizes even", () => {
		const geometry = outputGeometry(recipeFor(60, { output: { resolution: 720, quality: "high" } }), sourceInfo())

		expect(geometry).toMatchObject({ width: 1280, height: 720, scaled: true })

		const portrait = outputGeometry(
			recipeFor(60, { output: { resolution: 480, quality: "high" } }),
			sourceInfo({ width: 1080, height: 1920, rotation: 90 })
		)

		expect([portrait.width, portrait.height]).toEqual([480, 852])
	})

	it("never upscales", () => {
		expect(
			outputGeometry(recipeFor(60, { output: { resolution: 1080, quality: "high" } }), sourceInfo({ width: 1280, height: 720 }))
				.scaled
		).toBe(false)
	})

	it("trims an odd-sized source to even sides with a zero-copy crop", () => {
		const geometry = outputGeometry(recipeFor(60), sourceInfo({ width: 1279, height: 719, codedWidth: 1279, codedHeight: 719 }))

		expect(geometry.codedCrop).toEqual({ x: 0, y: 0, width: 1278, height: 718 })
		expect([geometry.width, geometry.height]).toEqual([1278, 718])
	})

	it("evens out an odd crop", () => {
		const geometry = outputGeometry(recipeFor(60, { crop: { x: 3, y: 5, width: 101, height: 99 } }), sourceInfo())

		expect(geometry.codedCrop).toEqual({ x: 2, y: 4, width: 100, height: 98 })
		expect(geometry.squareCrop).toEqual(geometry.codedCrop)
	})

	it("cuts the same pixels on the crop-only path and the GPU pass for an anamorphic source", () => {
		// 720x480 coded with a 32:27 pixel aspect ratio, shown 854x480.
		const source = sourceInfo({ width: 854, height: 480, codedWidth: 720, codedHeight: 480 })
		const geometry = outputGeometry(recipeFor(60, { crop: { x: 100, y: 0, width: 400, height: 480 } }), source)
		const frame = sourceFrame(source)

		expect(geometry.codedCrop).toEqual({ x: 84, y: 0, width: 336, height: 480 })
		expect(geometry.squareCrop).toEqual(codedToSquareCrop({ x: 84, y: 0, width: 336, height: 480 }, frame))
		expect(squareToCodedCrop(geometry.squareCrop ?? { x: 0, y: 0, width: 0, height: 0 }, frame)).toEqual(geometry.codedCrop)
		// The output is square-pixel: the coded width widened by the pixel aspect ratio.
		expect([geometry.width, geometry.height]).toEqual([398, 480])
	})

	it("crops nothing on a whole anamorphic frame, rotated or not", () => {
		const geometry = outputGeometry(
			recipeFor(60),
			sourceInfo({ width: 480, height: 854, rotation: 90, codedWidth: 720, codedHeight: 480 })
		)

		expect(geometry.codedCrop).toBeNull()
		expect([geometry.width, geometry.height]).toEqual([480, 854])
	})
})

describe("codec levels and speed", () => {
	it("reads H.264 and HEVC levels", () => {
		// Level 4.0: 245760 MB/s; 1080p = 8160 MBs → ~30.1 fps.
		expect(levelMaxFrameRate("avc1.640028", 1920, 1080)).toBeCloseTo(245_760 / 8160)
		// HEVC level 4.1 (123): 133693440 / (1920*1080) ≈ 64.5 fps.
		expect(levelMaxFrameRate("hvc1.1.6.L123.B0", 1920, 1080)).toBeCloseTo(133_693_440 / (1920 * 1080))
		expect(levelMaxFrameRate("vp09.00.10.08", 1920, 1080)).toBeNull()
		expect(levelMaxFrameRate(null, 1920, 1080)).toBeNull()
	})

	it("retimes by packet copy only within the level", () => {
		// 30 fps at level 5.1 1080p (983040 / 8160 ≈ 120 fps): 2× fits, 4× does not.
		const level51 = sourceInfo({ videoCodec: "avc1.640033" })

		expect(copySpeedFits(level51, 2)).toBe(true)
		expect(copySpeedFits(level51, 4)).toBe(true)
		expect(copySpeedFits(sourceInfo({ videoCodec: "avc1.640028" }), 2)).toBe(false)
		expect(copySpeedFits(sourceInfo(), 0.25)).toBe(true)
		// An unknown level allows up to 60 fps.
		expect(copySpeedFits(sourceInfo({ videoCodec: "avc" }), 2)).toBe(true)
		expect(copySpeedFits(sourceInfo({ videoCodec: "avc" }), 2.5)).toBe(false)
	})

	it("normalises codec ids", () => {
		expect(videoCodecId("hev1.1.6.L93.B0")).toBe("hevc")
		expect(videoCodecId("av01.0.04M.08")).toBe("av1")
		expect(videoCodecId("mp4v.20.9")).toBe("mp4v.20.9")
	})
})

describe("planExport modes", () => {
	const source = sourceInfo()

	it("copies an untouched or cut-only recipe", () => {
		const plan = planExport(
			recipeFor(60, {
				keep: [
					{ start: 0, end: 10 },
					{ start: 20, end: 30 }
				]
			}),
			source,
			ALL_ENCODERS,
			{ name: "clip.mp4" }
		)

		expect(plan.mode).toBe("copy")
		expect(plan.transcodeReasons).toEqual([])
		expect(plan.outputDuration).toBe(20)
		expect(plan.unavailable).toEqual([])
	})

	it("copies a rotation (metadata) and a muted or single-track audio", () => {
		expect(planExport(recipeFor(60, { rotate: 90 }), source, ALL_ENCODERS).mode).toBe("copy")
		expect(planExport(recipeFor(60, { audio: { mute: true, gainDb: 0, keepTracks: "first" } }), source, ALL_ENCODERS).mode).toBe("copy")
	})

	it.each([
		["crop", { crop: { x: 0, y: 0, width: 960, height: 540 } }],
		["flip", { flipH: true }],
		["resize", { output: { resolution: 720, quality: "high" } }],
		["quality", { output: { resolution: "original", quality: "medium" } }],
		[
			"adjust",
			{
				adjust: {
					exposure: 0.2,
					brightness: 0,
					contrast: 0,
					highlights: 0,
					shadows: 0,
					warmth: 0,
					tint: 0,
					saturation: 0,
					vibrance: 0
				}
			}
		],
		["adjust", { filter: "vivid" }],
		["text", { text: [{ id: "t", text: "hi", startSec: 0, endSec: 1, x: 0.5, y: 0.5, size: 0.1, color: "#fff", background: false }] }],
		["speed", { speed: 4 }]
	] as const)("transcodes for %s", (reason, overrides) => {
		const plan = planExport(recipeFor(60, overrides), source, ALL_ENCODERS)

		expect(plan.mode).toBe("transcode")
		expect(plan.transcodeReasons).toContain(reason)
		expect(plan.snapped).toEqual([])
	})

	it("ignores an unknown filter id", () => {
		expect(planExport(recipeFor(60, { filter: "no-such-filter" }), source, ALL_ENCODERS).mode).toBe("copy")
	})

	it("snaps on the fast path and reports it; precise re-encodes instead", () => {
		const keep = [{ start: 3, end: 10 }]
		const fast = planExport(recipeFor(60, { keep }), source, ALL_ENCODERS)

		expect(fast.mode).toBe("copy")
		expect(fast.snapped).toEqual([{ requested: 3, actual: 4 }])
		expect(fast.outputDuration).toBe(6)

		const precise = planExport(recipeFor(60, { keep, precise: true }), source, ALL_ENCODERS)

		expect(precise.mode).toBe("transcode")
		expect(precise.transcodeReasons).toEqual(["precise"])
		expect(precise.outputDuration).toBe(7)
	})

	it("precise costs nothing when every start is on a key frame", () => {
		expect(planExport(recipeFor(60, { keep: [{ start: 4, end: 9 }], precise: true }), source, ALL_ENCODERS).mode).toBe("copy")
	})

	it("re-encodes when the copy path would keep nothing", () => {
		const plan = planExport(recipeFor(60, { keep: [{ start: 2.5, end: 3.5 }] }), source, ALL_ENCODERS)

		expect(plan.mode).toBe("transcode")
		expect(plan.transcodeReasons).toContain("keyframes")
	})

	it("re-encodes a codec MP4 cannot carry", () => {
		const plan = planExport(recipeFor(60), sourceInfo({ videoCodec: "mp4v.20.9", container: "mkv" }), ALL_ENCODERS)

		expect(plan.transcodeReasons).toContain("videoCodec")
	})

	it("speeds up by retiming packets within the level, re-encoding audio", () => {
		const plan = planExport(recipeFor(60, { speed: 2 }), sourceInfo({ videoCodec: "avc1.640033" }), ALL_ENCODERS)

		expect(plan.mode).toBe("copy")
		expect(plan.outputDuration).toBe(30)
	})

	it("keeps an iOS copy whose GOPs fit and re-encodes one whose do not", () => {
		const small = planExport(recipeFor(60), source, ALL_ENCODERS, { ios: true })

		expect(small.mode).toBe("copy")

		// 2 s GOPs of a 400 Mbit/s source: 100 MB each.
		const huge = sourceInfo({ bytes: 3_000_000_000 })

		expect((huge.bytes / huge.duration) * 2).toBeGreaterThan(IOS_GOP_BYTE_CAP)
		expect(planExport(recipeFor(60), huge, ALL_ENCODERS, { ios: true }).transcodeReasons).toEqual(["gop"])
		expect(planExport(recipeFor(60), huge, ALL_ENCODERS, { ios: false }).mode).toBe("copy")
	})
})

describe("planExport capabilities", () => {
	it("disables everything but cuts, rotation and track choice up front without WebCodecs (Firefox Android)", () => {
		const identity = planExport(recipeFor(60), sourceInfo(), NO_WEBCODECS)

		expect(identity.unavailable).toEqual(["crop", "flip", "resize", "quality", "adjust", "text", "precise", "gain"])
		expect(exportBlockers(recipeFor(60), sourceInfo(), NO_WEBCODECS)).toEqual([])
		expect(unavailableOptions(sourceInfo(), ALL_ENCODERS)).toEqual([])
		expect(unavailableOptions(sourceInfo(), FIREFOX_DESKTOP)).toEqual([])
	})

	it("exports copy-path edits without WebCodecs and refuses the rest", () => {
		const blockers = (overrides: Parameters<typeof recipeFor>[1]): string[] =>
			exportBlockers(recipeFor(60, overrides), sourceInfo(), NO_WEBCODECS)

		expect(planExport(recipeFor(60, { keep: [{ start: 4, end: 20 }], rotate: 90 }), sourceInfo(), NO_WEBCODECS).mode).toBe("copy")
		expect(blockers({ keep: [{ start: 4, end: 20 }], rotate: 90 })).toEqual([])
		expect(blockers({ audio: { mute: true, gainDb: 0, keepTracks: "first" } })).toEqual([])
		expect(blockers({ crop: { x: 0, y: 0, width: 960, height: 540 } })).toEqual(["crop"])
		expect(blockers({ audio: { mute: false, gainDb: 3, keepTracks: "first" } })).toEqual(["gain"])
		expect(blockers({ keep: [{ start: 3, end: 9 }], precise: true })).toEqual(["precise"])
	})

	it("retimes a muted copy without any encoder, and offers muting when only the audio blocks", () => {
		const fast = sourceInfo({ videoCodec: "avc1.640033" })
		const sped = planExport(recipeFor(60, { speed: 2 }), fast, NO_WEBCODECS)

		expect(sped.blockers).toEqual(["speed"])
		expect(sped.mutingUnblocks).toBe(true)

		const mutedSpeed = planExport(
			recipeFor(60, { speed: 2, audio: { mute: true, gainDb: 0, keepTracks: "first" } }),
			fast,
			NO_WEBCODECS
		)

		expect(mutedSpeed.mode).toBe("copy")
		expect(mutedSpeed.blockers).toEqual([])
		expect(mutedSpeed.mutingUnblocks).toBe(false)

		// Video work stays blocked whatever happens to the sound.
		expect(planExport(recipeFor(60, { flipH: true, speed: 2 }), fast, NO_WEBCODECS).mutingUnblocks).toBe(false)
	})

	it("needs an audio encoder for audio MP4 players do not take", () => {
		const ac3 = sourceInfo({ audio: [{ number: 1, codec: "ac3", channels: 6, language: null }] })

		expect(exportBlockers(recipeFor(60), ac3, NO_WEBCODECS)).toEqual(["audioCodec"])
		expect(planExport(recipeFor(60), ac3, NO_WEBCODECS).mutingUnblocks).toBe(true)
		expect(exportBlockers(recipeFor(60), ac3, FIREFOX_DESKTOP)).toEqual([])
		expect(exportBlockers(recipeFor(60, { audio: { mute: true, gainDb: 0, keepTracks: "first" } }), ac3, NO_WEBCODECS)).toEqual([])
	})

	it("cannot transcode a source the browser cannot decode", () => {
		expect(editAbilities(sourceInfo({ previewable: false }), ALL_ENCODERS).transcode).toBe(false)
		expect(planExport(recipeFor(60), sourceInfo({ previewable: false }), ALL_ENCODERS).unavailable).toContain("flip")
		expect(exportBlockers(recipeFor(60, { flipV: true }), sourceInfo({ previewable: false }), ALL_ENCODERS)).toEqual(["flip"])
	})
})

describe("planExport HDR", () => {
	const hlg = sourceInfo({ transfer: "hlg", bitDepth: 10, videoCodec: "hvc1.2.4.L150.B0", container: "mov" })

	it("keeps HDR on the copy path", () => {
		const plan = planExport(recipeFor(60), hlg, ALL_ENCODERS)

		expect(plan.hdr).toBe("keep")
		expect(plan.dropped).toEqual([])
	})

	it("re-encodes to 10-bit HEVC where the browser can and no pixel changes", () => {
		const hdrOf = (overrides: Parameters<typeof recipeFor>[1]): string | null =>
			planExport(recipeFor(60, overrides), hlg, ALL_ENCODERS).hdr

		expect(hdrOf({ output: { resolution: 1080, quality: "medium" } })).toBe("hevc10")
		expect(hdrOf({ crop: { x: 0, y: 0, width: 960, height: 540 }, rotate: 90 })).toBe("hevc10")
		expect(hdrOf({ keep: [{ start: 3, end: 9 }], precise: true, speed: 4 })).toBe("hevc10")
		expect(planExport(recipeFor(60, { output: { resolution: 1080, quality: "medium" } }), hlg, ALL_ENCODERS).dropped).toEqual([])
	})

	it("tone-maps to SDR with a notice for any pixel edit, or without a 10-bit encoder", () => {
		for (const overrides of [
			{ flipH: true },
			{ filter: "vivid" },
			{ output: { resolution: 720, quality: "high" } },
			{ text: [{ id: "t", text: "Hi", startSec: 0, endSec: 1, x: 0.5, y: 0.5, size: 0.1, color: "#fff", background: false }] }
		] satisfies Parameters<typeof recipeFor>[1][]) {
			const plan = planExport(recipeFor(60, overrides), hlg, ALL_ENCODERS)

			expect(plan.hdr).toBe("toSdr")
			expect(plan.dropped).toContain("hdrMetadata")
			expect(plan.blockers).toEqual([])
		}

		expect(planExport(recipeFor(60, { output: { resolution: 1080, quality: "low" } }), hlg, FIREFOX_DESKTOP).hdr).toBe("toSdr")
		expect(planExport(recipeFor(60), hlg, FIREFOX_DESKTOP).unavailable).toEqual([])
		expect(exportBlockers(recipeFor(60, { filter: "vivid" }), hlg, FIREFOX_DESKTOP)).toEqual([])
	})

	it("says nothing about HDR for an SDR source", () => {
		expect(planExport(recipeFor(60, { flipH: true }), sourceInfo(), ALL_ENCODERS).hdr).toBeNull()
	})
})

describe("planExport drops", () => {
	it("lists subtitles, chapters, extra audio and location", () => {
		const source = sourceInfo({
			hasSubtitles: true,
			hasChapters: true,
			hasLocation: true,
			audio: [
				{ number: 1, codec: "aac", channels: 2, language: "eng" },
				{ number: 2, codec: "aac", channels: 2, language: "deu" }
			]
		})

		expect(planExport(recipeFor(60, { removeLocation: true }), source, ALL_ENCODERS).dropped).toEqual([
			"subtitles",
			"chapters",
			"extraAudio",
			"location"
		])
		expect(
			planExport(recipeFor(60, { audio: { mute: false, gainDb: 0, keepTracks: [1, 2] } }), source, ALL_ENCODERS).dropped
		).not.toContain("extraAudio")
		// Muting is the user's choice, not a drop.
		expect(
			planExport(recipeFor(60, { audio: { mute: true, gainDb: 0, keepTracks: "first" } }), source, ALL_ENCODERS).dropped
		).not.toContain("extraAudio")
	})

	it("keeps the tracks the recipe names", () => {
		const source = sourceInfo({
			audio: [
				{ number: 1, codec: "aac", channels: 2, language: "eng" },
				{ number: 2, codec: "aac", channels: 2, language: "deu" }
			]
		})

		expect(keptAudioTracks(recipeFor(60, { audio: { mute: false, gainDb: 0, keepTracks: [2] } }), source)).toEqual([2])
		expect(keptAudioTracks(recipeFor(60), source)).toEqual([1])
		expect(keptAudioTracks(recipeFor(60, { audio: { mute: true, gainDb: 0, keepTracks: [1, 2] } }), source)).toEqual([])
	})
})

describe("planExport containers and targets", () => {
	it.each([
		["clip.mp4", "mp4", "mp4", ["inPlace", "copy"]],
		["clip.M4V", "mp4", "mp4", ["inPlace", "copy"]],
		["clip.mov", "mov", "mov", ["inPlace", "copy"]],
		["clip.mkv", "mkv", "mp4", ["copy"]],
		["clip.webm", "webm", "mp4", ["copy"]],
		["clip.ts", "ts", "mp4", ["copy"]],
		// A name that lies about the bytes is never rewritten under it.
		["clip.mp4", "mkv", "mp4", ["copy"]]
	] as const)("%s (%s) → %s %j", (name, container, output, targets) => {
		const plan = planExport(recipeFor(60), sourceInfo({ container }), ALL_ENCODERS, { name })

		expect(plan.container).toBe(output)
		expect(plan.targets).toEqual(targets)
	})

	it("puts the copy first without versioning", () => {
		expect(planExport(recipeFor(60), sourceInfo(), ALL_ENCODERS, { name: "clip.mp4", versioning: false }).targets).toEqual([
			"copy",
			"inPlace"
		])
	})

	it("names the copy's extension and the MIME type", () => {
		expect(videoSaveTargets({ name: "clip.mkv", container: "mkv" }).copyExtension).toBe("mp4")
		expect(videoSaveTargets({ name: "clip.m4v", container: "mp4" }).copyExtension).toBe("m4v")
		expect(videoSaveTargets({ name: "clip.mov", container: "mov" }).copyExtension).toBe("mov")
		expect(containerMime("mov")).toBe("video/quicktime")
		expect(containerMime("mp4")).toBe("video/mp4")
		expect(inPlaceVideoContainerByName("noextension")).toBeNull()
	})
})

describe("planExport estimates", () => {
	it("estimates a copy from the kept share of the source", () => {
		const plan = planExport(recipeFor(60, { keep: [{ start: 0, end: 30 }] }), sourceInfo(), ALL_ENCODERS)

		expect(plan.estimateBytes).toBeGreaterThan(29_000_000)
		expect(plan.estimateBytes).toBeLessThan(31_000_000)
		expect(plan.estimateSeconds).toBeGreaterThan(0)
	})

	it("takes dropped audio off a copy", () => {
		const kept = planExport(recipeFor(60), sourceInfo(), ALL_ENCODERS).estimateBytes
		const muted = planExport(
			recipeFor(60, { audio: { mute: true, gainDb: 0, keepTracks: "first" } }),
			sourceInfo(),
			ALL_ENCODERS
		).estimateBytes

		expect(kept - muted).toBeCloseTo((160_000 * 60 * 1.01) / 8, -3)
	})

	it("estimates a transcode from the bitrate model, smaller per preset and quality", () => {
		const estimate = (resolution: 1080 | 720 | 480, quality: "high" | "medium" | "low"): number =>
			planExport(recipeFor(60, { output: { resolution, quality } }), sourceInfo({ bytes: 600_000_000 }), ALL_ENCODERS).estimateBytes

		expect(estimate(720, "high")).toBeLessThan(estimate(1080, "high"))
		expect(estimate(480, "high")).toBeLessThan(estimate(720, "high"))
		expect(estimate(1080, "low")).toBeLessThan(estimate(1080, "medium"))
		expect(estimate(1080, "medium")).toBeLessThan(estimate(1080, "high"))
	})

	it("never models more bits per pixel than the source spent", () => {
		const lowBitrateSource = sourceInfo({ bytes: 7_500_000 })
		const plan = planExport(recipeFor(60, { output: { resolution: 720, quality: "high" } }), lowBitrateSource, ALL_ENCODERS)

		expect(plan.estimateBytes).toBeLessThan(7_500_000)
	})

	it("models the bitrate per codec and caps the frame rate of a speed-up", () => {
		const avc = transcodeBitrate({
			width: 1920,
			height: 1080,
			frameRate: 30,
			quality: "high",
			codec: "avc",
			sourceVideoBitrate: null,
			sourcePixels: 0
		})
		const hevc = transcodeBitrate({
			width: 1920,
			height: 1080,
			frameRate: 30,
			quality: "high",
			codec: "hevc",
			sourceVideoBitrate: null,
			sourcePixels: 0
		})

		expect(hevc).toBeLessThan(avc)
		expect(transcodeFrameRate(sourceInfo(), 4)).toBe(30)
		expect(transcodeFrameRate(sourceInfo(), 0.5)).toBe(15)
	})

	it("halves the output of a 2× speed-up", () => {
		expect(planExport(recipeFor(60, { speed: 2 }), sourceInfo({ videoCodec: "avc1.640033" }), ALL_ENCODERS).outputDuration).toBe(30)
		expect(planExport(recipeFor(60, { speed: 0.5 }), sourceInfo(), ALL_ENCODERS).outputDuration).toBe(120)
	})

	it("plans the ranges the export cuts", () => {
		const recipe = recipeFor(60, { keep: [{ start: 3, end: 9 }] })

		expect(plannedRanges(recipe, sourceInfo(), "copy")).toEqual([{ start: 4, end: 9 }])
		expect(plannedRanges(recipe, sourceInfo(), "transcode")).toEqual([{ start: 3, end: 9 }])
	})
})
