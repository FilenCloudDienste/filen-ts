import { describe, expect, it } from "vitest"
import {
	crc8,
	edgeWindowBytes,
	flacFrameHeaderLength,
	flacMetadataBlock,
	flacStreamInfo,
	flacVirtualHeader,
	isFlacMagic,
	isStreamInfoBlock,
	syncFlacFrame,
	syncFrameStream,
	TAIL_PADDING,
	tailWindowOffset
} from "@/workers/remux/tailWindow.logic"
import { adtsFrame, flacFrameHeader, MP3_FRAME_BYTES, MP3_HEADER, mp3Frame, RATE, streamInfo } from "@/tests/support/edgeAudio"

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
	const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)))
	const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of arrays) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

function repeat(frame: () => Uint8Array, count: number): Uint8Array {
	return concat(...Array.from({ length: count }, frame))
}

const STEREO_44K = { sampleRate: RATE, channels: 2 }

describe("tailWindowOffset", () => {
	it("cuts the window from the average byte rate, padded", () => {
		// 10 000 bytes a second behind a 1000-byte head.
		const params = { size: 1_001_000, audioStart: 1000, duration: 100 }

		expect(tailWindowOffset({ ...params, seconds: 20 })).toBe(1_001_000 - Math.ceil(20 * 10_000 * TAIL_PADDING))
		expect(tailWindowOffset({ ...params, seconds: 1 })).toBe(1_001_000 - 11_000)
	})

	it("never starts before the audio", () => {
		expect(tailWindowOffset({ size: 50_000, audioStart: 2000, duration: 10, seconds: 20 })).toBe(2000)
	})
})

describe("edgeWindowBytes", () => {
	it("adds the head and the padded tail by the average byte rate, never past the audio", () => {
		expect(edgeWindowBytes({ size: 1_000_000, audioStart: 0, duration: 100, headSeconds: 10, tailSeconds: 20 })).toBe(320_000)
		expect(edgeWindowBytes({ size: 100_000, audioStart: 0, duration: 10, headSeconds: 10, tailSeconds: 20 })).toBe(100_000)
	})
})

describe("syncFrameStream", () => {
	it("finds the first MPEG frame the next frames confirm, past a cut mid-frame", () => {
		const bytes = repeat(() => mp3Frame(6), 6)

		expect(syncFrameStream(bytes, 0, "mp3", null, true)).toEqual({ at: 0, shape: expect.any(Number) as number })
		expect(syncFrameStream(bytes, 500, "mp3", null, true)?.at).toBe(MP3_FRAME_BYTES)
	})

	it("rejects a lone sync word or a header nothing follows at its declared length", () => {
		const fake = new Uint8Array(300).fill(7)

		fake.set(MP3_HEADER, 20)
		fake.set(MP3_HEADER, 150)

		const bytes = concat(
			fake,
			repeat(() => mp3Frame(6), 4)
		)

		expect(syncFrameStream(bytes, 0, "mp3", null, true)?.at).toBe(300)
	})

	it("rejects a valid chain of another stream's frames when the stream's shape is known", () => {
		const head = repeat(() => mp3Frame(6), 2)
		const shape = syncFrameStream(head, 0, "mp3", null, true)?.shape ?? -1
		// 48 kHz frames: a different rate bit in the header.
		const other = (): Uint8Array => {
			const frame = new Uint8Array(960).fill(7)

			frame.set([0xff, 0xfb, 0xe4, 0x00])

			return frame
		}
		const bytes = concat(
			repeat(other, 4),
			repeat(() => mp3Frame(6), 4)
		)

		expect(syncFrameStream(bytes, 0, "mp3", null, false)?.at).toBe(0)
		expect(syncFrameStream(bytes, 0, "mp3", shape, false)?.at).toBe(4 * 960)
	})

	it("accepts a chain the end of the file cuts short only at the end of the file", () => {
		const bytes = concat(new Uint8Array(10).fill(7), mp3Frame(6))

		expect(syncFrameStream(bytes, 0, "mp3", null, true)?.at).toBe(10)
		expect(syncFrameStream(bytes, 0, "mp3", null, false)).toBeNull()
	})

	it("syncs ADTS the same way", () => {
		const fake = new Uint8Array(100).fill(9)

		fake.set([0xff, 0xf1, 0x50, 0x80, 0x20, 0x1f, 0xfc], 30)

		const bytes = concat(
			fake,
			repeat(() => adtsFrame(6), 5)
		)

		expect(syncFrameStream(bytes, 0, "adts", null, false)?.at).toBe(100)
		expect(syncFrameStream(bytes, 0, "mp3", null, false)).toBeNull()
	})
})

