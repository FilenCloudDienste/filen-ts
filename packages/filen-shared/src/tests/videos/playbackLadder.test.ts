import { describe, expect, it } from "vitest"
import {
	decidePlayback,
	isAudioCopyable,
	isAudioDecodable,
	ladderQueries,
	normalizeLadderContainer,
	type DecodingVerdict,
	type LadderAudio,
	type LadderProbe,
	type LadderSelection,
	type LadderVideo,
	type PlaybackCapabilities
} from "@filen/shared/videos"

const H264: LadderVideo = { codec: "h264", codecString: "avc1.640028", width: 1920, height: 1080 }
const HEVC: LadderVideo = { codec: "hevc", codecString: "hvc1.1.6.L120.90", width: 3840, height: 2160 }
const HEVC10: LadderVideo = { ...HEVC, codecString: "hvc1.2.4.L153.B0", bitDepth: 10 }
const HDR10: LadderVideo = { ...HEVC10, transfer: "pq" }
const AV1: LadderVideo = { codec: "av1", codecString: "av01.0.08M.08", width: 1920, height: 1080 }
const DV5: LadderVideo = { ...HEVC10, codecString: "dvh1.05.06", dolbyVision: { profile: 5 } }

const AAC: LadderAudio = { codec: "aac", codecString: "mp4a.40.2", channels: 2 }
const MP3: LadderAudio = { codec: "mp3", codecString: "mp4a.6B", channels: 2 }
const OPUS: LadderAudio = { codec: "opus", codecString: "opus", channels: 2 }
const AC3: LadderAudio = { codec: "ac3", codecString: "ac-3", channels: 6 }
const EAC3: LadderAudio = { codec: "eac3", codecString: "ec-3", channels: 6 }
const EAC3_STEREO: LadderAudio = { ...EAC3, channels: 2 }
const DTS: LadderAudio = { codec: "dts", codecString: "mp4a.a9", channels: 6 }
const TRUEHD: LadderAudio = { codec: "truehd", codecString: "mlpa", channels: 8 }
const FLAC: LadderAudio = { codec: "flac", codecString: "flac", channels: 2 }

const sel = (audioIndex = 0, subtitle: LadderSelection["subtitle"] = "none"): LadderSelection => ({ audioIndex, subtitle })
const probe = (container: string, video: LadderVideo | null, ...audio: LadderAudio[]): LadderProbe => ({ container, video, audio })

interface Fill {
	browser?: PlaybackCapabilities["browser"]
	mediaSource?: boolean
	audioTracks?: boolean
	// MIME -> truthy lists
	playable?: string[]
	mse?: string[]
	file?: Record<string, DecodingVerdict>
	msVerdicts?: Record<string, DecodingVerdict>
	encoders?: PlaybackCapabilities["audioEncoders"]
}

// Builds capabilities from explicit MIME lists so each rule is toggled in isolation.
function caps(fill: Fill = {}): PlaybackCapabilities {
	return {
		browser: fill.browser ?? "chrome",
		mediaSource: fill.mediaSource ?? true,
		audioTracks: fill.audioTracks ?? false,
		canPlayType: Object.fromEntries((fill.playable ?? []).map(m => [m, "probably"])),
		isTypeSupported: Object.fromEntries((fill.mse ?? []).map(m => [m, true])),
		decodingInfoFile: fill.file ?? {},
		decodingInfoMediaSource: fill.msVerdicts ?? {},
		audioEncoders: fill.encoders ?? []
	}
}

const mp4 = (v: string, a?: string) => (a === undefined ? `video/mp4; codecs="${v}"` : `video/mp4; codecs="${v},${a}"`)
const audioMp4 = (a: string) => `audio/mp4; codecs="${a}"`
const yes: DecodingVerdict = { supported: true, smooth: true }
const unsmooth: DecodingVerdict = { supported: true, smooth: false }
const no: DecodingVerdict = { supported: false }

