import { describe, expect, it } from "vitest"
import {
	linearGainFor,
	NO_TRACK_GAIN,
	parseGainDb,
	parsePeak,
	parseReplayGain,
	replayGainFor,
	UNTAGGED_GAIN_DB,
	type TrackGain
} from "@filen/shared"

function db(linear: number): number {
	return 20 * Math.log10(linear)
}

function gain(partial: Partial<TrackGain>): TrackGain {
	return { ...NO_TRACK_GAIN, ...partial }
}

describe("parseGainDb", () => {
	it("reads dB with or without a space, any case, a unitless value and a Unicode minus", () => {
		expect(parseGainDb("+3.2 dB")).toBe(3.2)
		expect(parseGainDb("+3.2dB")).toBe(3.2)
		expect(parseGainDb("-7.1")).toBe(-7.1)
		expect(parseGainDb("−7.1 DB")).toBe(-7.1)
		expect(parseGainDb("  -0.5 db ")).toBe(-0.5)
		expect(parseGainDb(".5")).toBe(0.5)
	})

	it("rejects garbage and gains past ±30 dB", () => {
		expect(parseGainDb("loud")).toBeNull()
		expect(parseGainDb("3.2 dB extra")).toBeNull()
		expect(parseGainDb("")).toBeNull()
		expect(parseGainDb("dB")).toBeNull()
		expect(parseGainDb("+31 dB")).toBeNull()
		expect(parseGainDb("-30")).toBe(-30)
	})
})

describe("parsePeak", () => {
	it("accepts a linear peak in (0, 10]", () => {
		expect(parsePeak("0.988")).toBe(0.988)
		expect(parsePeak("10")).toBe(10)
		expect(parsePeak("1.2 ")).toBe(1.2)
	})

	it("rejects zero, negatives, values past 10 and garbage", () => {
		expect(parsePeak("0")).toBeNull()
		expect(parsePeak("-0.5")).toBeNull()
		expect(parsePeak("10.5")).toBeNull()
		expect(parsePeak("peak")).toBeNull()
		expect(parsePeak("0.9abc")).toBeNull()
		expect(parsePeak("")).toBeNull()
	})
})

describe("parseReplayGain", () => {
	it("reads ID3v2 TXXX frames whatever the description's case", () => {
		expect(
			parseReplayGain({
				"ID3v2.4": [
					{ id: "TXXX:replaygain_track_gain", value: "-7.10 dB" },
					{ id: "TXXX:REPLAYGAIN_TRACK_PEAK", value: "0.988" },
					{ id: "TXXX:ReplayGain_Album_Gain", value: "-6.5dB" },
					{ id: "TXXX:replaygain_album_peak", value: "1.02" }
				]
			})
		).toEqual({ trackDb: -7.1, trackPeak: 0.988, albumDb: -6.5, albumPeak: 1.02 })
	})

	it("reads Vorbis comments, APEv2 items and MP4 freeform atoms", () => {
		expect(parseReplayGain({ vorbis: [{ id: "REPLAYGAIN_TRACK_GAIN", value: "+1.5 dB" }] }).trackDb).toBe(1.5)
		expect(parseReplayGain({ APEv2: [{ id: "Replaygain_Album_Gain", value: "-3 dB" }] }).albumDb).toBe(-3)
		expect(
			parseReplayGain({
				iTunes: [
					{ id: "----:com.apple.iTunes:replaygain_track_gain", value: "-8.2 dB" },
					{ id: "----:com.apple.iTunes:replaygain_track_peak", value: "0.7" }
				]
			})
		).toEqual(gain({ trackDb: -8.2, trackPeak: 0.7 }))
	})

	it("converts Opus R128 gains (Q7.8 relative to -23 LUFS) to the ReplayGain reference", () => {
		// -1280 / 256 = -5 dB against -23 LUFS: 0 dB against ReplayGain's.
		expect(parseReplayGain({ vorbis: [{ id: "R128_TRACK_GAIN", value: "-1280" }] }).trackDb).toBe(0)
		expect(parseReplayGain({ vorbis: [{ id: "R128_ALBUM_GAIN", value: "-2560" }] }).albumDb).toBe(-5)
		expect(parseReplayGain({ vorbis: [{ id: "R128_TRACK_GAIN", value: "-1.5" }] }).trackDb).toBeNull()
	})

	it("prefers a ReplayGain gain over an R128 one, whichever comes first", () => {
		expect(
			parseReplayGain({
				vorbis: [
					{ id: "R128_TRACK_GAIN", value: "0" },
					{ id: "REPLAYGAIN_TRACK_GAIN", value: "-9 dB" }
				]
			}).trackDb
		).toBe(-9)
	})

	it("keeps the first valid value of a field and skips unreadable ones", () => {
		expect(
			parseReplayGain({
				"ID3v2.3": [{ id: "TXXX:REPLAYGAIN_TRACK_GAIN", value: "garbage" }],
				APEv2: [{ id: "REPLAYGAIN_TRACK_GAIN", value: "-4 dB" }],
				vorbis: [{ id: "REPLAYGAIN_TRACK_GAIN", value: "-1 dB" }]
			}).trackDb
		).toBe(-4)
	})

	it("reads a value list, NUL padding and nothing at all", () => {
		expect(parseReplayGain({ vorbis: [{ id: "REPLAYGAIN_TRACK_GAIN", value: ["-2 dB\u0000"] }] }).trackDb).toBe(-2)
		expect(parseReplayGain({ vorbis: [{ id: "REPLAYGAIN_TRACK_GAIN", value: 3 }] }).trackDb).toBeNull()
		expect(parseReplayGain(undefined)).toEqual(NO_TRACK_GAIN)
		expect(parseReplayGain(null)).toEqual(NO_TRACK_GAIN)
		expect(parseReplayGain({ vorbis: undefined })).toEqual(NO_TRACK_GAIN)
	})
})

