import { describe, expect, it } from "vitest"
import {
	decidePlayback,
	ladderQueries,
	type AudioTarget,
	type LadderBrowser,
	type LadderSelection,
	type PlaybackCapabilities,
	type MediaCodec,
	type ProbeContainer,
	type VideoProbe
} from "@filen/shared/videos"
import {
	decideWithDemotions,
	demote,
	demotionSignature,
	pathWideKey,
	splitMime,
	toLadderProbe,
	type LearnedDemotion
} from "@/lib/media/playback/capabilities.logic"
import { samePipeline, sessionPlan } from "@/lib/media/playback/openPlayback.logic"

// A fake browser: which codec strings each surface takes. Capabilities are built by answering the ladder's
// own queries, as the real probe does.
interface FakeBrowser {
	browser: LadderBrowser
	direct: string[]
	mse: string[]
	// Codecs whose decodingInfo answers supported (everything else answers unsupported).
	decode: string[]
	encoders: AudioTarget[]
}

const CHROME: FakeBrowser = {
	browser: "chrome",
	direct: ["avc1", "mp4a.40", "opus", "vp09", "av01", "hvc1"],
	mse: ["avc1", "mp4a.40", "opus", "vp09", "av01", "hvc1", "flac", "ac-3"],
	decode: ["avc1", "mp4a.40", "opus", "vp09", "av01", "hvc1"],
	encoders: ["aac", "opus"]
}
const FIREFOX: FakeBrowser = { ...CHROME, browser: "firefox", encoders: ["opus"] }
const SAFARI: FakeBrowser = {
	browser: "safari",
	direct: ["avc1", "mp4a.40", "hvc1", "ac-3"],
	mse: ["avc1", "mp4a.40", "hvc1", "ac-3", "flac"],
	decode: ["avc1", "mp4a.40", "hvc1", "ac-3"],
	encoders: ["aac", "opus"]
}

function takes(list: readonly string[], mime: string): boolean {
	const { codecs } = splitMime(mime)

	return codecs.length > 0 && codecs.every(codec => list.some(prefix => codec === prefix || codec.startsWith(`${prefix}.`)))
}

function capsFor(fake: FakeBrowser, probe: VideoProbe, selection: LadderSelection): PlaybackCapabilities {
	const queries = ladderQueries(toLadderProbe(probe), selection)
	const verdict = (mime: string) => ({ supported: takes(fake.decode, mime), smooth: true })

	return {
		browser: fake.browser,
		mediaSource: true,
		audioTracks: fake.browser === "safari",
		canPlayType: Object.fromEntries(queries.canPlayType.map(mime => [mime, takes(fake.direct, mime) ? "probably" : ""])),
		isTypeSupported: Object.fromEntries(queries.isTypeSupported.map(mime => [mime, takes(fake.mse, mime)])),
		decodingInfoFile: Object.fromEntries(queries.decodingInfoFile.map(mime => [mime, verdict(mime)])),
		decodingInfoMediaSource: Object.fromEntries(queries.decodingInfoMediaSource.map(mime => [mime, verdict(mime)])),
		audioEncoders: fake.encoders
	}
}

const VIDEO: Record<string, { codec: MediaCodec; codecString: string }> = {
	h264: { codec: "h264", codecString: "avc1.64001f" },
	hevc: { codec: "hevc", codecString: "hvc1.1.6.L93.B0" },
	vp9: { codec: "vp9", codecString: "vp09.00.10.08" },
	mpeg4: { codec: "mpeg4", codecString: "mp4v.20.9" }
}
const AUDIO: Record<string, { codec: MediaCodec; codecString: string }> = {
	aac: { codec: "aac", codecString: "mp4a.40.2" },
	ac3: { codec: "ac3", codecString: "ac-3" },
	opus: { codec: "opus", codecString: "opus" },
	truehd: { codec: "truehd", codecString: "mlpa" }
}

function file(container: ProbeContainer, video: string, ...audio: string[]): VideoProbe {
	const v = VIDEO[video]

	if (v === undefined) {
		throw new Error(video)
	}

	return {
		v: 1,
		container,
		durationSec: 60,
		index: container === "mp4" ? "moov" : "cues",
		video: { ...v, fourcc: v.codecString.slice(0, 4), w: 1280, h: 720, par: 1, rotation: 0, bitDepth: 8, transfer: "sdr" },
		audio: audio.map((name, index) => {
			const a = AUDIO[name]

			if (a === undefined) {
				throw new Error(name)
			}

			return { id: index + 2, ...a, ch: 2, rate: 48_000, lang: null, name: null, def: index === 0, forced: false, commentary: false }
		}),
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false
	}
}