const AAC_MSE = [audioMp4("mp4a.40.2"), audioMp4("opus")]

describe("ladderQueries", () => {
	it("lists direct, MSE and target MIMEs, with alternate spellings", () => {
		const q = ladderQueries(probe("mp4", H264, MP3), sel())

		expect(q.canPlayType).toEqual([
			mp4("avc1.640028", "mp4a.6B"),
			mp4("avc1.640028", "mp4a.69"),
			mp4("avc1.640028", "mp3"),
			mp4("avc1.640028", "mp4a.6b")
		])
		expect(q.decodingInfoFile).toEqual(q.canPlayType)
		expect(q.isTypeSupported).toContain("video/mp4; codecs=\"avc1.640028\"")
		expect(q.isTypeSupported).toContain(audioMp4("mp3"))
		expect(q.isTypeSupported).toContain(audioMp4("opus"))
		expect(q.isTypeSupported).toContain(audioMp4("mp4a.40.2"))
		expect(q.decodingInfoMediaSource).toEqual([])
	})

	it("asks decodingInfo for HEVC video and AC-3 audio on MSE, and omits direct MIMEs for MKV", () => {
		const q = ladderQueries(probe("mkv", HEVC, AC3), sel())

		expect(q.canPlayType).toEqual([])
		expect(q.decodingInfoMediaSource).toEqual([
			mp4(HEVC.codecString as string),
			audioMp4("ac-3"),
			audioMp4("mp4a.a5"),
			audioMp4("mp4a.A5")
		])
	})

	it("probes MOV as MP4, WebM as WebM, and is empty without a video codec string", () => {
		expect(ladderQueries(probe("mov", H264, AAC), sel()).canPlayType[0]).toBe(mp4("avc1.640028", "mp4a.40.2"))
		expect(ladderQueries(probe("webm", H264, OPUS), sel()).canPlayType[0]).toBe("video/webm; codecs=\"avc1.640028,opus\"")
		expect(ladderQueries(probe("mp4", null), sel())).toEqual({
			canPlayType: [],
			isTypeSupported: [],
			decodingInfoFile: [],
			decodingInfoMediaSource: []
		})
	})
})

describe("normalizeLadderContainer", () => {
	it.each([
		["Matroska", "mkv"],
		["MKV", "mkv"],
		["quicktime", "mov"],
		["mpeg-ts", "ts"],
		["M4V", "m4v"]
	])("%s -> %s", (input, out) => {
		expect(normalizeLadderContainer(input)).toBe(out)
	})
})

