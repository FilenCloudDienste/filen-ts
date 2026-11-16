import { describe, expect, it } from "vitest"
import { AUDIO_FORMATS, SUBTITLE_FILE_EXTENSIONS } from "@filen/shared"
import { subtitleFormat } from "@filen/shared/videos"

describe("AUDIO_FORMATS", () => {
	it("lists every audio extension the apps play", () => {
		expect([...AUDIO_FORMATS.keys()]).toEqual([
			"mp3",
			"m4a",
			"m4b",
			"aac",
			"wav",
			"ogg",
			"oga",
			"weba",
			"flac",
			"opus",
			"aiff",
			"aif",
			"caf",
			"mka",
			"ac3",
			"eac3",
			"ec3",
			"dts"
		])
	})

	it("marks only the formats no browser plays as they are as decoded", () => {
		const decoded = [...AUDIO_FORMATS].filter(([, format]) => format.decoded === true).map(([extension]) => extension)

		expect(decoded).toEqual(["mka", "ac3", "eac3", "ec3", "dts"])
	})

	it("has no synthesized formats and no format caps yet", () => {
		for (const format of AUDIO_FORMATS.values()) {
			expect(format.synth).toBeUndefined()
			expect(format.cap).toBeUndefined()
		}
	})
})

describe("SUBTITLE_FILE_EXTENSIONS", () => {
	it("lists the text subtitle formats the video sidecars read", () => {
		expect([...SUBTITLE_FILE_EXTENSIONS]).toEqual(["srt", "vtt", "ass", "ssa", "smi", "sami"])

		for (const extension of SUBTITLE_FILE_EXTENSIONS) {
			expect(subtitleFormat(extension, false), extension).not.toBeNull()
		}
	})
})
