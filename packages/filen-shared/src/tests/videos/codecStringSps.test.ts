import { describe, expect, it } from "vitest"
import {
	avcConfigCodecString,
	avcReorderFrames,
	hevcConfigCodecString,
	parseAvcSps,
	parseHevcSps,
	unescapeRbsp,
	videoReorderFrames
} from "@filen/shared/videos"

// SPS NAL units cut from x264/x265 output; expectations are ffprobe's reading of the same streams.

function fromHex(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length / 2)

	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
	}

	return bytes
}

const AVC_HIGH_720P = fromHex("6764001facd9405005bb011000000300100000030300f1831960")
const AVC_MAIN_1080P_PQ_SAR = fromHex("674d4028eca03c0113f2e1cd4244025000000300100000030320f1831960")
const AVC_INTERLACED_576 = fromHex("67640016acd940b424d808800000030100000300190f8a14cb")
const HEVC_MAIN10_720P = fromHex("42010102200000030090000003000003005da00280802d136595952930bc05a02000000300200000030301")
const HEVC_MAIN_720P = fromHex("42010101600000030090000003000003005da00280802d16595952930bc05a020000030002000003003010")
const HEVC_MAIN10_1080P_HLG_SAR = fromHex("420101022000000300900000030000030078a003c08010e4d96566924caf056a12241208000003000800000300c840")

describe("unescapeRbsp", () => {
	it("drops the 03 after two zero bytes only", () => {
		expect([...unescapeRbsp(fromHex("0000030100000300000003"))]).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
		expect([...unescapeRbsp(fromHex("00030003"))]).toEqual([0, 3, 0, 3])
	})
})

describe("parseAvcSps", () => {
	it("reads the codec string fields, size, bit depth and VUI", () => {
		const high = parseAvcSps(AVC_HIGH_720P)

		expect(high).toMatchObject({ width: 1280, height: 720, bitDepth: 8, par: 1 })
		expect(high === null ? null : avcConfigCodecString("avc1", high)).toBe("avc1.64001f")

		const main = parseAvcSps(AVC_MAIN_1080P_PQ_SAR)

		expect(main).toMatchObject({ width: 1920, height: 1080, bitDepth: 8, par: 1.3333, transfer: 16 })
		expect(main === null ? null : avcConfigCodecString("avc1", main)).toBe("avc1.4d4028")
	})

	it("doubles the height of field-coded pictures", () => {
		expect(parseAvcSps(AVC_INTERLACED_576)).toMatchObject({ width: 720, height: 576 })
	})

	it("refuses other NAL units and truncated ones", () => {
		expect(parseAvcSps(fromHex("68ee3cb0"))).toBeNull()
		expect(parseAvcSps(AVC_HIGH_720P.subarray(0, 6))).toBeNull()
		expect(parseAvcSps(new Uint8Array())).toBeNull()
	})
})

// An AVC SPS NAL unit built bit by bit, emulation prevention applied.
function avcSps(
	write: (bits: { u: (value: number, count: number) => void; ue: (value: number) => void; se: (value: number) => void }) => void
): Uint8Array {
	const out: number[] = []
	const u = (value: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) {
			out.push((value >> i) & 1)
		}
	}
	const ue = (value: number) => {
		const length = Math.floor(Math.log2(value + 1))

		u(0, length)
		u(value + 1, length + 1)
	}
	const se = (value: number) => {
		ue(value > 0 ? 2 * value - 1 : -2 * value)
	}

	write({ u, ue, se })
	u(1, 1)

	while (out.length % 8 !== 0) {
		out.push(0)
	}

	const escaped = [0x67]
	let zeros = 0

	for (let at = 0; at < out.length; at += 8) {
		const byte = out.slice(at, at + 8).reduce((value, bit) => value * 2 + bit, 0)

		if (zeros >= 2 && byte <= 3) {
			escaped.push(3)
			zeros = 0
		}

		escaped.push(byte)
		zeros = byte === 0 ? zeros + 1 : 0
	}

	return Uint8Array.from(escaped)
}