describe("rung A: direct", () => {
	const ok = caps({ playable: [mp4("avc1.640028", "mp4a.40.2")] })

	it("plays H.264 + AAC in MP4", () => {
		expect(decidePlayback(probe("mp4", H264, AAC), sel(), ok)).toEqual({ path: "direct", reasons: [], audio: { mode: "native" } })
	})

	it("plays a video without audio", () => {
		expect(decidePlayback(probe("mp4", H264), sel(-1), caps({ playable: ["video/mp4; codecs=\"avc1.640028\""] })).path).toBe("direct")
	})

	it("probes MOV as video/mp4 and accepts M4V", () => {
		expect(decidePlayback(probe("mov", H264, AAC), sel(), ok).path).toBe("direct")
		expect(decidePlayback(probe("m4v", H264, AAC), sel(), ok).path).toBe("direct")
	})

	it("plays WebM", () => {
		const webm = caps({ playable: ["video/webm; codecs=\"vp09.00.40.08,opus\""] })

		expect(
			decidePlayback(probe("webm", { codec: "vp9", codecString: "vp09.00.40.08", width: 1280, height: 720 }, OPUS), sel(), webm).path
		).toBe("direct")
	})

	it("never plays MKV directly, even when canPlayType says yes", () => {
		const mkvCaps = caps({
			playable: [mp4("avc1.640028", "mp4a.40.2")],
			mse: [mp4("avc1.640028"), ...AAC_MSE]
		})
		const decision = decidePlayback(probe("mkv", H264, AAC), sel(), mkvCaps)

		expect(decision.path).toBe("remux")
		expect(decision.reasons).toContain("container-not-direct")
	})

	it("needs a non-empty canPlayType", () => {
		const decision = decidePlayback(probe("mp4", H264, AAC), sel(), caps({ mse: [mp4("avc1.640028"), ...AAC_MSE] }))

		expect(decision.path).toBe("remux")
		expect(decision.reasons).toContain("direct-not-playable")
	})

	it("accepts an alternate codec spelling in canPlayType", () => {
		const alt = caps({ playable: [mp4("avc1.640028", "mp3")] })

		expect(decidePlayback(probe("mp4", H264, MP3), sel(), alt).path).toBe("direct")
	})

	it.each([
		["HEVC", HEVC, mp4("hvc1.1.6.L120.90", "mp4a.40.2")],
		["HEVC 10-bit", HEVC10, mp4("hvc1.2.4.L153.B0", "mp4a.40.2")],
		["HDR10", HDR10, mp4("hvc1.2.4.L153.B0", "mp4a.40.2")],
		["AV1", AV1, mp4("av01.0.08M.08", "mp4a.40.2")]
	])("%s requires a supported decodingInfo verdict", (_name, video, mime) => {
		const without = decidePlayback(probe("mp4", video, AAC), sel(), caps({ playable: [mime] }))
		const rejected = decidePlayback(probe("mp4", video, AAC), sel(), caps({ playable: [mime], file: { [mime]: no } }))
		const accepted = decidePlayback(probe("mp4", video, AAC), sel(), caps({ playable: [mime], file: { [mime]: yes } }))

		expect(without.path).not.toBe("direct")
		expect(without.reasons).toContain("direct-decode-unsupported")
		expect(rejected.path).not.toBe("direct")
		expect(accepted.path).toBe("direct")
	})

	it("also wants smooth playback for HEVC and AV1 but not for others", () => {
		const hevc = mp4("hvc1.1.6.L120.90", "mp4a.40.2")

		expect(decidePlayback(probe("mp4", HEVC, AAC), sel(), caps({ playable: [hevc], file: { [hevc]: unsmooth } })).path).not.toBe(
			"direct"
		)

		const hdr = mp4("hvc1.2.4.L153.B0", "mp4a.40.2")

		expect(decidePlayback(probe("mp4", HDR10, AAC), sel(), caps({ playable: [hdr], file: { [hdr]: yes } })).path).toBe("direct")
	})

	it("rejects when an optional decodingInfo says unsupported", () => {
		const mime = mp4("avc1.640028", "mp4a.40.2")

		expect(decidePlayback(probe("mp4", H264, AAC), sel(), caps({ playable: [mime], file: { [mime]: no } })).path).not.toBe("direct")
		expect(decidePlayback(probe("mp4", H264, AAC), sel(), caps({ playable: [mime], file: { [mime]: unsmooth } })).path).toBe("direct")
	})

	it("treats AC-3 and E-AC-3 as needing decodingInfo too", () => {
		const mime = mp4("avc1.640028", "ac-3")

		expect(decidePlayback(probe("mp4", H264, AC3), sel(), caps({ playable: [mime] })).path).not.toBe("direct")
		expect(decidePlayback(probe("mp4", H264, AC3), sel(), caps({ playable: [mime], file: { [mime]: yes } })).path).toBe("direct")
	})

	it("requires the chosen audio to be track 0 unless audioTracks exists", () => {
		const mime = mp4("avc1.640028", "mp4a.40.2")
		const two = probe("mp4", H264, AAC, AAC)

		const chrome = decidePlayback(two, sel(1), caps({ playable: [mime], mse: [mp4("avc1.640028"), ...AAC_MSE] }))

		expect(chrome.path).toBe("remux")
		expect(chrome.reasons).toContain("audio-track-needs-remux")
		expect(decidePlayback(two, sel(1), caps({ browser: "safari", audioTracks: true, playable: [mime] })).path).toBe("direct")
		expect(decidePlayback(two, sel(0), caps({ playable: [mime] })).path).toBe("direct")
	})

	it("allows sidecar subtitles but an embedded text subtitle forces remux", () => {
		const mime = mp4("avc1.640028", "mp4a.40.2")
		const fill = { playable: [mime], mse: [mp4("avc1.640028"), ...AAC_MSE] }

		expect(decidePlayback(probe("mp4", H264, AAC), sel(0, "sidecar"), caps(fill)).path).toBe("direct")
		expect(decidePlayback(probe("mp4", H264, AAC), sel(0, "embedded-text"), caps(fill))).toMatchObject({
			path: "remux",
			reasons: ["subtitle-needs-remux"]
		})
	})

	it("flags an image subtitle without changing the path", () => {
		const decision = decidePlayback(
			probe("mp4", H264, AAC),
			sel(0, "embedded-image"),
			caps({ playable: [mp4("avc1.640028", "mp4a.40.2")] })
		)

		expect(decision).toMatchObject({ path: "direct", reasons: ["subtitle-image-unsupported"] })
	})

	it("skips 2-channel E-AC-3 on Edge", () => {
		const mime = mp4("avc1.640028", "ec-3")
		const fill = { playable: [mime], file: { [mime]: yes } }

		expect(decidePlayback(probe("mp4", H264, EAC3_STEREO), sel(), caps({ ...fill, browser: "edge" })).reasons).toContain(
			"edge-stereo-eac3"
		)
		expect(decidePlayback(probe("mp4", H264, EAC3_STEREO), sel(), caps({ ...fill, browser: "chrome" })).path).toBe("direct")
		expect(decidePlayback(probe("mp4", H264, EAC3), sel(), caps({ ...fill, browser: "edge" })).path).toBe("direct")
	})

	it("cannot go direct with an unknown audio codec string", () => {
		const decision = decidePlayback(
			probe("mp4", H264, { codec: "weird", codecString: null, channels: 2 }),
			sel(),
			caps({ playable: [mp4("avc1.640028")] })
		)

		expect(decision.reasons).toContain("audio-codec-unknown")
		expect(decision.path).not.toBe("direct")
	})
})