const FIRST: LadderSelection = { audioIndex: 0, subtitle: "none" }
const SECOND: LadderSelection = { audioIndex: 1, subtitle: "none" }

function plan(fake: FakeBrowser, probe: VideoProbe, selection: LadderSelection = FIRST) {
	const decision = decidePlayback(toLadderProbe(probe), selection, capsFor(fake, probe, selection))

	return sessionPlan({ decision, probe, selection, browser: fake.browser })
}

describe("ladder decision -> session", () => {
	it.each([
		["chrome", CHROME, file("mp4", "h264", "aac"), FIRST, { kind: "direct", contentType: "video/mp4", audioIndex: 0 }],
		["chrome", CHROME, file("mov", "h264", "aac"), FIRST, { kind: "direct", contentType: "video/mp4", audioIndex: 0 }],
		[
			"chrome",
			CHROME,
			file("mkv", "h264", "aac"),
			FIRST,
			{ kind: "remux", path: "remux", audio: { index: 0, trackId: 1, mode: "copy" }, idrOnlyStart: false }
		],
		[
			"chrome",
			CHROME,
			file("mkv", "h264", "ac3"),
			FIRST,
			{ kind: "remux", path: "remux+transcode", audio: { index: 0, trackId: 1, mode: "transcode" }, idrOnlyStart: false }
		],
		[
			"safari",
			SAFARI,
			file("mkv", "h264", "ac3"),
			FIRST,
			{ kind: "remux", path: "remux", audio: { index: 0, trackId: 1, mode: "copy" }, idrOnlyStart: false }
		],
		[
			"firefox",
			FIREFOX,
			file("mkv", "hevc", "aac"),
			FIRST,
			{ kind: "remux", path: "remux", audio: { index: 0, trackId: 1, mode: "copy" }, idrOnlyStart: true }
		],
		[
			"chrome",
			CHROME,
			file("mkv", "hevc", "aac"),
			FIRST,
			{ kind: "remux", path: "remux", audio: { index: 0, trackId: 1, mode: "copy" }, idrOnlyStart: false }
		],
		[
			"safari",
			SAFARI,
			file("webm", "h264", "opus"),
			FIRST,
			{ kind: "remux", path: "remux+transcode", audio: { index: 0, trackId: 1, mode: "transcode" }, idrOnlyStart: false }
		],
		["chrome", CHROME, file("mkv", "h264", "truehd"), FIRST, { kind: "remux", path: "video-only", audio: null, idrOnlyStart: false }],
		[
			"chrome",
			CHROME,
			file("mp4", "h264", "aac", "aac"),
			SECOND,
			{ kind: "remux", path: "remux", audio: { index: 1, trackId: 2, mode: "copy" }, idrOnlyStart: false }
		],
		["safari", SAFARI, file("mp4", "h264", "aac", "aac"), SECOND, { kind: "direct", contentType: "video/mp4", audioIndex: 1 }],
		["chrome", CHROME, file("mp4", "mpeg4", "aac"), FIRST, { kind: "none" }]
	])("%s: %#", (_name, fake, probe, selection, expected) => {
		expect(plan(fake, probe, selection)).toEqual(expected)
	})

	it("switches audio in place only within one pipeline", () => {
		const direct = plan(CHROME, file("mp4", "h264", "aac", "aac"))
		const remuxCopy = plan(CHROME, file("mp4", "h264", "aac", "aac"), SECOND)
		const remuxTranscode = plan(CHROME, file("mkv", "h264", "ac3"))

		expect(samePipeline(direct, remuxCopy)).toBe(false)
		expect(samePipeline(remuxCopy, remuxTranscode)).toBe(true)
		expect(samePipeline({ kind: "none" }, { kind: "none" })).toBe(false)
	})
})