// High 4:4:4 Predictive, 1280x720, a scaling matrix whose every list is present (each falls back to its default).
function avc444Sps(params: { chromaFormat: number; separatePlanes: boolean; lists: number }): Uint8Array {
	return avcSps(({ u, ue, se }) => {
		u(244, 8)
		u(0, 8)
		u(31, 8)
		ue(0)
		ue(params.chromaFormat)

		if (params.chromaFormat === 3) {
			u(params.separatePlanes ? 1 : 0, 1)
		}

		ue(0)
		ue(0)
		u(0, 1)
		u(1, 1)

		for (let i = 0; i < params.lists; i++) {
			u(1, 1)
			se(-8)
		}

		ue(0)
		ue(2)
		ue(1)
		u(0, 1)
		ue(79)
		ue(44)
		u(1, 1)
		u(1, 1)
		u(0, 1)
		u(0, 1)
	})
}

describe("parseAvcSps scaling matrix", () => {
	it("skips twelve lists for 4:4:4, with or without separate colour planes", () => {
		expect(parseAvcSps(avc444Sps({ chromaFormat: 3, separatePlanes: false, lists: 12 }))).toMatchObject({ width: 1280, height: 720 })
		expect(parseAvcSps(avc444Sps({ chromaFormat: 3, separatePlanes: true, lists: 12 }))).toMatchObject({ width: 1280, height: 720 })
	})

	it("skips eight lists otherwise", () => {
		expect(parseAvcSps(avc444Sps({ chromaFormat: 1, separatePlanes: false, lists: 8 }))).toMatchObject({ width: 1280, height: 720 })
		expect(parseAvcSps(avc444Sps({ chromaFormat: 2, separatePlanes: false, lists: 8 }))).toMatchObject({ width: 1280, height: 720 })
	})
})

describe("parseHevcSps", () => {
	it("builds the same string as the hvcC of the same stream", () => {
		const main10 = parseHevcSps(HEVC_MAIN10_720P)

		expect(main10).toMatchObject({ width: 1280, height: 720, bitDepth: 10, par: 1 })
		expect(main10 === null ? null : hevcConfigCodecString("hvc1", main10)).toBe("hvc1.2.4.L93.90")

		const main = parseHevcSps(HEVC_MAIN_720P)

		expect(main).toMatchObject({ width: 1280, height: 720, bitDepth: 8 })
		expect(main === null ? null : hevcConfigCodecString("hvc1", main)).toBe("hvc1.1.6.L93.90")
	})

	it("walks the reference picture sets to the VUI", () => {
		const hlg = parseHevcSps(HEVC_MAIN10_1080P_HLG_SAR)

		expect(hlg).toMatchObject({ width: 1920, height: 1080, bitDepth: 10, par: 1.2121, transfer: 18 })
		expect(hlg === null ? null : hevcConfigCodecString("hvc1", hlg)).toBe("hvc1.2.4.L120.90")
	})

	it("refuses other NAL units and truncated ones", () => {
		expect(parseHevcSps(fromHex("4401c172b46240"))).toBeNull()
		expect(parseHevcSps(HEVC_MAIN10_720P.subarray(0, 18))).toBeNull()
	})

	it("never throws on any prefix or bit flip", () => {
		for (const nal of [HEVC_MAIN10_1080P_HLG_SAR, AVC_MAIN_1080P_PQ_SAR]) {
			for (let length = 0; length <= nal.length; length++) {
				expect(() => parseHevcSps(nal.subarray(0, length))).not.toThrow()
				expect(() => parseAvcSps(nal.subarray(0, length))).not.toThrow()
			}

			for (let bit = 0; bit < nal.length * 8; bit++) {
				const flipped = nal.slice()

				flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (0x80 >> (bit & 7))

				expect(() => parseHevcSps(flipped)).not.toThrow()
				expect(() => parseAvcSps(flipped)).not.toThrow()
			}
		}
	})
})