describe("rung B: remux", () => {
	const base = { mse: [mp4("avc1.640028"), ...AAC_MSE] }

	it("remuxes MKV with copyable audio", () => {
		expect(decidePlayback(probe("mkv", H264, AAC), sel(), caps(base))).toMatchObject({ path: "remux", audio: { mode: "copy" } })
	})

	it("accepts the other remux input containers and rejects the rest", () => {
		for (const container of ["mp4", "mov", "webm", "ts", "matroska", "flv"]) {
			expect(decidePlayback(probe(container, H264, AAC), sel(), caps(base)).path).not.toBe("unsupported")
		}

		const avi = decidePlayback(probe("avi", H264, AAC), sel(), caps(base))

		expect(avi.path).toBe("unsupported")
		expect(avi.reasons).toContain("container-unsupported")
	})

	it("needs MediaSource", () => {
		const decision = decidePlayback(probe("mkv", H264, AAC), sel(), caps({ ...base, mediaSource: false }))

		expect(decision).toMatchObject({ path: "unsupported" })
		expect(decision.reasons).toContain("no-media-source")
	})

	it("needs the video MIME supported by MSE", () => {
		const decision = decidePlayback(probe("mkv", H264, AAC), sel(), caps({ mse: AAC_MSE }))

		expect(decision.path).toBe("unsupported")
		expect(decision.reasons).toContain("remux-video-unsupported")
	})

	it("requires MSE decodingInfo for HEVC/AV1/HDR, and accepts when it passes", () => {
		for (const video of [HEVC, HEVC10, HDR10, AV1]) {
			const v = mp4(video.codecString as string)
			const fill = { mse: [v, ...AAC_MSE] }

			expect(decidePlayback(probe("mkv", video, AAC), sel(), caps(fill)).reasons).toContain("remux-decode-unsupported")
			expect(decidePlayback(probe("mkv", video, AAC), sel(), caps({ ...fill, msVerdicts: { [v]: no } })).path).toBe("unsupported")
			expect(decidePlayback(probe("mkv", video, AAC), sel(), caps({ ...fill, msVerdicts: { [v]: unsmooth } })).path).toBe("remux")
		}
	})

	it("reports Dolby Vision profile 5 distinctly", () => {
		const v = mp4("dvh1.05.06")
		const decision = decidePlayback(probe("mkv", DV5, AAC), sel(), caps({ mse: [v, ...AAC_MSE], msVerdicts: { [v]: no } }))

		expect(decision.path).toBe("unsupported")
		expect(decision.reasons).toContain("dolby-vision-profile-5")
	})

	it("passes AC-3/E-AC-3 through only with a supported decodingInfo", () => {
		const v = mp4("avc1.640028")
		const mse = [v, audioMp4("ac-3"), audioMp4("ec-3"), ...AAC_MSE]

		expect(decidePlayback(probe("mkv", H264, AC3), sel(), caps({ mse }))).toMatchObject({ path: "video-only" })
		expect(decidePlayback(probe("mkv", H264, AC3), sel(), caps({ mse, msVerdicts: { [audioMp4("ac-3")]: no } })).audio).toEqual({
			mode: "none"
		})
		expect(decidePlayback(probe("mkv", H264, AC3), sel(), caps({ mse, msVerdicts: { [audioMp4("ac-3")]: yes } }))).toMatchObject({
			path: "remux",
			audio: { mode: "copy" }
		})
		expect(decidePlayback(probe("mkv", H264, EAC3), sel(), caps({ mse, msVerdicts: { [audioMp4("ec-3")]: yes } })).path).toBe("remux")
	})

	it("skips passthrough of 2-channel E-AC-3 on Edge", () => {
		const mse = [mp4("avc1.640028"), audioMp4("ec-3"), ...AAC_MSE]
		const msVerdicts = { [audioMp4("ec-3")]: yes }

		expect(
			decidePlayback(probe("mkv", H264, EAC3_STEREO), sel(), caps({ mse, msVerdicts, browser: "edge", encoders: ["aac"] }))
		).toMatchObject({ path: "remux+transcode" })
		expect(decidePlayback(probe("mkv", H264, EAC3_STEREO), sel(), caps({ mse, msVerdicts, browser: "chrome" })).path).toBe("remux")
		expect(decidePlayback(probe("mkv", H264, EAC3), sel(), caps({ mse, msVerdicts, browser: "edge" })).path).toBe("remux")
	})

	it("never passes Opus into fMP4 on Safari", () => {
		const fill = { mse: [mp4("avc1.640028"), audioMp4("opus"), ...AAC_MSE] }

		expect(decidePlayback(probe("mkv", H264, OPUS), sel(), caps({ ...fill, browser: "chrome" })).path).toBe("remux")

		const safari = decidePlayback(probe("mkv", H264, OPUS), sel(), caps({ ...fill, browser: "safari", encoders: ["aac"] }))

		expect(safari.path).toBe("remux+transcode")
		expect(safari.reasons).toContain("safari-opus-fmp4")
	})

	it("copies FLAC and MP3 only where MSE supports them", () => {
		const v = mp4("avc1.640028")

		expect(decidePlayback(probe("mkv", H264, FLAC), sel(), caps({ mse: [v, audioMp4("flac")] })).audio).toEqual({ mode: "copy" })
		expect(decidePlayback(probe("mkv", H264, MP3), sel(), caps({ mse: [v, audioMp4("mp4a.6B")] })).audio).toEqual({ mode: "copy" })
		expect(decidePlayback(probe("mkv", H264, MP3), sel(), caps({ mse: [v, audioMp4("mp3")] })).audio).toEqual({ mode: "copy" })
		expect(decidePlayback(probe("mkv", H264, FLAC), sel(), caps({ mse: [v] })).path).toBe("video-only")
	})

	it("remuxes video-only files and files with no audio selected", () => {
		expect(decidePlayback(probe("mkv", H264), sel(-1), caps({ mse: [mp4("avc1.640028")] }))).toMatchObject({
			path: "remux",
			audio: { mode: "none" }
		})
		expect(decidePlayback(probe("mkv", H264, AAC), sel(-1), caps({ mse: [mp4("avc1.640028")] })).path).toBe("remux")
	})

	it("remuxes a non-first audio track and embedded text subtitles", () => {
		expect(
			decidePlayback(
				probe("mp4", H264, AAC, AAC),
				sel(1),
				caps({ mse: [mp4("avc1.640028"), ...AAC_MSE], playable: [mp4("avc1.640028", "mp4a.40.2")] })
			).path
		).toBe("remux")
	})
})

