import { describe, expect, it } from "vitest"
import type { LadderDecision, MediaCodec, VideoProbe } from "@filen/shared/videos"
import {
	cannotStream,
	confirmedGap,
	initialVideoRoute,
	mseFailureKind,
	mseOpenFailureKind,
	sidecarSubtitles,
	silentAudioCodec,
	unplayableCodecs,
	unplayableContainer
} from "@/features/preview/lib/previewPlayback.logic"

function probeOf(video: MediaCodec | null, audio: MediaCodec[], container: VideoProbe["container"] = "mp4"): VideoProbe {
	return {
		v: 1,
		container,
		durationSec: 10,
		index: null,
		video:
			video === null
				? null
				: { codec: video, fourcc: "", codecString: null, w: 1, h: 1, par: 1, rotation: 0, bitDepth: 8, transfer: "sdr" },
		audio: audio.map((codec, index) => ({
			id: index,
			codec,
			codecString: null,
			ch: 2,
			rate: 48_000,
			lang: null,
			name: null,
			def: false,
			forced: false,
			commentary: false
		})),
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false
	}
}

function unsupported(...reasons: LadderDecision["reasons"]): LadderDecision {
	return { path: "unsupported", reasons, audio: { mode: "none" } }
}

describe("initialVideoRoute", () => {
	it("starts a file browsers play from a plain src on the service worker's stream", () => {
		for (const extension of ["mp4", "m4v", "mov", "webm"]) {
			expect(initialVideoRoute({ extension, contentType: "video/mp4", streamAvailable: true })).toBe("direct")
		}
	})

	it("takes Matroska and transport streams to the ladder from the start", () => {
		for (const extension of ["mkv", "ts", "m2ts", "mts"]) {
			expect(initialVideoRoute({ extension, contentType: "video/x-matroska", streamAvailable: true })).toBe("ladder")
		}
	})

	it("takes everything to the ladder without a stream or an inline content type", () => {
		expect(initialVideoRoute({ extension: "mp4", contentType: "video/mp4", streamAvailable: false })).toBe("ladder")
		expect(initialVideoRoute({ extension: "mp4", contentType: null, streamAvailable: true })).toBe("ladder")
	})
})

describe("unplayableContainer", () => {
	it("names the container when no rung reads it, whatever its tracks hold", () => {
		expect(unplayableContainer(probeOf("theora", ["vorbis"], "ogg"), unsupported("direct-not-playable", "container-unsupported"))).toBe(
			"ogg"
		)
	})

	it("names nothing when a codec, not the container, is what fails", () => {
		expect(unplayableContainer(probeOf("mpeg4", ["mp3"]), unsupported("remux-video-unsupported"))).toBeNull()
		expect(unplayableContainer(null, unsupported("container-unsupported"))).toBeNull()
		expect(unplayableContainer(probeOf("h264", []), null)).toBeNull()
	})
})

describe("unplayableCodecs", () => {
	it("names the picture's codec when the picture is what no rung plays", () => {
		expect(unplayableCodecs(probeOf("mpeg4", ["mp3"]), unsupported("remux-video-unsupported"))).toEqual(["mpeg4"])
	})

	it("names every declared codec otherwise, once each", () => {
		expect(unplayableCodecs(probeOf("hevc", ["aac", "aac", "dts"]), unsupported("container-unsupported"))).toEqual([
			"hevc",
			"aac",
			"dts"
		])
	})

	it("names nothing for a file no probe reads", () => {
		expect(unplayableCodecs(null, null)).toEqual([])
		expect(unplayableCodecs(probeOf(null, []), unsupported("no-video"))).toEqual([])
	})
})

describe("confirmedGap", () => {
	const aacOnly = (codec: MediaCodec): boolean => codec === "aac" || codec === "h264"

	it("names a track the browser cannot decode of a kind the element decoded nothing of", () => {
		expect(confirmedGap(probeOf("h264", ["ac3"]), ["audio"], aacOnly)).toBe("ac3")
		expect(confirmedGap(probeOf("hevc", ["aac"]), ["video"], aacOnly)).toBe("hevc")
	})

	it("stays quiet when the file has no such track or the browser can decode it", () => {
		expect(confirmedGap(probeOf("h264", []), ["audio"], aacOnly)).toBeNull()
		expect(confirmedGap(probeOf("h264", ["aac"]), ["audio"], aacOnly)).toBeNull()
		expect(confirmedGap(probeOf("h264", ["ac3"]), ["video"], aacOnly)).toBeNull()
	})
})

