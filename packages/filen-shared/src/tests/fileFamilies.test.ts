import { describe, expect, it } from "vitest"
import { AUDIO_FORMATS } from "@filen/shared"

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