// A 1280x720 progressive SPS with no VUI: `profile`, `compatibility` (constraint flags) and `level` as given.
function plainAvcSps(profile: number, compatibility: number, level: number, widthMbs = 80, heightMbs = 45): Uint8Array {
	return avcSps(({ u, ue }) => {
		u(profile, 8)
		u(compatibility, 8)
		u(level, 8)
		ue(0)
		ue(0)
		ue(2)
		ue(1)
		u(0, 1)
		ue(widthMbs - 1)
		ue(heightMbs - 1)
		u(1, 1)
		u(1, 1)
		u(0, 1)
		u(0, 1)
	})
}

describe("reorder frames", () => {
	it("reads x264's and x265's bounds from the SPS", () => {
		expect(parseAvcSps(AVC_HIGH_720P)?.reorderFrames).toBe(2)
		expect(parseAvcSps(AVC_MAIN_1080P_PQ_SAR)?.reorderFrames).toBe(2)
		expect(parseHevcSps(HEVC_MAIN10_720P)?.reorderFrames).toBe(2)
		expect(parseHevcSps(HEVC_MAIN10_1080P_HLG_SAR)?.reorderFrames).toBe(2)
	})

	it("infers the level's DPB size without a VUI, and 0 for an intra profile", () => {
		// Level 3.1: 18000 macroblocks over 80x45 is 5 frames.
		expect(parseAvcSps(plainAvcSps(77, 0, 31))?.reorderFrames).toBe(5)
		// Capped at 16: level 5.1 at 1280x720.
		expect(parseAvcSps(plainAvcSps(77, 0, 51))?.reorderFrames).toBe(16)
		// Level 1b (11 with constraint_set3 in Main): 396 macroblocks over QCIF's 99.
		expect(parseAvcSps(plainAvcSps(77, 0x10, 11, 11, 9))?.reorderFrames).toBe(4)
		// High with constraint_set3: High Intra.
		expect(
			avcReorderFrames({
				profile: 100,
				compatibility: 0x10,
				level: 31,
				widthMbs: 80,
				frameHeightMbs: 45,
				vui: { maxNumReorderFrames: null, maxDecFrameBuffering: null }
			})
		).toBe(0)
		expect(parseAvcSps(plainAvcSps(77, 0, 7))?.reorderFrames).toBeNull()
	})

	it("falls back from max_num_reorder_frames to max_dec_frame_buffering", () => {
		const base = { profile: 100, compatibility: 0, level: 31, widthMbs: 80, frameHeightMbs: 45 }

		expect(avcReorderFrames({ ...base, vui: { maxNumReorderFrames: 1, maxDecFrameBuffering: 4 } })).toBe(1)
		expect(avcReorderFrames({ ...base, vui: { maxNumReorderFrames: null, maxDecFrameBuffering: 4 } })).toBe(4)
	})

	it("finds the SPS in an avcC, an hvcC or an Annex B picture", () => {
		const avcC = Uint8Array.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, AVC_HIGH_720P.length, ...AVC_HIGH_720P, 0])
		const vps = fromHex("40010c01ffff")
		const hvcC = Uint8Array.from([
			1,
			...new Array<number>(21).fill(0),
			2,
			0x20,
			0,
			1,
			0,
			vps.length,
			...vps,
			0x21,
			0,
			1,
			0,
			HEVC_MAIN_720P.length,
			...HEVC_MAIN_720P
		])

		expect(videoReorderFrames("avc", avcC, null)).toBe(2)
		expect(videoReorderFrames("hevc", hvcC, null)).toBe(2)
		expect(videoReorderFrames("avc", null, Uint8Array.from([0, 0, 0, 1, ...AVC_HIGH_720P, 0, 0, 1, 0x65, 0x88]))).toBe(2)
		expect(videoReorderFrames("hevc", null, Uint8Array.from([0, 0, 1, ...HEVC_MAIN_720P]))).toBe(2)
		expect(videoReorderFrames("avc", null, null)).toBeNull()
		expect(videoReorderFrames("vp9", avcC, null)).toBeNull()
	})
})