describe("runtime demotion", () => {
	function chain(fake: FakeBrowser, probe: VideoProbe, triggers: Parameters<typeof demote>[0]["trigger"][]): string[] {
		const ladderProbe = toLadderProbe(probe)
		let caps = capsFor(fake, probe, FIRST)
		let decision = decidePlayback(ladderProbe, FIRST, caps)
		const path = [`${decision.path}/${decision.audio.mode}`]

		for (const trigger of triggers) {
			const next = demote({ caps, probe: ladderProbe, selection: FIRST, decision, trigger })

			if (next === null) {
				path.push("none")

				break
			}

			caps = next.caps
			decision = next.decision
			path.push(`${decision.path}/${decision.audio.mode}`)
		}

		return path
	}

	it("walks the ladder down one rung per failure", () => {
		expect(chain(CHROME, file("mp4", "h264", "aac"), ["media-error", "silent-audio", "silent-audio", "decode-stall"])).toEqual([
			"direct/native",
			"remux/copy",
			// AAC copy failed: AAC re-encoding is the same codec, so Opus it is.
			"remux+transcode/transcode",
			"video-only/none",
			"unsupported/none"
		])
	})

	it("gives up the video, not the audio, when the trigger points at the picture", () => {
		expect(chain(SAFARI, file("mkv", "h264", "ac3"), ["no-first-frame"])).toEqual(["remux/copy", "unsupported/none"])
		expect(chain(CHROME, file("mkv", "h264", "ac3"), ["no-first-frame", "media-error"])).toEqual([
			"remux+transcode/transcode",
			"unsupported/none",
			"none"
		])
	})

	it("re-encodes copied audio first when the failure could be either stream", () => {
		expect(chain(SAFARI, file("mkv", "h264", "ac3"), ["media-error"])).toEqual(["remux/copy", "remux+transcode/transcode"])
	})

	it("applies remembered demotions before the first rung is tried", () => {
		const probe = file("mp4", "h264", "ac3")
		const ladderProbe = toLadderProbe(probe)
		const caps = capsFor(SAFARI, probe, FIRST)
		const directSig = demotionSignature({ path: "direct", probe: ladderProbe, selection: FIRST })
		const remuxSig = demotionSignature({ path: "remux", probe: ladderProbe, selection: FIRST })
		const learned = (...records: [string, LearnedDemotion["reason"]][]) =>
			new Map(records.map(([sig, reason]) => [sig, { sig, reason, at: 0 }]))

		expect(decidePlayback(ladderProbe, FIRST, caps).path).toBe("direct")
		expect(
			decideWithDemotions({ probe: ladderProbe, selection: FIRST, caps, learned: learned([directSig, "media-error"]) }).decision.path
		).toBe("remux")

		const both = decideWithDemotions({
			probe: ladderProbe,
			selection: FIRST,
			caps,
			learned: learned([directSig, "media-error"], [remuxSig, "silent-audio"])
		})

		expect(both.decision.path).toBe("remux+transcode")
		expect(both.demoted).toEqual([directSig, remuxSig])
		// A demotion learned for other codecs changes nothing.
		expect(
			decideWithDemotions({
				probe: ladderProbe,
				selection: FIRST,
				caps,
				learned: learned(["direct|mp4|avc1.640028|ac-3", "media-error"])
			}).decision.path
		).toBe("direct")
	})

	it("signs a demotion with the rung and the codecs it failed with", () => {
		const ladderProbe = toLadderProbe(file("mkv", "hevc", "aac", "ac3"))

		expect(demotionSignature({ path: "remux", probe: ladderProbe, selection: SECOND })).toBe("remux|mkv|hvc1.1.6.L93.B0|ac-3")
		expect(demotionSignature({ path: "video-only", probe: ladderProbe, selection: SECOND })).toBe("video-only|mkv|hvc1.1.6.L93.B0|-")
	})

	it("takes a whole rung away by its rung-wide key, whatever the audio", () => {
		const probe = file("mp4", "h264", "aac", "ac3")
		const ladderProbe = toLadderProbe(probe)
		const caps = capsFor(SAFARI, probe, SECOND)

		expect(decidePlayback(ladderProbe, SECOND, caps).path).toBe("direct")
		expect(
			decideWithDemotions({
				probe: ladderProbe,
				selection: SECOND,
				caps,
				learned: new Map([[pathWideKey("direct"), { reason: "media-error" }]])
			}).decision.path
		).toBe("remux")
	})
})