describe("rung C: remux + audio transcode", () => {
	const v = mp4("avc1.640028")
	const mse = [v, audioMp4("mp4a.40.2"), audioMp4("opus")]
	const dtsPlan = (fill: Fill) => decidePlayback(probe("mkv", H264, DTS), sel(), caps({ mse, ...fill }))

	it.each([
		["safari", ["aac"], "aac"],
		["chrome", ["aac", "opus"], "aac"],
		["edge", ["aac"], "aac"],
		["firefox", ["opus"], "opus"],
		["chrome", ["opus"], "opus"],
		["safari", ["aac-wasm"], "aac-wasm"],
		["chrome", ["opus", "aac-wasm"], "opus"]
	] as const)("%s with %j encodes %s as stereo 48 kHz", (browser, encoders, target) => {
		const decision = dtsPlan({ browser, encoders })

		expect(decision.path).toBe("remux+transcode")
		expect(decision.audio).toMatchObject({ mode: "transcode", target, channels: 2, sampleRate: 48000 })
	})

	it("never targets Opus on Safari, even if the encoder exists", () => {
		const decision = dtsPlan({ browser: "safari", encoders: ["opus"] })

		expect(decision.path).toBe("video-only")
		expect(decision.reasons).toContain("no-audio-encoder")
	})

	it("needs the target's fMP4 MIME to be supported", () => {
		const none = decidePlayback(probe("mkv", H264, DTS), sel(), caps({ mse: [v], encoders: ["aac"] }))

		expect(none.path).toBe("video-only")
	})

	it("transcodes AC-3 / E-AC-3 / DTS but not TrueHD or unknown codecs", () => {
		expect(decidePlayback(probe("mkv", H264, AC3), sel(), caps({ mse, encoders: ["aac"] })).path).toBe("remux+transcode")
		expect(decidePlayback(probe("mkv", H264, EAC3), sel(), caps({ mse, encoders: ["aac"] })).path).toBe("remux+transcode")

		const truehd = decidePlayback(probe("mkv", H264, TRUEHD), sel(), caps({ mse, encoders: ["aac"] }))

		expect(truehd.path).toBe("video-only")
		expect(truehd.reasons).toContain("audio-not-transcodable")
	})

	it("transcodes FLAC (never to FLAC) when not copyable", () => {
		const decision = decidePlayback(probe("mkv", H264, FLAC), sel(), caps({ mse, encoders: ["aac", "opus"] }))

		expect(decision.audio).toMatchObject({ mode: "transcode", target: "aac", codecString: "mp4a.40.2" })
	})

	it("honours a custom decoder list", () => {
		const custom = { ...caps({ mse, encoders: ["aac"] }), audioDecoders: ["aac"] }

		expect(decidePlayback(probe("mkv", H264, FLAC), sel(), custom).path).toBe("video-only")
		expect(decidePlayback(probe("mkv", H264, DTS), sel(), custom).path).toBe("remux+transcode")
	})
})

