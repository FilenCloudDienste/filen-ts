import { describe, expect, it } from "vitest"
import {
	copyCodecString,
	isCopyableAudio,
	isFfmpegReaderAudio,
	isTranscodableAudio,
	outputVideoCodecString
} from "@/workers/remux/codecs.logic"

describe("outputVideoCodecString", () => {
	it("names HEVC by the hvc1 sample entry the muxer writes, with or without a configuration record", () => {
		expect(outputVideoCodecString("hevc", { codec: "hev1.1.6.L93.B0" })).toBe("hvc1.1.6.L93.B0")
		expect(outputVideoCodecString("hevc", { codec: "hvc1.2.4.L120.90" })).toBe("hvc1.2.4.L120.90")
	})

	it("leaves other codecs as the decoder config says", () => {
		expect(outputVideoCodecString("avc", { codec: "avc1.64001f" })).toBe("avc1.64001f")
		expect(outputVideoCodecString("vp9", { codec: "vp09.00.31.08" })).toBe("vp09.00.31.08")
	})
})

describe("copyCodecString", () => {
	it("carries the page's spelling of the codec into the copy's MIME, and nothing that is not the codec", () => {
		expect(copyCodecString("mp3", "mp4a.6B")).toBe("mp4a.6B")
		expect(copyCodecString("mp3", "mp4a.69")).toBe("mp4a.69")
		expect(copyCodecString("mp3", null)).toBe("mp3")
		expect(copyCodecString("mp3", "mp4a.40.2")).toBe("mp3")
		expect(copyCodecString("mp4a.40.2", "mp4a.40.2")).toBe("mp4a.40.2")
	})
})

describe("audio codec paths", () => {
	it("copies only codecs fragmented MP4 can carry", () => {
		for (const codec of ["aac", "opus", "mp3", "flac", "ac3", "eac3"] as const) {
			expect(isCopyableAudio(codec)).toBe(true)
		}

		for (const codec of ["vorbis", "dts", "pcm-s16", "pcm-f32", "ulaw", "alaw"] as const) {
			expect(isCopyableAudio(codec)).toBe(false)
		}

		expect(isCopyableAudio(null)).toBe(false)
	})

	it("re-encodes PCM and Vorbis as well as the copyable codecs", () => {
		for (const codec of [
			"pcm-s16",
			"pcm-s16be",
			"pcm-s24",
			"pcm-s32",
			"pcm-f32",
			"pcm-f64",
			"pcm-u8",
			"pcm-s8",
			"ulaw",
			"alaw",
			"vorbis",
			"dts",
			"mp3",
			"opus"
		] as const) {
			expect(isTranscodableAudio(codec)).toBe(true)
		}

		expect(isTranscodableAudio(null)).toBe(false)
	})

	// mediabunny names TrueHD since 1.64 but decodes it only through a registered decoder, one packet per
	// message; FFmpeg's own reader batches its tiny access units, so TrueHD keeps going there.
	it("sends unknown codecs and TrueHD to FFmpeg's own reader", () => {
		expect(isFfmpegReaderAudio(null)).toBe(true)
		expect(isFfmpegReaderAudio("truehd")).toBe(true)
		expect(isTranscodableAudio("truehd")).toBe(false)

		for (const codec of ["aac", "ac3", "eac3", "dts", "flac", "opus"] as const) {
			expect(isFfmpegReaderAudio(codec)).toBe(false)
		}
	})
})