describe("FLAC frame headers", () => {
	it("computes FLAC's CRC-8", () => {
		expect(crc8(new TextEncoder().encode("123456789"), 0, 9)).toBe(0xf4)
	})

	it("accepts a header whose fields match the stream and whose CRC-8 checks", () => {
		expect(flacFrameHeaderLength(flacFrameHeader(5), 0, STEREO_44K)).toBe(6)
		expect(flacFrameHeaderLength(flacFrameHeader(1000), 0, STEREO_44K)).toBe(7)
		expect(flacFrameHeaderLength(flacFrameHeader(40_000), 0, STEREO_44K)).toBe(8)
	})

	it("rejects a bad CRC, another rate or channel count, reserved codes and a cut-off header", () => {
		const bad = flacFrameHeader(5)

		bad[5] = (bad[5] ?? 0) ^ 0x01

		expect(flacFrameHeaderLength(bad, 0, STEREO_44K)).toBeNull()
		// 48 kHz (code 10) in a 44.1 kHz stream.
		expect(flacFrameHeaderLength(flacFrameHeader(5, { rateCode: 10 }), 0, STEREO_44K)).toBeNull()
		// Mono (channel code 0) in a stereo stream.
		expect(flacFrameHeaderLength(flacFrameHeader(5, { layout: 0x08 }), 0, STEREO_44K)).toBeNull()
		// Reserved sample size code 3, and the reserved bit set.
		expect(flacFrameHeaderLength(flacFrameHeader(5, { layout: 0x16 }), 0, STEREO_44K)).toBeNull()
		expect(flacFrameHeaderLength(flacFrameHeader(5, { layout: 0x19 }), 0, STEREO_44K)).toBeNull()
		// Rate code 15 is invalid.
		expect(flacFrameHeaderLength(flacFrameHeader(5, { rateCode: 15 }), 0, STEREO_44K)).toBeNull()
		expect(flacFrameHeaderLength(flacFrameHeader(5).subarray(0, 5), 0, STEREO_44K)).toBeNull()
	})

	it("reads a rate code naming STREAMINFO's rate", () => {
		expect(flacFrameHeaderLength(flacFrameHeader(5, { rateCode: 0 }), 0, STEREO_44K)).toBe(6)
	})

	it("syncs past a false sync word to the first real header", () => {
		const noise = new Uint8Array(64).fill(3)

		noise.set([0xff, 0xf8, 0xc9, 0x18, 0x05, 0x00], 10)

		const bytes = concat(noise, flacFrameHeader(77), new Uint8Array(100).fill(3))

		expect(syncFlacFrame(bytes, 0, STEREO_44K)).toBe(64)
		expect(syncFlacFrame(noise, 0, STEREO_44K)).toBeNull()
	})
})

describe("FLAC metadata", () => {
	it("reads a block header and STREAMINFO's rate and channels", () => {
		expect(flacMetadataBlock(Uint8Array.from([0x00, 0, 0, 34]))).toEqual({ last: false, type: 0, size: 34 })
		expect(flacMetadataBlock(Uint8Array.from([0x86, 0x01, 0x02, 0x03]))).toEqual({ last: true, type: 6, size: 0x010203 })
		expect(flacMetadataBlock(Uint8Array.from([0x00, 0]))).toBeNull()
		expect(isStreamInfoBlock({ last: false, type: 0, size: 34 })).toBe(true)
		expect(isStreamInfoBlock({ last: false, type: 0, size: 20 })).toBe(false)
		expect(flacStreamInfo(streamInfo(1000))).toEqual({ sampleRate: RATE, channels: 2 })
		expect(flacStreamInfo(new Uint8Array(34))).toBeNull()
	})

	it("builds the virtual header: the magic and STREAMINFO alone, flagged as the last block", () => {
		const info = streamInfo(123_456)
		const header = flacVirtualHeader(info)

		expect(header.length).toBe(42)
		expect(isFlacMagic(header)).toBe(true)
		expect(flacMetadataBlock(header.subarray(4, 8))).toEqual({ last: true, type: 0, size: 34 })
		expect(header.subarray(8)).toEqual(info)
	})
})