describe("rung 3 and 4", () => {
	it("is video-only when audio cannot be handled", () => {
		const decision = decidePlayback(probe("mkv", H264, TRUEHD), sel(), caps({ mse: [mp4("avc1.640028")] }))

		expect(decision).toMatchObject({ path: "video-only", audio: { mode: "none" } })
	})

	it("is unsupported without a usable video", () => {
		expect(decidePlayback(probe("mp4", null, AAC), sel(), caps())).toMatchObject({ path: "unsupported", reasons: ["no-video"] })
		expect(decidePlayback(probe("mp4", { ...H264, codecString: null }, AAC), sel(), caps())).toMatchObject({
			path: "unsupported",
			reasons: ["video-codec-unknown"]
		})
	})

	it("is unsupported for codecs no engine decodes (MPEG-2, VC-1, ProRes style probes)", () => {
		for (const [codec, codecString] of [
			["mpeg2", "mp4v.61"],
			["vc1", "vc-1"],
			["prores", "apcn"]
		] as const) {
			const video: LadderVideo = { codec, codecString, width: 1920, height: 1080 }

			expect(decidePlayback(probe("mkv", video, AAC), sel(), caps({ mse: AAC_MSE })).path).toBe("unsupported")
		}
	})
})

describe("isAudioCopyable", () => {
	it("is false for unknown strings and codecs the engine refuses", () => {
		expect(isAudioCopyable({ codec: "x", codecString: null, channels: 2 }, caps())).toBe(false)
		expect(isAudioCopyable(AAC, caps({ mse: [audioMp4("mp4a.40.2")] }))).toBe(true)
		expect(isAudioCopyable(AAC, caps())).toBe(false)
		expect(isAudioCopyable(OPUS, caps({ mse: [audioMp4("opus")], browser: "safari" }))).toBe(false)
	})
})

