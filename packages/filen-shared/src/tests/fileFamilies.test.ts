import { describe, expect, it } from "vitest"
import { AUDIO_FORMATS, SUBTITLE_FILE_EXTENSIONS, TRACKER_COLLISIONS, ZIP_PACKAGE_EXTENSIONS } from "@filen/shared"
import { subtitleFormat } from "@filen/shared/videos"

// The tracker rows, which filen-web's tests keep equal to what its libopenmpt build reads.
const TRACKERS = [...AUDIO_FORMATS].filter(([, format]) => format.synth === "module").map(([extension]) => extension)

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
			"dts",
			"wma",
			"mp2",
			"mpa",
			"mid",
			"midi",
			"kar",
			"rmi",
			...TRACKERS
		])
	})

	it("marks only the formats no browser plays as they are as decoded", () => {
		const decoded = [...AUDIO_FORMATS].filter(([, format]) => format.decoded === true).map(([extension]) => extension)

		expect(decoded).toEqual(["mka", "ac3", "eac3", "ec3", "dts", "wma", "mp2", "mpa"])
	})

	it("renders MIDI and tracker modules with a synthesizer, under their caps, and decodes the rest", () => {
		for (const [extension, format] of AUDIO_FORMATS) {
			if (format.synth === undefined) {
				expect(format.cap, extension).toBeUndefined()
			} else {
				expect(format.cap, extension).toBe(format.synth === "midi" ? 4n * 1024n * 1024n : 32n * 1024n * 1024n)
			}
		}

		expect([...AUDIO_FORMATS].filter(([, format]) => format.synth === "midi").map(([extension]) => extension)).toEqual([
			"mid",
			"midi",
			"kar",
			"rmi"
		])
		expect(TRACKERS.some(extension => TRACKER_COLLISIONS.has(extension))).toBe(false)
		expect(TRACKERS).toContain("mod")
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

describe("ZIP_PACKAGE_EXTENSIONS", () => {
	it("lists the zip-based packages, none of them a format the apps read otherwise", () => {
		expect([...ZIP_PACKAGE_EXTENSIONS]).toEqual([
			"apk",
			"aab",
			"aar",
			"ipa",
			"jar",
			"war",
			"ear",
			"xpi",
			"crx",
			"whl",
			"nupkg",
			"vsix",
			"appx",
			"msix"
		])
	})
})