describe("silentAudioCodec", () => {
	it("names the chosen track's codec, else the first", () => {
		expect(silentAudioCodec(probeOf("h264", ["aac", "dts"]), 1)).toBe("dts")
		expect(silentAudioCodec(probeOf("h264", ["eac3"]), -1)).toBe("eac3")
	})
})

describe("sidecarSubtitles", () => {
	const files = (names: string[], size = 1000) => names.map((name, index) => ({ uuid: String(index), name, size }))

	it("matches text subtitles named after the video, reading language and flags from the tokens", () => {
		const found = sidecarSubtitles(
			"Movie.mkv",
			files(["Movie.srt", "Movie.en.forced.srt", "Movie.de.sdh.vtt", "movie.ja.ass", "Movie.mkv", "Other.srt", "Movie2.srt"]),
			8_000_000
		)

		expect(found.map(file => [file.name, file.format, file.lang, file.forced, file.sdh])).toEqual([
			["Movie.srt", "srt", null, false, false],
			["Movie.en.forced.srt", "srt", "en", true, false],
			["Movie.de.sdh.vtt", "vtt", "de", false, true],
			["movie.ja.ass", "ass", "ja", false, false]
		])
	})

	it("matches every text extension the shared table knows, .ssa and .sami included", () => {
		expect(
			sidecarSubtitles("Movie.mkv", files(["Movie.en.ssa", "Movie.sami"]), 8_000_000).map(file => [file.name, file.format, file.lang])
		).toEqual([
			["Movie.en.ssa", "ass", "en"],
			["Movie.sami", "smi", null]
		])
	})

	it("leaves out image formats, VobSub pairs, empty and oversize files", () => {
		expect(sidecarSubtitles("Movie.mp4", files(["Movie.sup", "Movie.idx", "Movie.sub"]), 100)).toEqual([])
		expect(sidecarSubtitles("Movie.mp4", files(["Movie.sub"]), 8_000_000).map(file => file.format)).toEqual(["sub"])
		expect(sidecarSubtitles("Movie.mp4", files(["Movie.srt"], 0), 100)).toEqual([])
		expect(sidecarSubtitles("Movie.mp4", files(["Movie.srt"], 101), 100)).toEqual([])
	})

	// "İ" lowercases to two code units: the tokens are still read from where the stem ends in the name itself.
	it("reads the tokens of a name whose lowercase is longer than the name", () => {
		const found = sidecarSubtitles(
			"İstanbul.2020.mkv",
			files(["İstanbul.2020.en.srt", "i̇stanbul.2020.de.forced.srt", "İSTANBUL.2020.srt", "İstanbulx.fr.srt"]),
			8_000_000
		)

		expect(found.map(file => [file.name, file.lang, file.forced])).toEqual([
			["İstanbul.2020.en.srt", "en", false],
			["i̇stanbul.2020.de.forced.srt", "de", true],
			["İSTANBUL.2020.srt", null, false]
		])
	})
})

describe("mseFailureKind / mseOpenFailureKind", () => {
	it("calls only a decode verdict a format failure; a lost source or worker may be retried", () => {
		expect(mseFailureKind("media")).toBe("format")
		expect(mseFailureKind("keyframeIntervalTooLarge")).toBe("format")
		expect(mseFailureKind("source")).toBe("other")
		expect(mseFailureKind("remux")).toBe("other")
		expect(mseFailureKind("stalled")).toBe("other")
	})

	it("calls an open that MediaSource refused a format failure, anything else retryable", () => {
		expect(mseOpenFailureKind(new DOMException("no track", "NotSupportedError"))).toBe("format")
		expect(mseOpenFailureKind(new Error("the file's byte source did not answer"))).toBe("other")
		expect(mseOpenFailureKind(new Error("worker died"))).toBe("other")
	})
})

describe("cannotStream", () => {
	it("is the browser's lack of MediaSource, never a codec verdict", () => {
		expect(cannotStream(unsupported("no-media-source"))).toBe(true)
		expect(cannotStream(unsupported("remux-video-unsupported"))).toBe(false)
		expect(cannotStream(null)).toBe(false)
	})
})