describe("audio codec vocabulary", () => {
	// Every audio codec name the container probe can emit, and whether a transcode decoder exists.
	const PROBE_AUDIO_CODECS: Record<string, boolean> = {
		aac: true,
		mp3: true,
		ac3: true,
		eac3: true,
		dts: true,
		truehd: false,
		opus: true,
		vorbis: true,
		flac: true,
		alac: false
	}

	it.each(Object.entries(PROBE_AUDIO_CODECS))("classifies probe codec %s (decodable: %s)", (codec, decodable) => {
		expect(isAudioDecodable(codec)).toBe(decodable)

		const decision = decidePlayback(
			probe("mkv", H264, { codec, codecString: null, channels: 2 }),
			sel(),
			caps({ mse: [mp4("avc1.640028"), ...AAC_MSE], encoders: ["aac"] })
		)

		expect(decision.path).toBe(decodable ? "remux+transcode" : "video-only")
	})

	it.each([
		"pcm-s16",
		"pcm-s24",
		"pcm-s32",
		"pcm-f32",
		"pcm-f64",
		"pcm-u8",
		"pcm-s8",
		"pcm-s16be",
		"pcm-s24be",
		"pcm-s32be",
		"pcm-f32be",
		"pcm-f64be",
		"ulaw",
		"alaw"
	])("transcodes %s instead of dropping audio", codec => {
		expect(isAudioDecodable(codec)).toBe(true)

		const decision = decidePlayback(
			probe("mkv", H264, { codec, codecString: null, channels: 2 }),
			sel(),
			caps({ mse: [mp4("avc1.640028"), ...AAC_MSE], encoders: ["aac"] })
		)

		expect(decision.path).toBe("remux+transcode")
	})

	it("rejects unknown names", () => {
		expect(isAudioDecodable("wmav2")).toBe(false)
		expect(isAudioDecodable("pcmx")).toBe(false)
	})
})