describe("linearGainFor", () => {
	it("applies the track gain, falling back to the album gain", () => {
		expect(db(linearGainFor(gain({ trackDb: -8, albumDb: -5 }), { album: false }))).toBeCloseTo(-8)
		expect(db(linearGainFor(gain({ albumDb: -5 }), { album: false }))).toBeCloseTo(-5)
	})

	it("prefers the album gain for an album run, falling back to the track gain", () => {
		expect(db(linearGainFor(gain({ trackDb: -8, albumDb: -5 }), { album: true }))).toBeCloseTo(-5)
		expect(db(linearGainFor(gain({ trackDb: -8 }), { album: true }))).toBeCloseTo(-8)
	})

	it("plays an untagged track at the fixed untagged level", () => {
		expect(db(linearGainFor(NO_TRACK_GAIN, { album: false }))).toBeCloseTo(UNTAGGED_GAIN_DB)
		expect(db(linearGainFor(null, { album: false }))).toBeCloseTo(-6)
		expect(db(linearGainFor(undefined, { album: true }))).toBeCloseTo(-6)
	})

	it("never boosts past the known peak", () => {
		// +6 dB would be 2×; the peak allows 1 / 0.8 = 1.25×.
		expect(linearGainFor(gain({ trackDb: 6, trackPeak: 0.8 }), { album: false })).toBeCloseTo(1.25)
		// A cut is never limited by the peak.
		expect(db(linearGainFor(gain({ trackDb: -6, trackPeak: 0.8 }), { album: false }))).toBeCloseTo(-6)
	})

	it("never boosts without a peak", () => {
		expect(linearGainFor(gain({ trackDb: 6 }), { album: false })).toBe(1)
	})

	it("clamps the applied gain to [-24, +12] dB", () => {
		expect(db(linearGainFor(gain({ trackDb: -30 }), { album: false }))).toBeCloseTo(-24)
		expect(db(linearGainFor(gain({ trackDb: 20, trackPeak: 0.01 }), { album: false }))).toBeCloseTo(12)
	})

	it("uses the other gain's peak when the chosen gain has none", () => {
		expect(linearGainFor(gain({ trackDb: 6, albumPeak: 0.5 }), { album: false })).toBeCloseTo(1.995, 2)
		expect(linearGainFor(gain({ trackDb: 12, albumPeak: 0.5 }), { album: false })).toBeCloseTo(2)
	})
})

describe("replayGainFor", () => {
	it("reports the peak of the gain it chose, for the overlap's headroom", () => {
		expect(replayGainFor(gain({ trackDb: -3, trackPeak: 0.9, albumDb: -5, albumPeak: 0.99 }), { album: false }).peak).toBe(0.9)
		expect(replayGainFor(gain({ trackDb: -3, trackPeak: 0.9, albumDb: -5, albumPeak: 0.99 }), { album: true }).peak).toBe(0.99)
	})

	it("reports no peak for an untagged track", () => {
		expect(replayGainFor(NO_TRACK_GAIN, { album: false })).toEqual({ linear: 10 ** (UNTAGGED_GAIN_DB / 20), peak: null })
	})
})
