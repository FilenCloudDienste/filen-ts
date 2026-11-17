import { describe, expect, it } from "vitest"
import { waveFormatAudio, waveFormatExtra } from "@filen/shared/videos"

// AAC LC at 48 kHz, stereo.
const ASC = [0x11, 0x90]

// A WAVEFORMATEX of `tag`, its extra bytes `extra` (cbSize their count).
function waveFormat(tag: number, extra: number[]): Uint8Array {
	const bytes = new Uint8Array(18 + extra.length)
	const view = new DataView(bytes.buffer)

	view.setUint16(0, tag, true)
	view.setUint16(2, 2, true)
	view.setUint32(4, 48_000, true)
	view.setUint16(16, extra.length, true)
	bytes.set(extra, 18)

	return bytes
}

// WAVE_FORMAT_EXTENSIBLE's own 22 bytes: valid bits, channel mask, and the sub-format GUID whose first two bytes are
// the tag.
function extensible(tag: number): number[] {
	return [16, 0, 3, 0, 0, 0, tag & 0xff, tag >> 8, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
}

describe("waveFormatExtra", () => {
	it("is the codec's configuration, past an extensible format's own block", () => {
		expect([...waveFormatExtra(waveFormat(0x00ff, ASC), 0, 20)]).toEqual(ASC)
		expect([...waveFormatExtra(waveFormat(0xfffe, [...extensible(0x00ff), ...ASC]), 0, 42)]).toEqual(ASC)
		expect(waveFormatExtra(waveFormat(0xfffe, extensible(0x00ff)), 0, 40)).toHaveLength(0)
	})

	it("holds no more than the bytes there, whatever cbSize claims", () => {
		const lying = waveFormat(0x00ff, ASC)

		new DataView(lying.buffer).setUint16(16, 4000, true)
		expect([...waveFormatExtra(lying, 0, lying.length)]).toEqual(ASC)
		expect(waveFormatExtra(new Uint8Array(16), 0, 16)).toHaveLength(0)
	})

	it("gives AAC under WAVE_FORMAT_EXTENSIBLE the AudioSpecificConfig after the block", () => {
		const format = waveFormat(0xfffe, [...extensible(0x00ff), ...ASC])

		expect(waveFormatAudio(format, 0, format.length)).toMatchObject({ codec: "aac", codecString: "mp4a.40.2" })
	})
})
